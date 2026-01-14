import json
import logging
from typing import Any, Dict, Optional, Tuple

import httpx

from lct_python_backend.services.llm_config import get_env_llm_defaults

logger = logging.getLogger("lct_backend")

_CLIENT_CACHE: Dict[Tuple[str, float, bool], "LocalLLMClient"] = {}


def extract_json_from_text(text: str) -> Any:
    if text is None:
        raise ValueError("LLM response text is empty")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    if "```" in text:
        for fence in ("```json", "```"):
            if fence in text:
                snippet = text.split(fence, 1)[1]
                if "```" in snippet:
                    candidate = snippet.split("```", 1)[0].strip()
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        continue

    first_obj = text.find("{")
    first_arr = text.find("[")
    if first_obj == -1 and first_arr == -1:
        raise json.JSONDecodeError("No JSON object found", text, 0)

    if first_obj == -1:
        start = first_arr
    elif first_arr == -1:
        start = first_obj
    else:
        start = min(first_obj, first_arr)

    end_obj = text.rfind("}")
    end_arr = text.rfind("]")
    end = max(end_obj, end_arr)
    if end == -1 or end <= start:
        raise json.JSONDecodeError("Incomplete JSON response", text, start)

    candidate = text[start:end + 1].strip()
    return json.loads(candidate)


def get_local_client(config: Optional[Dict[str, Any]] = None) -> "LocalLLMClient":
    resolved = config or get_env_llm_defaults()
    base_url = str(resolved.get("base_url", "")).rstrip("/")
    timeout = float(resolved.get("timeout_seconds", 120))
    json_mode = bool(resolved.get("json_mode", True))

    key = (base_url, timeout, json_mode)
    if key not in _CLIENT_CACHE:
        _CLIENT_CACHE[key] = LocalLLMClient(base_url, timeout_seconds=timeout, json_mode=json_mode)
    return _CLIENT_CACHE[key]


class LocalLLMClient:
    def __init__(self, base_url: str, timeout_seconds: float = 120, json_mode: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.json_mode = json_mode

    async def chat(
        self,
        model: str,
        messages: list,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if response_format:
            payload["response_format"] = response_format
        elif self.json_mode:
            payload["response_format"] = {"type": "json_object"}

        url = f"{self.base_url}/v1/chat/completions"
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            try:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as exc:
                if "response_format" in payload:
                    logger.warning(
                        "Local LLM response_format rejected (%s); retrying without response_format.",
                        exc.response.text,
                    )
                    payload.pop("response_format", None)
                    retry = await client.post(url, json=payload)
                    retry.raise_for_status()
                    return retry.json()
                raise

    async def embeddings(
        self,
        model: str,
        input_data: Any,
        encoding_format: str = "float",
    ) -> Dict[str, Any]:
        payload = {
            "model": model,
            "input": input_data,
            "encoding_format": encoding_format,
        }
        url = f"{self.base_url}/v1/embeddings"
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.json()


async def local_chat_json(
    config: Dict[str, Any],
    messages: list,
    temperature: float = 0.3,
    max_tokens: int = 4000,
    response_format: Optional[Dict[str, Any]] = None,
) -> Any:
    client = get_local_client(config)
    response = await client.chat(
        model=config.get("chat_model", "glm-4.6v-flash"),
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        response_format=response_format,
    )
    content = response["choices"][0]["message"]["content"]
    return extract_json_from_text(content)

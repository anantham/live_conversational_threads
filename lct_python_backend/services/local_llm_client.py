import json
import logging
import os
import re
from typing import Any, Dict, Optional, Tuple

import httpx

from lct_python_backend.services.llm_config import get_env_llm_defaults

logger = logging.getLogger("lct_backend")

_CLIENT_CACHE: Dict[Tuple[str, float, bool], "LocalLLMClient"] = {}
_JSON_OBJECT_UNSUPPORTED_BASE_URLS: set[str] = set()
TRACE_API_CALLS = os.getenv("TRACE_API_CALLS", "true").strip().lower() in {"1", "true", "yes", "on"}
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))


def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...<truncated {len(text) - limit} chars>"


def extract_json_from_text(text: str) -> Any:
    if text is None:
        raise ValueError("LLM response text is empty")

    # Strip chain-of-thought style wrappers commonly emitted by local models.
    normalized = re.sub(r"<think>.*?</think>", "", str(text), flags=re.IGNORECASE | re.DOTALL).strip()
    if not normalized:
        raise json.JSONDecodeError("No JSON object found", str(text), 0)

    try:
        return json.loads(normalized)
    except json.JSONDecodeError:
        pass

    if "```" in normalized:
        for fence in ("```json", "```"):
            if fence in normalized:
                snippet = normalized.split(fence, 1)[1]
                if "```" in snippet:
                    candidate = snippet.split("```", 1)[0].strip()
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        continue

    # Robust fallback: decode the first valid JSON value from any object/array start.
    decoder = json.JSONDecoder()
    for index, char in enumerate(normalized):
        if char not in "{[":
            continue
        try:
            decoded, _ = decoder.raw_decode(normalized[index:])
            return decoded
        except json.JSONDecodeError:
            continue

    raise json.JSONDecodeError("No JSON object found", normalized, 0)


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

        supports_json_object = self.base_url not in _JSON_OBJECT_UNSUPPORTED_BASE_URLS
        if response_format:
            payload["response_format"] = response_format
        elif self.json_mode and supports_json_object:
            payload["response_format"] = {"type": "json_object"}

        url = f"{self.base_url}/v1/chat/completions"
        if TRACE_API_CALLS:
            logger.info(
                "[LLM API] POST %s model=%s messages=%s json_mode=%s",
                url,
                model,
                len(messages or []),
                payload.get("response_format", {}).get("type", "none"),
            )
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            try:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                if TRACE_API_CALLS:
                    logger.info(
                        "[LLM API] %s status=%s preview=%s",
                        url,
                        response.status_code,
                        _preview_text(response.text),
                    )
                return response.json()
            except httpx.HTTPStatusError as exc:
                if "response_format" in payload:
                    logger.warning(
                        "Local LLM response_format rejected (%s); retrying without response_format.",
                        _preview_text(exc.response.text),
                    )
                    _JSON_OBJECT_UNSUPPORTED_BASE_URLS.add(self.base_url)
                    payload.pop("response_format", None)
                    retry = await client.post(url, json=payload)
                    retry.raise_for_status()
                    if TRACE_API_CALLS:
                        logger.info(
                            "[LLM API] %s retry_status=%s preview=%s",
                            url,
                            retry.status_code,
                            _preview_text(retry.text),
                        )
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

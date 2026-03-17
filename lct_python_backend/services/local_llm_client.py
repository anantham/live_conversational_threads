import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

from lct_python_backend.services.llm_config import (
    build_provider_api_url,
    get_env_llm_defaults,
    get_default_providers,
)

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

        url = build_provider_api_url(self.base_url, "openai_compatible", "chat/completions")
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
        url = build_provider_api_url(self.base_url, "openai_compatible", "embeddings")
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
        model=config.get("chat_model", "zai-org/glm-4.6v-flash"),
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        response_format=response_format,
    )
    content = response["choices"][0]["message"]["content"]
    return extract_json_from_text(content)


class ProviderResult:
    """Result from provider fallback containing the response and metadata."""

    def __init__(
        self,
        data: Any,
        provider_id: str,
        provider_name: str,
        model: str,
        base_url: str,
        provider_type: str,
        attempt_number: int = 1,
        total_providers_tried: int = 1,
    ):
        self.data = data
        self.provider_id = provider_id
        self.provider_name = provider_name
        self.model = model
        self.base_url = base_url
        self.provider_type = provider_type
        self.attempt_number = attempt_number
        self.total_providers_tried = total_providers_tried

    def backend_label(self) -> str:
        """Return a label like 'local_qwen3-32b' or 'modal_qwen3-32b'."""
        prefix = "modal" if "modal" in self.base_url.lower() else "local"
        return f"{prefix}_{self.model}"

    def attempt_info(self) -> str:
        """Return info about provider attempts like 'attempt 2/3'."""
        if self.total_providers_tried <= 1:
            return ""
        return f"attempt {self.attempt_number}/{self.total_providers_tried}"


async def chat_with_provider_fallback(
    messages: list,
    providers: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.3,
    max_tokens: int = 4000,
    response_format: Optional[Dict[str, Any]] = None,
    require_json: bool = True,
) -> ProviderResult:
    """
    Try LLM chat through providers in priority order until one succeeds.

    Args:
        messages: Chat messages to send
        providers: List of provider configs in priority order. If None, uses defaults.
        temperature: LLM temperature
        max_tokens: Max tokens for response
        response_format: Optional response format specification
        require_json: If True, parse response as JSON

    Returns:
        ProviderResult containing the response data and provider metadata

    Raises:
        RuntimeError: If all providers fail
    """
    if providers is None:
        providers = get_default_providers()

    # Filter to enabled providers only
    enabled_providers = [p for p in providers if p.get("enabled", True)]
    if not enabled_providers:
        raise RuntimeError("No enabled LLM providers configured")

    errors: List[Tuple[str, str]] = []
    total_providers = len(enabled_providers)
    attempt_number = 0

    for provider in enabled_providers:
        attempt_number += 1
        provider_id = provider.get("id", "unknown")
        provider_name = provider.get("name", provider_id)
        base_url = str(provider.get("base_url", "")).rstrip("/")
        model = provider.get("model", "")
        provider_type = provider.get("type", "openai_compatible")
        timeout = float(provider.get("timeout_seconds", 120))
        api_key = provider.get("api_key")

        if not base_url or not model:
            logger.warning("[LLM Fallback] Skipping provider %s: missing base_url or model", provider_id)
            continue

        logger.info(
            "[LLM Fallback] Trying provider %d/%d: %s (%s) model=%s",
            attempt_number,
            total_providers,
            provider_name,
            provider_type,
            model,
        )

        try:
            # Build the request
            payload: Dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }

            # Add response format if supported
            supports_json_object = base_url not in _JSON_OBJECT_UNSUPPORTED_BASE_URLS
            if response_format:
                payload["response_format"] = response_format
            elif require_json and supports_json_object:
                payload["response_format"] = {"type": "json_object"}

            # Build headers
            headers: Dict[str, str] = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            url = build_provider_api_url(base_url, provider_type, "chat/completions")
            if TRACE_API_CALLS:
                logger.info(
                    "[LLM Fallback] POST %s model=%s messages=%s",
                    url,
                    model,
                    len(messages or []),
                )

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()

                if TRACE_API_CALLS:
                    logger.info(
                        "[LLM Fallback] %s status=%s preview=%s",
                        url,
                        response.status_code,
                        _preview_text(response.text),
                    )

                result_json = response.json()
                content = result_json["choices"][0]["message"]["content"]

                if require_json:
                    data = extract_json_from_text(content)
                else:
                    data = content

                logger.info(
                    "[LLM Fallback] Success with provider %d/%d: %s (%s)",
                    attempt_number,
                    total_providers,
                    provider_name,
                    provider_id,
                )

                return ProviderResult(
                    data=data,
                    provider_id=provider_id,
                    provider_name=provider_name,
                    model=model,
                    base_url=base_url,
                    provider_type=provider_type,
                    attempt_number=attempt_number,
                    total_providers_tried=total_providers,
                )

        except httpx.HTTPStatusError as exc:
            error_msg = f"HTTP {exc.response.status_code}: {_preview_text(exc.response.text, 100)}"
            logger.warning(
                "[LLM Fallback] Provider %s failed: %s",
                provider_name,
                error_msg,
            )
            errors.append((provider_name, error_msg))

            # Handle json_object not supported - mark and retry without it
            if "response_format" in payload and exc.response.status_code in (400, 422):
                _JSON_OBJECT_UNSUPPORTED_BASE_URLS.add(base_url)

        except httpx.TimeoutException:
            error_msg = f"Timeout after {timeout}s"
            logger.warning("[LLM Fallback] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except httpx.ConnectError as exc:
            error_msg = f"Connection failed: {exc}"
            logger.warning("[LLM Fallback] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except json.JSONDecodeError as exc:
            error_msg = f"JSON parse error: {exc}"
            logger.warning("[LLM Fallback] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            logger.warning("[LLM Fallback] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

    # All providers failed
    error_summary = "; ".join(f"{name}: {err}" for name, err in errors)
    raise RuntimeError(f"All LLM providers failed. Errors: {error_summary}")


def chat_with_provider_fallback_sync(
    messages: list,
    providers: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.3,
    max_tokens: int = 4000,
    response_format: Optional[Dict[str, Any]] = None,
    require_json: bool = True,
) -> ProviderResult:
    """
    Synchronous version of chat_with_provider_fallback.

    Try LLM chat through providers in priority order until one succeeds.
    """
    if providers is None:
        providers = get_default_providers()

    # Filter to enabled providers only
    enabled_providers = [p for p in providers if p.get("enabled", True)]
    if not enabled_providers:
        raise RuntimeError("No enabled LLM providers configured")

    errors: List[Tuple[str, str]] = []
    total_providers = len(enabled_providers)
    attempt_number = 0

    for provider in enabled_providers:
        attempt_number += 1
        provider_id = provider.get("id", "unknown")
        provider_name = provider.get("name", provider_id)
        base_url = str(provider.get("base_url", "")).rstrip("/")
        model = provider.get("model", "")
        provider_type = provider.get("type", "openai_compatible")
        timeout = float(provider.get("timeout_seconds", 120))
        api_key = provider.get("api_key")

        if not base_url or not model:
            logger.warning("[LLM Fallback Sync] Skipping provider %s: missing base_url or model", provider_id)
            continue

        logger.info(
            "[LLM Fallback Sync] Trying provider %d/%d: %s (%s) model=%s",
            attempt_number,
            total_providers,
            provider_name,
            provider_type,
            model,
        )

        try:
            # Build the request
            payload: Dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }

            # Add response format if supported
            supports_json_object = base_url not in _JSON_OBJECT_UNSUPPORTED_BASE_URLS
            if response_format:
                payload["response_format"] = response_format
            elif require_json and supports_json_object:
                payload["response_format"] = {"type": "json_object"}

            # Build headers
            headers: Dict[str, str] = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            url = build_provider_api_url(base_url, provider_type, "chat/completions")
            if TRACE_API_CALLS:
                logger.info(
                    "[LLM Fallback Sync] POST %s model=%s messages=%s",
                    url,
                    model,
                    len(messages or []),
                )

            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, json=payload, headers=headers)

                # Handle json_object not supported - retry without it
                if response.status_code in (400, 422) and "response_format" in payload:
                    logger.warning(
                        "[LLM Fallback Sync] Provider %s rejected response_format; retrying without.",
                        provider_name,
                    )
                    _JSON_OBJECT_UNSUPPORTED_BASE_URLS.add(base_url)
                    payload.pop("response_format", None)
                    response = client.post(url, json=payload, headers=headers)

                response.raise_for_status()

                if TRACE_API_CALLS:
                    logger.info(
                        "[LLM Fallback Sync] %s status=%s preview=%s",
                        url,
                        response.status_code,
                        _preview_text(response.text),
                    )

                result_json = response.json()
                content = result_json["choices"][0]["message"]["content"]

                if require_json:
                    data = extract_json_from_text(content)
                else:
                    data = content

                logger.info(
                    "[LLM Fallback Sync] Success with provider %d/%d: %s (%s)",
                    attempt_number,
                    total_providers,
                    provider_name,
                    provider_id,
                )

                return ProviderResult(
                    data=data,
                    provider_id=provider_id,
                    provider_name=provider_name,
                    model=model,
                    base_url=base_url,
                    provider_type=provider_type,
                    attempt_number=attempt_number,
                    total_providers_tried=total_providers,
                )

        except httpx.HTTPStatusError as exc:
            error_msg = f"HTTP {exc.response.status_code}: {_preview_text(exc.response.text, 100)}"
            logger.warning("[LLM Fallback Sync] Provider %d/%d %s failed: %s", attempt_number, total_providers, provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except httpx.TimeoutException:
            error_msg = f"Timeout after {timeout}s"
            logger.warning("[LLM Fallback Sync] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except httpx.ConnectError as exc:
            error_msg = f"Connection failed: {exc}"
            logger.warning("[LLM Fallback Sync] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except json.JSONDecodeError as exc:
            error_msg = f"JSON parse error: {exc}"
            logger.warning("[LLM Fallback Sync] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

        except Exception as exc:
            error_msg = f"{type(exc).__name__}: {exc}"
            logger.warning("[LLM Fallback Sync] Provider %s failed: %s", provider_name, error_msg)
            errors.append((provider_name, error_msg))

    # All providers failed
    error_summary = "; ".join(f"{name}: {err}" for name, err in errors)
    raise RuntimeError(f"All LLM providers failed. Errors: {error_summary}")

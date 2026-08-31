import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from lct_python_backend.services.llm_config import (
    build_provider_api_url,
    get_env_llm_defaults,
    get_default_providers,
)
from lct_python_backend.services.egress_guard import assert_local_egress

logger = logging.getLogger("lct_backend")

_CLIENT_CACHE: Dict[Tuple[str, float, bool], "LocalLLMClient"] = {}
_JSON_OBJECT_UNSUPPORTED_BASE_URLS: set[str] = set()
_LOGGED_MODEL_SUBSTITUTIONS: set[Tuple[str, str, str]] = set()
from lct_python_backend.services.env_helpers import env_bool


def _backoff_retry_delay(errors, attempt):
    """Exponential-backoff delay (seconds) before retrying the whole provider loop
    after a TRANSIENT all-providers-failed — or None to give up and raise.

    Env-gated and OFF by default (``LLM_RETRY_BACKOFF_INITIAL_S=0``): completely
    inert for live STT / interactive callers. A batch caller (e.g. an offline
    .threads rebuild against a laptop LLM that naps) opts in by setting the env,
    so a multi-hour build patiently waits out naps instead of degrading. Never
    retries on 4xx rejections — only on connection/timeout/reset errors."""
    init = float(os.getenv("LLM_RETRY_BACKOFF_INITIAL_S", "0") or 0)
    if init <= 0:
        return None
    if attempt >= int(os.getenv("LLM_RETRY_BACKOFF_MAX_ATTEMPTS", "40") or 40):
        return None
    cap = float(os.getenv("LLM_RETRY_BACKOFF_CAP_S", "120") or 120)
    _TRANSIENT = ("timeout", "connection", "readerror", "connecterror",
                  "forcibly closed", "did not properly respond", "10054", "10060", "10053")
    if not any(any(t in (err or "").lower() for t in _TRANSIENT) for _, err in errors):
        return None
    return min(init * (2 ** attempt), cap)


# Default OFF: these traces echo transcript/LLM content (AGENTS.md #9 —
# diagnostic logging is opt-in). Set TRACE_API_CALLS=1 to enable.
TRACE_API_CALLS = env_bool("TRACE_API_CALLS", default=False)
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))


def _resolve_served_model(result_json: Any, requested_model: str, provider_id: str) -> str:
    """Extract the actual served model from a chat completion response.

    Returns the response's ``model`` field when present, otherwise the requested
    model. Logs a one-time warning per (provider_id, requested, served) tuple
    when the provider substituted a different model — see ADR-030 §D5.
    """
    served = ""
    if isinstance(result_json, dict):
        candidate = result_json.get("model")
        if isinstance(candidate, str) and candidate.strip():
            served = candidate.strip()
    if not served:
        return requested_model
    if served != requested_model:
        key = (provider_id, requested_model, served)
        if key not in _LOGGED_MODEL_SUBSTITUTIONS:
            _LOGGED_MODEL_SUBSTITUTIONS.add(key)
            logger.warning(
                "[PROVIDER] %s requested=%s served=%s (model substitution; using served name for telemetry)",
                provider_id,
                requested_model,
                served,
            )
    return served


def _optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _response_fact_metrics(result_json: Any) -> Dict[str, Any]:
    """Extract content-free provider facts while preserving missing usage."""

    body = result_json if isinstance(result_json, dict) else {}
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    prompt_tokens = _optional_int(usage.get("prompt_tokens"))
    completion_tokens = _optional_int(usage.get("completion_tokens"))
    total_tokens = _optional_int(usage.get("total_tokens"))
    if total_tokens is None and prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens

    finish_reason = None
    choices = body.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        candidate = choices[0].get("finish_reason")
        if candidate is not None:
            finish_reason = str(candidate)

    request_id = body.get("id")
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "finish_reason": finish_reason,
        "request_id": str(request_id) if request_id is not None else None,
    }


def _record_llm_telemetry(
    result_json: Any,
    *,
    served_model: str,
    base_url: str,
    provider_type: str,
    elapsed_ms: float,
    require_json: bool,
) -> None:
    """Best-effort LLM speed telemetry hook (see services/llm_telemetry_service)."""
    try:
        from lct_python_backend.services.llm_telemetry_service import (
            catalog_provider_key,
            record_llm_call,
        )

        usage = (result_json or {}).get("usage") or {}
        record_llm_call(
            provider_key=catalog_provider_key(base_url, provider_type),
            model=served_model,
            base_url=base_url,
            total_ms=elapsed_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            ok=True,
            valid_json=True if require_json else None,
        )
    except Exception:  # noqa: BLE001 - telemetry must never break generation
        logger.debug("[LLM TELEMETRY] hook failed", exc_info=True)


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
                        "Local LLM response_format rejected; retrying without response_format."
                    )
                    if TRACE_API_CALLS:
                        logger.debug(
                            "Local LLM response_format rejection body: %s",
                            _preview_text(exc.response.text),
                        )
                    _JSON_OBJECT_UNSUPPORTED_BASE_URLS.add(self.base_url)
                    payload.pop("response_format", None)
                    payload.pop("reasoning_effort", None)
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


def provider_from_legacy_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Build a single-provider dict from a legacy single-provider ``config``.

    Used to bridge legacy callers (``local_chat_json``, EmbeddingService)
    onto the gateway's provider-list interface without each call site
    knowing about provider records. The result is shaped like an entry
    in ``llm_providers`` so the gateway's substitution policy applies
    uniformly. ADR-030 §D5.
    """
    base_url = str(config.get("base_url", "")).rstrip("/")
    chat_model = str(config.get("chat_model") or "qwen3-32b")
    embedding_model = config.get("embedding_model")
    timeout = float(config.get("timeout_seconds", 120))
    provider: Dict[str, Any] = {
        "id": "legacy_config",
        "name": "Legacy single-provider config",
        "type": "openai_compatible",
        "base_url": base_url,
        "model": chat_model,
        "enabled": True,
        "timeout_seconds": timeout,
    }
    if embedding_model:
        provider["embedding_model"] = embedding_model
    return provider


async def local_chat_json(
    config: Dict[str, Any],
    messages: list,
    temperature: float = 0.3,
    max_tokens: int = 4000,
    response_format: Optional[Dict[str, Any]] = None,
    prompt_name: Optional[str] = None,
    prompt_version: Optional[str] = None,
) -> Any:
    """Legacy chat-with-JSON helper.

    Routes through the LlmGateway per ADR-030 §D5 so that capability-
    sensitive substitution policy (model fidelity, fallback semantics)
    applies to every detector / clusterer / fact-checker that calls
    this function. Preserves the legacy return shape (parsed JSON
    payload) so call sites need no change.
    """
    # Lazy import to avoid circular dependency: llm_gateway imports
    # ProviderResult / chat_with_provider_fallback from this module.
    from lct_python_backend.services.llm_gateway import Capability, gateway

    provider = provider_from_legacy_config(config)
    capability = (
        Capability.CHAT_JSON_OBJECT
        if response_format is None
        else Capability.CHAT_JSON_SCHEMA
    )
    result = await gateway().chat(
        messages=messages,
        capability=capability,
        providers=[provider],
        temperature=temperature,
        max_tokens=max_tokens,
        response_format=response_format,
        prompt_name=prompt_name,
        prompt_version=prompt_version,
    )
    return result.data


class ProviderResult:
    """Result from provider fallback containing the response and metadata.

    ``prompt_name`` and ``prompt_version`` (added per ADR-030 §D7) carry
    the canonical prompt identity used to produce this response. They
    default to ``None`` for back-compat; new callers passing through the
    gateway should set them so cost/quality telemetry can attribute
    output to a specific prompt revision.
    """

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
        prompt_name: Optional[str] = None,
        prompt_version: Optional[str] = None,
        prompt_tokens: Optional[int] = None,
        completion_tokens: Optional[int] = None,
        total_tokens: Optional[int] = None,
        provider_latency_ms: Optional[float] = None,
        finish_reason: Optional[str] = None,
        request_id: Optional[str] = None,
        cache_hit: bool = False,
    ):
        self.data = data
        self.provider_id = provider_id
        self.provider_name = provider_name
        self.model = model
        self.base_url = base_url
        self.provider_type = provider_type
        self.attempt_number = attempt_number
        self.total_providers_tried = total_providers_tried
        self.prompt_name = prompt_name
        self.prompt_version = prompt_version
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens
        self.provider_latency_ms = provider_latency_ms
        self.finish_reason = finish_reason
        self.request_id = request_id
        self.cache_hit = cache_hit

    def backend_label(self) -> str:
        """Return a backend label that reflects the actual provider class."""
        provider_type = str(self.provider_type or "").strip().lower()
        if provider_type == "openai":
            return f"openai_{self.model}"
        if provider_type == "openrouter":
            return f"openrouter_{self.model}"

        parsed = urlparse(self.base_url)
        host = parsed.netloc.lower()
        if "modal" in host:
            prefix = "modal"
        elif any(token in host for token in ("localhost", "127.0.0.1", "100.81.")):
            prefix = "local"
        else:
            prefix = "remote"
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
    prompt_name: Optional[str] = None,
    prompt_version: Optional[str] = None,
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

            # Reasoning models (e.g. Ollama qwen3.6/gemma4) route chain-of-thought
            # into a separate 'reasoning' field and leave 'content' EMPTY, which
            # made extract_json_from_text fail on every structured call. Disabling
            # thinking makes them emit JSON directly in content. Non-reasoning
            # servers (LM Studio, vLLM) ignore the unknown field harmlessly; if one
            # rejects it with 400/422 we strip it on retry (below) and the
            # reasoning-field fallback at parse time still recovers the output.
            if provider_type == "openai_compatible":
                payload["reasoning_effort"] = provider.get("reasoning_effort", "none")

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
            # Local-only egress guard: refuse non-local providers (cloud/Modal)
            # when LCT_LOCAL_ONLY is on. Treated like any provider failure, so
            # the fallback loop simply skips to the next (local) provider.
            assert_local_egress(url, purpose=f"LLM chat ({provider_id})")
            if TRACE_API_CALLS:
                logger.info(
                    "[LLM Fallback] POST %s model=%s messages=%s",
                    url,
                    model,
                    len(messages or []),
                )

            _t0 = time.perf_counter()
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                _elapsed_ms = (time.perf_counter() - _t0) * 1000.0

                if TRACE_API_CALLS:
                    logger.info(
                        "[LLM Fallback] %s status=%s preview=%s",
                        url,
                        response.status_code,
                        _preview_text(response.text),
                    )

                result_json = response.json()
                served_model = _resolve_served_model(result_json, model, provider_id)
                _msg = result_json["choices"][0]["message"]
                content = _msg.get("content") or ""
                if not content:
                    # Reasoning model whose server ignored reasoning_effort: the
                    # answer is in a separate field. Recover it rather than drop it.
                    content = _msg.get("reasoning") or _msg.get("thinking") or ""

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
                _record_llm_telemetry(
                    result_json,
                    served_model=served_model,
                    base_url=base_url,
                    provider_type=provider_type,
                    elapsed_ms=_elapsed_ms,
                    require_json=require_json,
                )

                fact_metrics = _response_fact_metrics(result_json)

                return ProviderResult(
                    data=data,
                    provider_id=provider_id,
                    provider_name=provider_name,
                    model=served_model,
                    base_url=base_url,
                    provider_type=provider_type,
                    attempt_number=attempt_number,
                    total_providers_tried=total_providers,
                    prompt_name=prompt_name,
                    prompt_version=prompt_version,
                    provider_latency_ms=_elapsed_ms,
                    **fact_metrics,
                )

        except httpx.HTTPStatusError as exc:
            # Status always kept (diagnostic); upstream body — which can echo the
            # prompt — only under TRACE_API_CALLS. error_msg also feeds `errors`.
            error_body = _preview_text(exc.response.text, 100) if TRACE_API_CALLS else ""
            error_msg = f"HTTP {exc.response.status_code}" + (f": {error_body}" if error_body else "")
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
    prompt_name: Optional[str] = None,
    prompt_version: Optional[str] = None,
    skip_cache_read: bool = False,
    _backoff_attempt: int = 0,
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

    # ── content-addressed cache (LCT_LLM_CACHE=0 disables) ──────────────────
    # A Phase-2 extract of 1,125 turns made ~1,090 calls over 126 MINUTES, and
    # re-running it repeated every one — including ~1,080 three-second "keep
    # accumulating" decisions whose inputs never changed. The key covers
    # messages + sampling contract + prompt name/VERSION + candidate models,
    # so a prompt edit or a model swap INVALIDATES rather than replays.
    # Full correctness + semantics note: services/llm_cache.py.
    from lct_python_backend.services import llm_cache as _cache

    _key = None
    _hit = None
    try:
        _key = _cache.cache_key(
            messages, temperature=temperature, max_tokens=max_tokens,
            require_json=require_json, prompt_name=prompt_name,
            prompt_version=prompt_version,
            models=[str(p.get("model", "")) for p in enabled_providers],
        )
        _hit = None if skip_cache_read else _cache.get(_key)
    except Exception:  # noqa: BLE001 — a broken cache must never fail a call
        _key, _hit = None, None
    if _hit is not None:
        _first = enabled_providers[0]
        logger.info("[LLM Fallback Sync] CACHE HIT %s (prompt=%s) — no model call",
                    _key[:12], prompt_name or "-")
        return ProviderResult(
            data=_hit["data"],
            provider_id=str(_first.get("id", "cache")),
            provider_name=str(_first.get("name", "cache")) + " (cached)",
            model=_hit.get("model") or str(_first.get("model", "")),
            base_url=str(_first.get("base_url", "")),
            provider_type=str(_first.get("type", "openai_compatible")),
            attempt_number=0, total_providers_tried=0,
            prompt_name=prompt_name, prompt_version=prompt_version,
            cache_hit=True,
        )

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

            # Reasoning models (e.g. Ollama qwen3.6/gemma4) route chain-of-thought
            # into a separate 'reasoning' field and leave 'content' EMPTY, which
            # made extract_json_from_text fail on every structured call. Disabling
            # thinking makes them emit JSON directly in content. Non-reasoning
            # servers (LM Studio, vLLM) ignore the unknown field harmlessly; if one
            # rejects it with 400/422 we strip it on retry (below) and the
            # reasoning-field fallback at parse time still recovers the output.
            if provider_type == "openai_compatible":
                payload["reasoning_effort"] = provider.get("reasoning_effort", "none")

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
            assert_local_egress(url, purpose=f"LLM chat sync ({provider_id})")
            if TRACE_API_CALLS:
                logger.info(
                    "[LLM Fallback Sync] POST %s model=%s messages=%s",
                    url,
                    model,
                    len(messages or []),
                )

            _t0 = time.perf_counter()
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
                    # Also drop reasoning_effort in case this server is the one
                    # rejecting it; the reasoning-field fallback still recovers output.
                    payload.pop("reasoning_effort", None)
                    response = client.post(url, json=payload, headers=headers)

                response.raise_for_status()
                _elapsed_ms = (time.perf_counter() - _t0) * 1000.0

                if TRACE_API_CALLS:
                    logger.info(
                        "[LLM Fallback Sync] %s status=%s preview=%s",
                        url,
                        response.status_code,
                        _preview_text(response.text),
                    )

                result_json = response.json()
                served_model = _resolve_served_model(result_json, model, provider_id)
                _msg = result_json["choices"][0]["message"]
                content = _msg.get("content") or ""
                if not content:
                    # Reasoning model whose server ignored reasoning_effort: the
                    # answer is in a separate field. Recover it rather than drop it.
                    content = _msg.get("reasoning") or _msg.get("thinking") or ""

                if require_json:
                    data = extract_json_from_text(content)
                else:
                    data = content

                # OpenAI prompt-cache hit telemetry — auto-cached when system
                # prompt ≥1024 tokens and prefix is byte-stable. Visible as
                # usage.prompt_tokens_details.cached_tokens. Logging this so
                # we can verify caching kicks in for long imports (~40% cost
                # reduction on cache hits).
                usage = result_json.get("usage") or {}
                prompt_tokens = usage.get("prompt_tokens", 0)
                cached_tokens = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
                cache_pct = (cached_tokens / prompt_tokens * 100) if prompt_tokens else 0
                logger.info(
                    "[LLM Fallback Sync] Success with provider %d/%d: %s (%s) "
                    "tokens=in:%s cached:%s(%.0f%%) out:%s",
                    attempt_number,
                    total_providers,
                    provider_name,
                    provider_id,
                    prompt_tokens,
                    cached_tokens,
                    cache_pct,
                    completion_tokens,
                )
                _record_llm_telemetry(
                    result_json,
                    served_model=served_model,
                    base_url=base_url,
                    provider_type=provider_type,
                    elapsed_ms=_elapsed_ms,
                    require_json=require_json,
                )

                fact_metrics = _response_fact_metrics(result_json)

                # Cache only SUCCESSES, and only when a key was computable.
                if _key:
                    _cache.put(_key, data, served_model, prompt_name)

                return ProviderResult(
                    data=data,
                    provider_id=provider_id,
                    provider_name=provider_name,
                    model=served_model,
                    base_url=base_url,
                    provider_type=provider_type,
                    attempt_number=attempt_number,
                    total_providers_tried=total_providers,
                    prompt_name=prompt_name,
                    prompt_version=prompt_version,
                    provider_latency_ms=_elapsed_ms,
                    **fact_metrics,
                )

        except httpx.HTTPStatusError as exc:
            # Status always kept (diagnostic); upstream body gated (can echo the prompt).
            error_body = _preview_text(exc.response.text, 100) if TRACE_API_CALLS else ""
            error_msg = f"HTTP {exc.response.status_code}" + (f": {error_body}" if error_body else "")
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
    _delay = _backoff_retry_delay(errors, _backoff_attempt)
    if _delay is not None:
        logger.warning(
            "[LLM Fallback Sync] transient all-fail; backing off %.0fs (retry %d) then re-trying providers — %s",
            _delay, _backoff_attempt + 1, error_summary,
        )
        time.sleep(_delay)
        return chat_with_provider_fallback_sync(
            messages, providers, temperature, max_tokens, response_format,
            require_json, prompt_name, prompt_version, _backoff_attempt=_backoff_attempt + 1,
        )
    raise RuntimeError(f"All LLM providers failed. Errors: {error_summary}")

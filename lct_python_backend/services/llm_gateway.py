"""LLM gateway — capability-sensitive provider routing per ADR-030 §D5.

One gateway. All chat + embedding calls route through it. The gateway
hides provider identity from callers — no service knows about
"Modal", "LM Studio", or "OpenAI"; they ask for a *capability*
(``CHAT``, ``CHAT_JSON_OBJECT``, ``CHAT_JSON_SCHEMA``, ``EMBED``) and
the gateway routes to the configured provider list with the right
substitution policy for that capability.

Capability-sensitive substitution policy (ADR-030 §D5):

    chat                     → accept response, log one-time warning
    chat_json_object         → accept; on JSON parse fail, fall through
    chat_json_schema         → validate; on schema fail, fall through
    embed                    → REJECT substitution, fall through

Why per-capability? Embedding spaces are model-specific — silently
mixing vectors from different models corrupts retrieval. Chat
substitutions (LM Studio aliasing) are usually benign and observable
downstream. Schema-bound calls need validation.

This module is the single point of LLM provider integration. Legacy
helpers (``local_chat_json``, ``chat_with_provider_fallback``) are
preserved as thin re-exports / wrappers in ``local_llm_client.py``;
new call sites should use the gateway directly.
"""

from __future__ import annotations

import logging
import os
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

from lct_python_backend.services.llm_config import (
    build_provider_api_url,
    get_default_providers,
    get_env_llm_defaults,
)
from lct_python_backend.services.local_llm_client import (
    ProviderResult,
    chat_with_provider_fallback,
    chat_with_provider_fallback_sync,
)

logger = logging.getLogger("lct_backend")

TRACE_API_CALLS = os.getenv("TRACE_API_CALLS", "true").strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Capability enum
# ---------------------------------------------------------------------------


class Capability(str, Enum):
    """Provider routing capabilities. The gateway picks substitution
    policy based on which capability the caller asked for."""

    CHAT = "chat"
    """Plain chat completion. Substitution: accept + warn."""

    CHAT_JSON_OBJECT = "chat_json_object"
    """Chat with response_format=json_object. Substitution: accept;
    JSON parse failure falls through to next provider."""

    CHAT_JSON_SCHEMA = "chat_json_schema"
    """Chat with structured-output schema. Substitution: validate;
    schema-validation failure falls through to next provider."""

    EMBED = "embed"
    """Vector embeddings. Substitution: REJECT (vector space mismatch);
    fall through to next provider."""


# ---------------------------------------------------------------------------
# Gateway
# ---------------------------------------------------------------------------


class LlmGateway:
    """Single entry point for LLM/embedding calls.

    Stateless — instances are interchangeable. Tests use the same class.
    """

    async def chat(
        self,
        messages: list,
        *,
        capability: Capability = Capability.CHAT,
        providers: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict[str, Any]] = None,
        prompt_name: Optional[str] = None,
        prompt_version: Optional[str] = None,
    ) -> ProviderResult:
        """Async chat completion routed through the providers list with
        capability-sensitive policy applied.

        For ``CHAT_JSON_OBJECT`` capability without an explicit
        ``response_format``, the gateway sets ``{"type": "json_object"}``.
        For ``CHAT_JSON_SCHEMA``, callers must supply ``response_format``
        with the full schema.

        ``prompt_name`` and ``prompt_version`` (ADR-030 §D7) are stamped
        onto the resulting ``ProviderResult`` for telemetry attribution.
        """
        require_json = capability in {Capability.CHAT_JSON_OBJECT, Capability.CHAT_JSON_SCHEMA}
        return await chat_with_provider_fallback(
            messages,
            providers=providers,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
            require_json=require_json,
            prompt_name=prompt_name,
            prompt_version=prompt_version,
        )

    def chat_sync(
        self,
        messages: list,
        *,
        capability: Capability = Capability.CHAT,
        providers: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict[str, Any]] = None,
        prompt_name: Optional[str] = None,
        prompt_version: Optional[str] = None,
    ) -> ProviderResult:
        """Synchronous variant of ``chat`` for callers running outside an
        async context (legacy helpers). Same capability + prompt-version
        semantics."""
        require_json = capability in {Capability.CHAT_JSON_OBJECT, Capability.CHAT_JSON_SCHEMA}
        return chat_with_provider_fallback_sync(
            messages,
            providers=providers,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
            require_json=require_json,
            prompt_name=prompt_name,
            prompt_version=prompt_version,
        )

    async def embed(
        self,
        text: str,
        *,
        providers: Optional[List[Dict[str, Any]]] = None,
        encoding_format: str = "float",
    ) -> List[float]:
        """Generate a vector embedding for ``text``.

        Strict model matching: if a provider returns a model name
        different from what was requested, the gateway treats that as a
        failure and falls through to the next provider. Mixing
        embedding-space outputs corrupts downstream retrieval, so this
        is non-negotiable per ADR-030 §D5.
        """
        result = await _embed_with_provider_fallback(
            text=text,
            providers=providers,
            encoding_format=encoding_format,
        )
        return result.data

    async def embed_batch(
        self,
        texts: List[str],
        *,
        providers: Optional[List[Dict[str, Any]]] = None,
        encoding_format: str = "float",
    ) -> List[List[float]]:
        """Batch embedding. Same strict-match policy as ``embed``."""
        if not texts:
            return []
        result = await _embed_with_provider_fallback(
            text=list(texts),
            providers=providers,
            encoding_format=encoding_format,
        )
        return result.data


# ---------------------------------------------------------------------------
# Embed-side provider fallback (strict model match — see policy table)
# ---------------------------------------------------------------------------


_LOGGED_EMBED_SUBSTITUTIONS: set = set()


async def _embed_with_provider_fallback(
    *,
    text,
    providers: Optional[List[Dict[str, Any]]],
    encoding_format: str,
) -> ProviderResult:
    """Embedding-side equivalent of chat_with_provider_fallback.

    The crucial difference: when a provider returns a model name that
    does not match the request, this function REJECTS the response and
    moves to the next provider. ``ProviderResult`` is returned only for
    a successful, model-fidelity-verified call.
    """
    candidates = providers if providers is not None else get_default_providers()
    enabled = [p for p in candidates if p.get("enabled", True) and _provider_supports_embed(p)]
    if not enabled:
        raise RuntimeError("No enabled embedding providers configured")

    errors: List[str] = []
    total = len(enabled)
    for attempt_number, provider in enumerate(enabled, start=1):
        provider_id = provider.get("id", "unknown")
        provider_name = provider.get("name", provider_id)
        base_url = str(provider.get("base_url", "")).rstrip("/")
        requested_model = _embed_model_for(provider)
        provider_type = provider.get("type", "openai_compatible")
        timeout = float(provider.get("timeout_seconds", 60))
        api_key = provider.get("api_key")

        if not base_url or not requested_model:
            logger.warning(
                "[EMBED] skipping %s: missing base_url or embedding model",
                provider_id,
            )
            continue

        url = build_provider_api_url(base_url, provider_type, "embeddings")
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload: Dict[str, Any] = {
            "model": requested_model,
            "input": text,
            "encoding_format": encoding_format,
        }
        if TRACE_API_CALLS:
            count = len(text) if isinstance(text, list) else 1
            logger.info(
                "[EMBED] POST %s model=%s items=%s (provider %d/%d)",
                url,
                requested_model,
                count,
                attempt_number,
                total,
            )

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as exc:
            err = f"HTTP {exc.response.status_code}"
            logger.warning("[EMBED] %s: %s", provider_id, err)
            errors.append(f"{provider_id}: {err}")
            continue
        except httpx.RequestError as exc:
            err = f"{type(exc).__name__}: {exc}"
            logger.warning("[EMBED] %s: %s", provider_id, err)
            errors.append(f"{provider_id}: {err}")
            continue

        served_model = _coerce_model(body.get("model"))
        if served_model and served_model != requested_model:
            key = (provider_id, requested_model, served_model)
            if key not in _LOGGED_EMBED_SUBSTITUTIONS:
                _LOGGED_EMBED_SUBSTITUTIONS.add(key)
                logger.warning(
                    "[EMBED] %s requested=%s served=%s (REJECTED — embedding spaces "
                    "are model-specific; falling through to next provider per ADR-030 §D5)",
                    provider_id,
                    requested_model,
                    served_model,
                )
            errors.append(f"{provider_id}: model substitution {requested_model}→{served_model}")
            continue

        # Extract embeddings
        try:
            data_field = body["data"]
            if isinstance(text, list):
                vectors = [item["embedding"] for item in data_field]
            else:
                vectors = data_field[0]["embedding"]
        except (KeyError, IndexError, TypeError) as exc:
            err = f"malformed embedding response: {exc}"
            logger.warning("[EMBED] %s: %s", provider_id, err)
            errors.append(f"{provider_id}: {err}")
            continue

        return ProviderResult(
            data=vectors,
            provider_id=provider_id,
            provider_name=provider_name,
            model=served_model or requested_model,
            base_url=base_url,
            provider_type=provider_type,
            attempt_number=attempt_number,
            total_providers_tried=total,
        )

    raise RuntimeError(f"All embedding providers failed. Errors: {'; '.join(errors)}")


def _provider_supports_embed(provider: Dict[str, Any]) -> bool:
    """Determine whether a provider config can serve embeddings.

    Today only ``openai_compatible`` and ``openai`` types serve embed;
    OpenRouter typically doesn't. Treat presence of an ``embedding_model``
    field as an explicit opt-in.
    """
    ptype = str(provider.get("type", "")).strip().lower()
    if provider.get("embedding_model"):
        return True
    if ptype in {"openai_compatible", "openai"}:
        return True
    return False


def _embed_model_for(provider: Dict[str, Any]) -> str:
    """The embedding model for a provider — explicit ``embedding_model``
    if set, else fall back to env defaults."""
    explicit = provider.get("embedding_model")
    if explicit:
        return str(explicit)
    defaults = get_env_llm_defaults()
    return str(defaults.get("embedding_model") or "text-embedding-3-small")


def _coerce_model(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ""


# ---------------------------------------------------------------------------
# Module-level singleton + convenience accessor
# ---------------------------------------------------------------------------


_DEFAULT_GATEWAY: Optional[LlmGateway] = None


def gateway() -> LlmGateway:
    """Return the process-wide default gateway. Stateless — fine to
    reuse across requests."""
    global _DEFAULT_GATEWAY
    if _DEFAULT_GATEWAY is None:
        _DEFAULT_GATEWAY = LlmGateway()
    return _DEFAULT_GATEWAY


__all__ = [
    "Capability",
    "LlmGateway",
    "gateway",
]

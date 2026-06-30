"""Circuit-breaker + HTTP-error classification for STT providers.

Extracted from ``stt_http_transcriber`` as part of the
RealtimeHttpSttSession decomposition. The session no longer carries
its own circuit-state dict — it composes a ``CircuitBreaker`` instance
and delegates state_for / mark_failure / clear to it.

Module also hosts the error-classifier helpers
``classify_http_status`` and ``summarize_exception`` that determine
how long a particular failure keeps a candidate provider out of
rotation. Old underscore-prefixed names are re-exported from
``stt_http_transcriber`` for the duration of the deprecation window.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

import httpx

from lct_python_backend.services.env_helpers import env_bool, env_float

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Config — TTL knobs per failure class
# ---------------------------------------------------------------------------

STT_CIRCUIT_BREAKER_ENABLED: bool = env_bool("STT_CIRCUIT_BREAKER_ENABLED", default=True)
STT_CIRCUIT_TIMEOUT_TTL_SECONDS: float = env_float("STT_CIRCUIT_TIMEOUT_TTL_SECONDS", 45.0)
STT_CIRCUIT_NETWORK_TTL_SECONDS: float = env_float("STT_CIRCUIT_NETWORK_TTL_SECONDS", 30.0)
STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS: float = env_float("STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS", 30.0)
STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS: float = env_float("STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS", 20.0)
STT_CIRCUIT_AUTH_TTL_SECONDS: float = env_float("STT_CIRCUIT_AUTH_TTL_SECONDS", 300.0)

API_LOG_PREVIEW_CHARS: int = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))


def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    if value is None:
        return ""
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def candidate_cache_key(candidate: Dict[str, Any]) -> Tuple[str, str, str]:
    """Deterministic key for a provider candidate. Used as the
    circuit-state dict key so failures stick to a specific
    (provider, transport, endpoint) tuple."""
    provider = str(candidate.get("provider") or "").strip().lower()
    transport = str(candidate.get("transport") or "").strip().lower()
    http_url = str(candidate.get("http_url") or candidate.get("base_url") or "").strip().lower()
    return provider, transport, http_url


def circuit_ttl_seconds(error_type: str) -> float:
    """How long a failure of this kind should keep the candidate out."""
    normalized = str(error_type or "").strip().lower()
    if normalized == "auth_failed":
        return max(0.0, STT_CIRCUIT_AUTH_TTL_SECONDS)
    if normalized in {"rate_limited", "quota_exceeded"}:
        return max(0.0, STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS)
    if normalized == "timeout":
        return max(0.0, STT_CIRCUIT_TIMEOUT_TTL_SECONDS)
    if normalized == "network_error":
        return max(0.0, STT_CIRCUIT_NETWORK_TTL_SECONDS)
    if normalized in {"provider_error", "not_found"}:
        return max(0.0, STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS)
    return 0.0


def classify_http_status(status_code: Optional[int], response_text: str = "") -> str:
    if status_code in {401, 403}:
        return "auth_failed"

    preview = str(response_text or "").lower()
    if status_code == 429:
        if any(token in preview for token in ("quota", "insufficient_quota", "credit", "billing")):
            return "quota_exceeded"
        return "rate_limited"
    if status_code == 400:
        if "invalid_api_key" in preview or "incorrect api key" in preview:
            return "auth_failed"
        return "bad_request"
    if status_code == 404:
        return "not_found"
    if status_code == 408:
        return "timeout"
    if status_code and status_code >= 500:
        return "provider_error"
    return "provider_error"


def summarize_exception(exc: Exception) -> Dict[str, Any]:
    """Normalize any STT-provider exception into a structured dict.

    Returns ``{error_type, status_code, body_preview, detail}``.
    The ``error_type`` feeds ``circuit_ttl_seconds`` for TTL routing.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        status_code = response.status_code if response is not None else None
        body_preview = ""
        error_type = classify_http_status(status_code, "")

        try:
            if response is not None:
                body_preview = _preview_text(response.text if response is not None else "")
                if status_code == 400 and body_preview:
                    error_type = classify_http_status(status_code, body_preview)
        except Exception as read_exc:
            logger.warning("[STT] Failed to read response body: %s", read_exc)

        reason_phrase = ""
        if response is not None:
            reason_phrase = str(getattr(response, "reason_phrase", "") or "").strip()

        status_label = f"HTTP {status_code}" if status_code is not None else "HTTP error"
        if reason_phrase:
            status_label = f"{status_label} {reason_phrase}"

        detail = status_label
        if body_preview:
            detail = f"{detail}: {body_preview}"
        if error_type == "auth_failed":
            detail = f"{detail} - Check your API key is valid and not expired"

        return {
            "error_type": error_type,
            "status_code": status_code,
            "body_preview": body_preview,
            "detail": detail,
        }

    if isinstance(exc, httpx.TimeoutException):
        return {
            "error_type": "timeout",
            "status_code": None,
            "body_preview": "",
            "detail": str(exc) or "Timed out waiting for STT provider response.",
        }

    if isinstance(exc, httpx.RequestError):
        return {
            "error_type": "network_error",
            "status_code": None,
            "body_preview": "",
            "detail": str(exc) or "Network error while contacting STT provider.",
        }

    return {
        "error_type": "provider_error",
        "status_code": None,
        "body_preview": "",
        "detail": str(exc) or exc.__class__.__name__,
    }


def _utc_now_iso() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat() + "Z"


# ---------------------------------------------------------------------------
# CircuitBreaker — per-session state holder
# ---------------------------------------------------------------------------


class CircuitBreaker:
    """Per-session record of which candidate (provider/transport/endpoint)
    tuples are currently kept out of rotation, and for how long.

    The session composes one of these and delegates all circuit-state
    checks to it. Disabled (returns "always closed") when
    ``STT_CIRCUIT_BREAKER_ENABLED`` is false.
    """

    def __init__(self) -> None:
        self._state: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

    def state_for(self, candidate: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Return the open-state dict for *candidate*, or None when
        the candidate is closed (eligible to attempt). Expired entries
        are evicted as a side effect."""
        if not STT_CIRCUIT_BREAKER_ENABLED:
            return None
        key = candidate_cache_key(candidate)
        state = self._state.get(key)
        if not state:
            return None
        if time.monotonic() >= float(state.get("until_monotonic") or 0.0):
            self._state.pop(key, None)
            return None
        return dict(state)

    def mark_failure(
        self,
        candidate: Dict[str, Any],
        *,
        error_type: str,
        detail: str,
        latency_ms: float,
    ) -> None:
        """Open the breaker for this candidate for the TTL associated
        with *error_type*. No-op when breaker is disabled or the TTL
        for this error class is 0."""
        ttl = circuit_ttl_seconds(error_type)
        if ttl <= 0.0 or not STT_CIRCUIT_BREAKER_ENABLED:
            return
        key = candidate_cache_key(candidate)
        self._state[key] = {
            "error_type": str(error_type or "provider_error"),
            "detail": str(detail or ""),
            "latency_ms": latency_ms,
            "opened_at": _utc_now_iso(),
            "until_monotonic": time.monotonic() + ttl,
            "ttl_seconds": ttl,
        }

    def clear(self, candidate: Dict[str, Any]) -> None:
        """Force-close the breaker for *candidate* (e.g. after a
        successful attempt despite a stale open state)."""
        self._state.pop(candidate_cache_key(candidate), None)

"""Content-free LLM call envelopes and observation boundary (ADR-064).

Persistence is injected through a narrow store protocol and remains strictly
best-effort: telemetry availability never changes inference output.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Protocol

import httpx

from lct_python_backend.services.egress_guard import CloudEgressBlocked

logger = logging.getLogger("lct_backend")


@dataclass(frozen=True)
class LLMCallFactEvent:
    """Safe operational facts for one logical chat or embedding operation."""

    capability: str
    status: str
    latency_ms: int
    started_at: datetime
    completed_at: datetime
    conversation_id: Optional[str] = None
    session_id: Optional[str] = None
    route_id: Optional[str] = None
    provider_id: Optional[str] = None
    provider_type: Optional[str] = None
    model: Optional[str] = None
    attempt_number: Optional[int] = None
    total_providers_tried: Optional[int] = None
    prompt_name: Optional[str] = None
    prompt_version: Optional[str] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    provider_latency_ms: Optional[float] = None
    finish_reason: Optional[str] = None
    error_code: Optional[str] = None
    request_id: Optional[str] = None

    def model_values(self) -> dict:
        return asdict(self)


class LLMCallFactStore(Protocol):
    async def record_async(self, event: LLMCallFactEvent) -> bool: ...

    def record_sync(self, event: LLMCallFactEvent) -> bool: ...


@dataclass(frozen=True)
class LLMCallFactContext:
    capability: str
    route_id: Optional[str] = None
    conversation_id: Optional[str] = None
    session_id: Optional[str] = None
    prompt_name: Optional[str] = None
    prompt_version: Optional[str] = None


def safe_error_code(exc: BaseException) -> str:
    """Classify an error without persisting its potentially private message."""

    if isinstance(exc, CloudEgressBlocked):
        return "cloud_egress_blocked"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.ConnectError):
        return "connection_failed"
    if isinstance(exc, httpx.HTTPStatusError):
        return "http_error"
    if isinstance(exc, RuntimeError) and str(exc).startswith("All LLM providers failed"):
        return "all_providers_failed"
    if isinstance(exc, RuntimeError) and str(exc).startswith("All embedding providers failed"):
        return "all_providers_failed"
    name = re.sub(r"(?<!^)(?=[A-Z])", "_", type(exc).__name__).lower()
    return name or "unknown_error"


def _elapsed_ms(started_clock: float) -> int:
    return max(0, int(round((time.perf_counter() - started_clock) * 1000.0)))


def _success_event(
    *,
    result: Any,
    context: LLMCallFactContext,
    started_at: datetime,
    completed_at: datetime,
    started_clock: float,
) -> LLMCallFactEvent:
    cache_hit = bool(getattr(result, "cache_hit", False))
    return LLMCallFactEvent(
        capability=context.capability,
        status="cache_hit" if cache_hit else "success",
        latency_ms=_elapsed_ms(started_clock),
        started_at=started_at,
        completed_at=completed_at,
        conversation_id=(
            str(context.conversation_id) if context.conversation_id is not None else None
        ),
        session_id=str(context.session_id) if context.session_id is not None else None,
        route_id=str(context.route_id) if context.route_id is not None else None,
        provider_id=None if cache_hit else getattr(result, "provider_id", None),
        provider_type=None if cache_hit else getattr(result, "provider_type", None),
        model=getattr(result, "model", None),
        attempt_number=getattr(result, "attempt_number", None),
        total_providers_tried=getattr(result, "total_providers_tried", None),
        prompt_name=context.prompt_name or getattr(result, "prompt_name", None),
        prompt_version=context.prompt_version or getattr(result, "prompt_version", None),
        prompt_tokens=getattr(result, "prompt_tokens", None),
        completion_tokens=getattr(result, "completion_tokens", None),
        total_tokens=getattr(result, "total_tokens", None),
        provider_latency_ms=getattr(result, "provider_latency_ms", None),
        finish_reason="cache_hit" if cache_hit else getattr(result, "finish_reason", None),
        request_id=getattr(result, "request_id", None),
    )


def _error_event(
    *,
    context: LLMCallFactContext,
    started_at: datetime,
    completed_at: datetime,
    started_clock: float,
    exc: BaseException,
) -> LLMCallFactEvent:
    return LLMCallFactEvent(
        capability=context.capability,
        status="error",
        latency_ms=_elapsed_ms(started_clock),
        started_at=started_at,
        completed_at=completed_at,
        conversation_id=(
            str(context.conversation_id) if context.conversation_id is not None else None
        ),
        session_id=str(context.session_id) if context.session_id is not None else None,
        route_id=str(context.route_id) if context.route_id is not None else None,
        prompt_name=context.prompt_name,
        prompt_version=context.prompt_version,
        error_code=safe_error_code(exc),
    )


async def observe_llm_call_async(
    store: LLMCallFactStore,
    operation: Callable[[], Awaitable[Any]],
    context: LLMCallFactContext,
) -> Any:
    """Execute one async gateway operation and record its content-free facts."""

    started_at = datetime.now(timezone.utc)
    started_clock = time.perf_counter()
    try:
        result = await operation()
    except Exception as exc:
        event = _error_event(
            context=context,
            started_at=started_at,
            completed_at=datetime.now(timezone.utc),
            started_clock=started_clock,
            exc=exc,
        )
        try:
            await store.record_async(event)
        except Exception as store_exc:  # noqa: BLE001
            logger.warning(
                "[LLM FACTS] async recorder failed code=fact_store_unavailable type=%s",
                type(store_exc).__name__,
            )
        raise

    event = _success_event(
        result=result,
        context=context,
        started_at=started_at,
        completed_at=datetime.now(timezone.utc),
        started_clock=started_clock,
    )
    try:
        await store.record_async(event)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[LLM FACTS] async recorder failed code=fact_store_unavailable type=%s",
            type(exc).__name__,
        )
    return result


def observe_llm_call_sync(
    store: LLMCallFactStore,
    operation: Callable[[], Any],
    context: LLMCallFactContext,
) -> Any:
    """Execute one sync gateway operation and record its content-free facts."""

    started_at = datetime.now(timezone.utc)
    started_clock = time.perf_counter()
    try:
        result = operation()
    except Exception as exc:
        event = _error_event(
            context=context,
            started_at=started_at,
            completed_at=datetime.now(timezone.utc),
            started_clock=started_clock,
            exc=exc,
        )
        try:
            store.record_sync(event)
        except Exception as store_exc:  # noqa: BLE001
            logger.warning(
                "[LLM FACTS] sync recorder failed code=fact_store_unavailable type=%s",
                type(store_exc).__name__,
            )
        raise

    event = _success_event(
        result=result,
        context=context,
        started_at=started_at,
        completed_at=datetime.now(timezone.utc),
        started_clock=started_clock,
    )
    try:
        store.record_sync(event)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[LLM FACTS] sync recorder failed code=fact_store_unavailable type=%s",
            type(exc).__name__,
        )
    return result


__all__ = [
    "LLMCallFactContext",
    "LLMCallFactEvent",
    "LLMCallFactStore",
    "observe_llm_call_async",
    "observe_llm_call_sync",
    "safe_error_code",
]

"""Retry with exponential backoff — async and sync flavors.

Replaces the half-dozen ad-hoc retry loops scattered across
audio_transcriber, stt_http_transcriber, llm_helpers, local_llm_client,
file_transcriber, and import_bulk_pipeline. Each had its own backoff
curve, jitter policy, and classifier — making "is this error
retryable?" inconsistent across the codebase.

Both functions take an `is_retryable` callable so each subsystem can
keep its existing error-class logic (e.g. ``_is_retryable_stt_error``,
``_is_retryable_import_failure``) and pass it in. The policy here is
purely about *how* to retry, not *what* to retry.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Awaitable, Callable, Optional, TypeVar

logger = logging.getLogger("lct_backend")

T = TypeVar("T")

# A classifier always-retryable / never-retryable for convenience.
RETRY_ALWAYS: Callable[[BaseException], bool] = lambda _exc: True
RETRY_NEVER: Callable[[BaseException], bool] = lambda _exc: False


def compute_backoff_delay(
    attempt: int,
    *,
    base_delay_s: float,
    backoff_factor: float,
    jitter: bool,
    max_delay_s: Optional[float] = None,
) -> float:
    """Compute the delay before the *next* attempt.

    Pure function so call-site retry loops and tests stay deterministic
    when `jitter=False` and don't have to mock time.
    """
    if attempt < 1:
        return 0.0
    delay = base_delay_s * (backoff_factor ** (attempt - 1))
    if jitter:
        delay += random.uniform(0.0, base_delay_s)
    if max_delay_s is not None:
        delay = min(delay, max_delay_s)
    return max(0.0, delay)


async def retry_async_with_backoff(
    coro_factory: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 3,
    base_delay_s: float = 0.5,
    backoff_factor: float = 2.0,
    max_delay_s: Optional[float] = None,
    jitter: bool = False,
    is_retryable: Callable[[BaseException], bool] = RETRY_ALWAYS,
    on_retry: Optional[Callable[[int, BaseException, float], None]] = None,
    sleeper: Optional[Callable[[float], Awaitable[None]]] = None,
) -> T:
    """Run an async operation up to *max_attempts* times with backoff.

    Parameters
    ----------
    coro_factory:
        Zero-arg callable returning a fresh awaitable each call. Must
        be a factory, not a single coroutine, because awaiting a
        coroutine consumes it.
    is_retryable:
        Decides whether a particular exception should trigger another
        attempt. Defaults to always-retry. Pass your subsystem's
        existing classifier here.
    on_retry:
        Optional callback invoked before each sleep:
        ``on_retry(attempt_just_failed, exc, delay_before_next)``.
        Use for logging / telemetry without coupling this module to
        either.
    sleeper:
        Test seam — defaults to ``asyncio.sleep``.

    Raises the final exception when attempts are exhausted or when
    ``is_retryable(exc)`` is False.
    """
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    actual_sleeper = sleeper or asyncio.sleep
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await coro_factory()
        except BaseException as exc:  # noqa: BLE001 — by design, classifier decides
            last_exc = exc
            if attempt >= max_attempts or not is_retryable(exc):
                raise
            delay = compute_backoff_delay(
                attempt,
                base_delay_s=base_delay_s,
                backoff_factor=backoff_factor,
                jitter=jitter,
                max_delay_s=max_delay_s,
            )
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            if delay > 0:
                await actual_sleeper(delay)
    # Unreachable — guarded above — but keep for type-checkers.
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("retry_async_with_backoff exhausted with no exception")


def retry_sync_with_backoff(
    fn: Callable[[], T],
    *,
    max_attempts: int = 3,
    base_delay_s: float = 0.5,
    backoff_factor: float = 2.0,
    max_delay_s: Optional[float] = None,
    jitter: bool = False,
    is_retryable: Callable[[BaseException], bool] = RETRY_ALWAYS,
    on_retry: Optional[Callable[[int, BaseException, float], None]] = None,
    sleeper: Optional[Callable[[float], None]] = None,
) -> T:
    """Synchronous counterpart of ``retry_async_with_backoff``."""
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    actual_sleeper = sleeper or time.sleep
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001
            last_exc = exc
            if attempt >= max_attempts or not is_retryable(exc):
                raise
            delay = compute_backoff_delay(
                attempt,
                base_delay_s=base_delay_s,
                backoff_factor=backoff_factor,
                jitter=jitter,
                max_delay_s=max_delay_s,
            )
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            if delay > 0:
                actual_sleeper(delay)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("retry_sync_with_backoff exhausted with no exception")

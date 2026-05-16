"""Tests for retry_policy — pins the contract for retry consolidation."""

from __future__ import annotations

import asyncio
from typing import List

import pytest

from lct_python_backend.services.retry_policy import (
    compute_backoff_delay,
    retry_async_with_backoff,
    retry_sync_with_backoff,
)


# ---------------------------------------------------------------------------
# compute_backoff_delay
# ---------------------------------------------------------------------------


def test_exponential_growth_no_jitter() -> None:
    delays = [
        compute_backoff_delay(n, base_delay_s=1.0, backoff_factor=2.0, jitter=False)
        for n in range(1, 5)
    ]
    assert delays == [1.0, 2.0, 4.0, 8.0]


def test_max_delay_cap() -> None:
    delays = [
        compute_backoff_delay(n, base_delay_s=1.0, backoff_factor=2.0, jitter=False, max_delay_s=3.0)
        for n in range(1, 6)
    ]
    assert delays == [1.0, 2.0, 3.0, 3.0, 3.0]


def test_attempt_zero_is_zero_delay() -> None:
    assert compute_backoff_delay(0, base_delay_s=1.0, backoff_factor=2.0, jitter=False) == 0.0


def test_jitter_in_range() -> None:
    # With jitter the delay is in [base * factor^(n-1), base * factor^(n-1) + base].
    for _ in range(50):
        delay = compute_backoff_delay(2, base_delay_s=1.0, backoff_factor=2.0, jitter=True)
        assert 2.0 <= delay <= 3.0


# ---------------------------------------------------------------------------
# retry_async_with_backoff
# ---------------------------------------------------------------------------


def _zero_sleeper_factory(seen: List[float]):
    async def _sleeper(d: float) -> None:
        seen.append(d)
    return _sleeper


def test_async_success_first_try() -> None:
    calls: List[int] = []

    async def op():
        calls.append(1)
        return "ok"

    result = asyncio.run(
        retry_async_with_backoff(op, max_attempts=3, base_delay_s=0.01, sleeper=_zero_sleeper_factory([]))
    )
    assert result == "ok"
    assert len(calls) == 1


def test_async_recovers_after_one_failure() -> None:
    calls: List[int] = []
    sleeps: List[float] = []

    async def op():
        calls.append(1)
        if len(calls) == 1:
            raise ValueError("transient")
        return "ok"

    result = asyncio.run(
        retry_async_with_backoff(
            op,
            max_attempts=3,
            base_delay_s=0.5,
            sleeper=_zero_sleeper_factory(sleeps),
        )
    )
    assert result == "ok"
    assert len(calls) == 2
    assert sleeps == [0.5]


def test_async_exhausts_retries_raises_last() -> None:
    calls: List[int] = []

    async def op():
        calls.append(1)
        raise RuntimeError(f"fail{len(calls)}")

    with pytest.raises(RuntimeError, match="fail3"):
        asyncio.run(
            retry_async_with_backoff(
                op, max_attempts=3, base_delay_s=0.01, sleeper=_zero_sleeper_factory([])
            )
        )
    assert len(calls) == 3


def test_async_non_retryable_breaks_immediately() -> None:
    calls: List[int] = []

    async def op():
        calls.append(1)
        raise ValueError("nope")

    def is_retryable(exc: BaseException) -> bool:
        return not isinstance(exc, ValueError)

    with pytest.raises(ValueError):
        asyncio.run(
            retry_async_with_backoff(
                op,
                max_attempts=5,
                base_delay_s=0.01,
                is_retryable=is_retryable,
                sleeper=_zero_sleeper_factory([]),
            )
        )
    assert len(calls) == 1


def test_async_on_retry_called_with_attempt_and_delay() -> None:
    log: List[tuple] = []

    async def op():
        if len(log) < 1:
            log.append(("op_fail",))
            raise RuntimeError("transient")
        return "ok"

    def on_retry(attempt: int, exc: BaseException, delay: float) -> None:
        log.append(("retry", attempt, str(exc), delay))

    asyncio.run(
        retry_async_with_backoff(
            op,
            max_attempts=3,
            base_delay_s=0.25,
            sleeper=_zero_sleeper_factory([]),
            on_retry=on_retry,
        )
    )
    assert log[1] == ("retry", 1, "transient", 0.25)


def test_max_attempts_zero_is_rejected() -> None:
    async def op():
        return "ok"

    with pytest.raises(ValueError):
        asyncio.run(retry_async_with_backoff(op, max_attempts=0))


# ---------------------------------------------------------------------------
# retry_sync_with_backoff
# ---------------------------------------------------------------------------


def test_sync_success_first_try() -> None:
    sleeps: List[float] = []
    result = retry_sync_with_backoff(
        lambda: "ok", max_attempts=3, base_delay_s=0.01, sleeper=lambda d: sleeps.append(d)
    )
    assert result == "ok"
    assert sleeps == []


def test_sync_recovers_after_failures() -> None:
    attempts: List[int] = []
    sleeps: List[float] = []

    def op() -> str:
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("transient")
        return "ok"

    result = retry_sync_with_backoff(
        op,
        max_attempts=3,
        base_delay_s=0.5,
        backoff_factor=2.0,
        sleeper=lambda d: sleeps.append(d),
    )
    assert result == "ok"
    assert len(attempts) == 3
    assert sleeps == [0.5, 1.0]


def test_sync_exhausts_and_raises() -> None:
    def op() -> str:
        raise RuntimeError("always fails")

    with pytest.raises(RuntimeError, match="always fails"):
        retry_sync_with_backoff(op, max_attempts=2, base_delay_s=0.01, sleeper=lambda _: None)

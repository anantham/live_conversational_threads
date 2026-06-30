"""Tests for the STT circuit breaker — pin the state-transition contract."""

from __future__ import annotations

import time
from unittest.mock import patch

import httpx
import pytest

from lct_python_backend.services.stt.stt_circuit_breaker import (
    CircuitBreaker,
    candidate_cache_key,
    circuit_ttl_seconds,
    classify_http_status,
    summarize_exception,
)


def _candidate(provider: str = "openai", transport: str = "openai_audio", url: str = "https://api.openai.com/v1/audio") -> dict:
    return {"provider": provider, "transport": transport, "http_url": url}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_cache_key_is_case_insensitive() -> None:
    a = candidate_cache_key(_candidate("OpenAI", "OPENAI_audio", "HTTPS://A"))
    b = candidate_cache_key(_candidate("openai", "openai_audio", "https://a"))
    assert a == b


@pytest.mark.parametrize("error_type,expected_positive", [
    ("auth_failed", True),
    ("rate_limited", True),
    ("quota_exceeded", True),
    ("timeout", True),
    ("network_error", True),
    ("provider_error", True),
    ("not_found", True),
    ("unknown_kind", False),
    ("", False),
])
def test_ttl_routes_per_error_class(error_type: str, expected_positive: bool) -> None:
    ttl = circuit_ttl_seconds(error_type)
    if expected_positive:
        assert ttl > 0
    else:
        assert ttl == 0


@pytest.mark.parametrize("code,body,expected", [
    (401, "", "auth_failed"),
    (403, "", "auth_failed"),
    (429, "rate limit", "rate_limited"),
    (429, "insufficient_quota", "quota_exceeded"),
    (429, "billing", "quota_exceeded"),
    (400, "invalid_api_key", "auth_failed"),
    (400, "other body", "bad_request"),
    (404, "", "not_found"),
    (408, "", "timeout"),
    (500, "", "provider_error"),
    (502, "", "provider_error"),
])
def test_classify_http_status(code: int, body: str, expected: str) -> None:
    assert classify_http_status(code, body) == expected


def test_summarize_timeout() -> None:
    summary = summarize_exception(httpx.TimeoutException("read timeout"))
    assert summary["error_type"] == "timeout"
    assert summary["status_code"] is None
    assert "timeout" in summary["detail"].lower()


def test_summarize_network() -> None:
    summary = summarize_exception(httpx.ConnectError("connection refused"))
    assert summary["error_type"] == "network_error"
    assert summary["status_code"] is None


def test_summarize_generic_exception() -> None:
    summary = summarize_exception(RuntimeError("kaboom"))
    assert summary["error_type"] == "provider_error"
    assert "kaboom" in summary["detail"]


# ---------------------------------------------------------------------------
# CircuitBreaker
# ---------------------------------------------------------------------------


def test_state_for_returns_none_when_never_marked() -> None:
    cb = CircuitBreaker()
    assert cb.state_for(_candidate()) is None


def test_mark_then_state_for_returns_state() -> None:
    cb = CircuitBreaker()
    cand = _candidate()
    cb.mark_failure(cand, error_type="timeout", detail="read timeout", latency_ms=30000.0)
    state = cb.state_for(cand)
    assert state is not None
    assert state["error_type"] == "timeout"
    assert state["detail"] == "read timeout"
    assert state["latency_ms"] == 30000.0


def test_clear_removes_state() -> None:
    cb = CircuitBreaker()
    cand = _candidate()
    cb.mark_failure(cand, error_type="timeout", detail="x", latency_ms=0.0)
    cb.clear(cand)
    assert cb.state_for(cand) is None


def test_expired_state_evicted_on_check() -> None:
    cb = CircuitBreaker()
    cand = _candidate()
    cb.mark_failure(cand, error_type="timeout", detail="x", latency_ms=0.0)

    # Fast-forward monotonic clock past the TTL
    state = cb._state[candidate_cache_key(cand)]
    state["until_monotonic"] = time.monotonic() - 1.0

    assert cb.state_for(cand) is None
    assert candidate_cache_key(cand) not in cb._state, "expired key should be evicted"


def test_unknown_error_type_does_not_open_breaker() -> None:
    cb = CircuitBreaker()
    cand = _candidate()
    cb.mark_failure(cand, error_type="bogus_kind", detail="x", latency_ms=0.0)
    # circuit_ttl_seconds returns 0 for unknown error_type → no state stored
    assert cb.state_for(cand) is None


def test_two_candidates_isolated() -> None:
    cb = CircuitBreaker()
    a = _candidate(provider="openai", url="https://a")
    b = _candidate(provider="whisperx", url="https://b")
    cb.mark_failure(a, error_type="timeout", detail="t", latency_ms=0.0)
    assert cb.state_for(a) is not None
    assert cb.state_for(b) is None


def test_disabled_breaker_no_ops(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "lct_python_backend.services.stt.stt_circuit_breaker.STT_CIRCUIT_BREAKER_ENABLED",
        False,
    )
    cb = CircuitBreaker()
    cand = _candidate()
    cb.mark_failure(cand, error_type="timeout", detail="x", latency_ms=0.0)
    assert cb.state_for(cand) is None

"""Tests for the M5-fuzzy live-prayer trigger detector (LLM mocked)."""

import pytest

from lct_python_backend.services.live_prayer import detector
from lct_python_backend.services.live_prayer.detector import DetectedTrigger


def _mock_llm(monkeypatch, response):
    async def fake_call_json(*a, **k):
        return dict(response)
    monkeypatch.setattr(detector._llm, "call_json", fake_call_json)


@pytest.mark.asyncio
async def test_pregate_skips_trivial_without_waking_llm(monkeypatch):
    calls = {"n": 0}

    async def fake(*a, **k):
        calls["n"] += 1
        return {}
    monkeypatch.setattr(detector._llm, "call_json", fake)

    assert await detector.detect("yeah") is None      # 1 word
    assert await detector.detect("ok sure") is None    # < 12 chars
    assert await detector.detect("mm") is None
    # Trivial fillers never wake the LLM.
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_garbled_fetch_fires(monkeypatch):
    # STT garbled "fetch" → "vetch"; the LLM (mocked) recognizes it.
    _mock_llm(monkeypatch, {"type": "fetch", "query": "the vesting schedule", "confidence": 0.9})
    t = await detector.detect("hey can you vetch up the vesting schedule for me")
    assert isinstance(t, DetectedTrigger)
    assert t.type == "fetch"
    assert t.query == "the vesting schedule"


@pytest.mark.asyncio
async def test_garbled_factcheck_fires(monkeypatch):
    _mock_llm(monkeypatch, {"type": "factcheck", "query": "the moon has no atmosphere", "confidence": 0.8})
    t = await detector.detect("wait vact check that the moon has no atmosphere")
    assert t.type == "factcheck"
    assert "moon" in t.query


@pytest.mark.asyncio
async def test_plain_question_does_not_fire(monkeypatch):
    # Substantive (wakes LLM) but no command → LLM returns none → no trigger.
    _mock_llm(monkeypatch, {"type": "none", "query": "", "confidence": 0.0})
    assert await detector.detect("so what do you think we should do about the budget") is None


@pytest.mark.asyncio
async def test_below_confidence_dropped(monkeypatch):
    _mock_llm(monkeypatch, {"type": "fetch", "query": "something", "confidence": 0.3})
    assert await detector.detect("maybe fetch something or other i guess") is None


@pytest.mark.asyncio
async def test_empty_query_dropped(monkeypatch):
    _mock_llm(monkeypatch, {"type": "fetch", "query": "", "confidence": 0.95})
    assert await detector.detect("please fetch that thing right now") is None


@pytest.mark.asyncio
async def test_invalid_type_dropped(monkeypatch):
    _mock_llm(monkeypatch, {"type": "remind", "query": "x", "confidence": 0.95})
    assert await detector.detect("remind me to call the bank tomorrow") is None

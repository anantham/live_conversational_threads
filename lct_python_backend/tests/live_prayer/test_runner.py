"""Tests for the live-prayer runner (detect -> execute -> prayer_card WS event)."""

import pytest

from lct_python_backend.services.live_prayer import runner
from lct_python_backend.services.live_prayer.detector import DetectedTrigger
from lct_python_backend.services.live_prayer.runner import (
    LivePrayerDeduper,
    run_for_segment,
    should_run,
)


def _capture():
    sent = []

    def send(payload):
        sent.append(payload)
    return sent, send


def _detect(t):
    async def fake(_text):
        return t
    return fake


class TestShouldRun:
    def test_off_by_default(self, monkeypatch):
        monkeypatch.delenv("LIVE_PRAYER_CARDS_ENABLED", raising=False)
        assert should_run() is False

    def test_on_when_flagged(self, monkeypatch):
        monkeypatch.setenv("LIVE_PRAYER_CARDS_ENABLED", "1")
        assert should_run() is True


class TestRunForSegment:
    @pytest.mark.asyncio
    async def test_no_trigger_no_card(self):
        sent, send = _capture()

        async def no_trigger(_t):
            return None
        out = await run_for_segment(
            segment_text="hello there", conversation_id="c", session_id="s",
            participants=None, deduper=LivePrayerDeduper(), send_ws_event=send,
            detect_fn=no_trigger,
        )
        assert out is None
        assert sent == []

    @pytest.mark.asyncio
    async def test_fetch_emits_card_with_results(self):
        sent, send = _capture()
        trig = DetectedTrigger("fetch", "vesting schedule", 0.9, "fetch the vesting schedule")

        async def fake_fetch(query, conv, sess, parts):
            return {"results": [{"title": "Vesting doc", "snippet": "4-year vest"}],
                    "title": "Fetch results", "indrasnet_decision": {"urgency": "now"}}
        out = await run_for_segment(
            segment_text="fetch the vesting schedule", conversation_id="c", session_id="s",
            participants=None, deduper=LivePrayerDeduper(), send_ws_event=send,
            detect_fn=_detect(trig), fetch_fn=fake_fetch,
        )
        assert out["type"] == "prayer_card"
        assert out["card_type"] == "fetch"
        assert out["status"] == "executed"
        assert out["results"][0]["title"] == "Vesting doc"
        assert sent and sent[0]["card_id"].startswith("fetch_")

    @pytest.mark.asyncio
    async def test_factcheck_emits_verdict_card(self):
        sent, send = _capture()
        trig = DetectedTrigger("factcheck", "the moon has no atmosphere", 0.8, "fact check that")

        async def fake_fc(query):
            return {"claim": query, "verdict": "PARTLY", "confidence": 0.7,
                    "grounding": "model_knowledge", "reason": "thin exosphere", "evidence": []}
        out = await run_for_segment(
            segment_text="fact check that the moon has no atmosphere", conversation_id="c",
            session_id="s", participants=None, deduper=LivePrayerDeduper(), send_ws_event=send,
            detect_fn=_detect(trig), factcheck_fn=fake_fc,
        )
        assert out["card_type"] == "factcheck"
        assert out["verdict"]["verdict"] == "PARTLY"
        assert out["verdict"]["grounding"] == "model_knowledge"

    @pytest.mark.asyncio
    async def test_dedupe_suppresses_repeat(self):
        sent, send = _capture()
        trig = DetectedTrigger("fetch", "same thing", 0.9, "fetch same thing")
        dd = LivePrayerDeduper()

        async def fake_fetch(q, c, s, p):
            return {"results": [], "title": "Fetch results"}
        kw = dict(conversation_id="c", session_id="s", participants=None, deduper=dd,
                  send_ws_event=send, detect_fn=_detect(trig), fetch_fn=fake_fetch)
        first = await run_for_segment(segment_text="fetch same thing", **kw)
        second = await run_for_segment(segment_text="fetch same thing", **kw)
        assert first is not None
        assert second is None  # deduped within the window
        assert len(sent) == 1

    @pytest.mark.asyncio
    async def test_execute_error_still_emits_error_card(self):
        sent, send = _capture()
        trig = DetectedTrigger("fetch", "boom", 0.9, "fetch boom")

        async def boom_fetch(*a, **k):
            raise RuntimeError("indrasnet down")
        out = await run_for_segment(
            segment_text="fetch boom please", conversation_id="c", session_id="s",
            participants=None, deduper=LivePrayerDeduper(), send_ws_event=send,
            detect_fn=_detect(trig), fetch_fn=boom_fetch,
        )
        assert out["status"] == "error"
        assert out["error"] == "RuntimeError"
        assert sent and sent[0]["status"] == "error"

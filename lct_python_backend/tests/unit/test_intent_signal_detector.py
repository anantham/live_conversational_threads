"""Unit tests for ADR-013 live intent-signal detection.

Test intent:
- Detector accepts both raw JSON arrays and {"signals": [...]} wrappers.
- LLM/parse failures are returned as errors, never raised.
- Pregate skips short segments before calling the LLM.
"""

from types import SimpleNamespace

import pytest

from lct_python_backend.services import intent_signal_detector as detector


def _provider_result(data):
    return SimpleNamespace(
        data=data,
        model="qwen3-32b",
        provider_id="local_lmstudio",
    )


@pytest.mark.asyncio
async def test_detects_valid_json_array(monkeypatch):
    async def fake_chat(*args, **kwargs):
        return _provider_result(
            """
            [
              {
                "raw_text": "I keep noticing this pattern and I do not know what it is yet",
                "context_summary": "The speaker is gesturing at a recurring structure before naming it.",
                "speaker_id": "SPEAKER_00",
                "source_utterance_refs": ["utterance_0"],
                "detection_confidence": 0.84,
                "is_new": true,
                "existing_signal_match": null
              }
            ]
            """
        )

    monkeypatch.setattr(detector, "_MIN_SEGMENT_CHARS", 10)
    monkeypatch.setattr(detector, "chat_with_provider_fallback", fake_chat)

    result = await detector.detect_intent_signals_for_segment(
        segment_text="I keep noticing this pattern and I do not know what it is yet.",
        providers=[{"id": "local_lmstudio", "enabled": True}],
    )

    assert result.error is None
    assert result.raw_count == 1
    assert len(result.validated_items) == 1
    assert result.validated_items[0]["source_utterance_refs"] == ["utterance_0"]
    assert result.detection_model == "qwen3-32b"


@pytest.mark.asyncio
async def test_detects_signals_wrapper(monkeypatch):
    async def fake_chat(*args, **kwargs):
        return _provider_result(
            {
                "signals": [
                    {
                        "raw_text": "There is something here about incentives that I cannot name",
                        "context_summary": "The speaker marks an unresolved conceptual pattern.",
                        "speaker_id": "unknown",
                        "source_utterance_refs": ["utterance_0"],
                        "detection_confidence": 0.7,
                        "is_new": True,
                        "existing_signal_match": None,
                    }
                ]
            }
        )

    monkeypatch.setattr(detector, "_MIN_SEGMENT_CHARS", 10)
    monkeypatch.setattr(detector, "chat_with_provider_fallback", fake_chat)

    result = await detector.detect_intent_signals_for_segment(segment_text="There is something here about incentives that I cannot name.")

    assert result.raw_count == 1
    assert len(result.validated_items) == 1


@pytest.mark.asyncio
async def test_short_segment_skips_llm(monkeypatch):
    called = False

    async def fake_chat(*args, **kwargs):
        nonlocal called
        called = True
        return _provider_result("[]")

    monkeypatch.setattr(detector, "_MIN_SEGMENT_CHARS", 100)
    monkeypatch.setattr(detector, "chat_with_provider_fallback", fake_chat)

    result = await detector.detect_intent_signals_for_segment(segment_text="too short")

    assert called is False
    assert result.raw_count == 0
    assert result.validated_items == []


@pytest.mark.asyncio
async def test_llm_failure_returns_error(monkeypatch):
    async def fake_chat(*args, **kwargs):
        raise RuntimeError("model offline")

    monkeypatch.setattr(detector, "_MIN_SEGMENT_CHARS", 10)
    monkeypatch.setattr(detector, "chat_with_provider_fallback", fake_chat)

    result = await detector.detect_intent_signals_for_segment(
        segment_text="I keep noticing this pattern and I do not know what it is yet."
    )

    assert result.error
    assert "model offline" in result.error
    assert result.validated_items == []

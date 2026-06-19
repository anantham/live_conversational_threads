"""Tests for local hybrid fact-check (retrieval + M5, both mocked)."""

import pytest

from lct_python_backend.services.live_prayer import factcheck


def _mock_llm(monkeypatch, response):
    async def fake_call_json(*a, **k):
        return dict(response)
    monkeypatch.setattr(factcheck._llm, "call_json", fake_call_json)


async def _retrieval_with_evidence(query):
    return {"results": [
        {"content": "We agreed the launch is in March.", "source_type": "transcript",
         "source_timestamp": "2025-02-01", "final_score": 0.9},
    ]}


async def _retrieval_empty(query):
    return {"results": []}


async def _retrieval_boom(query):
    raise RuntimeError("IndrasNet down")


@pytest.mark.asyncio
async def test_grounded_when_evidence_and_model_agrees(monkeypatch):
    _mock_llm(monkeypatch, {"verdict": "SUPPORTED", "confidence": 0.9, "grounding": "grounded", "reason": "matches note"})
    out = await factcheck.factcheck("the launch is in March", retrieval_fn=_retrieval_with_evidence)
    assert out["verdict"] == "SUPPORTED"
    assert out["grounding"] == "grounded"
    assert out["evidence"]  # citations carried


@pytest.mark.asyncio
async def test_no_evidence_forced_model_knowledge(monkeypatch):
    # Even if the model claims 'grounded', no evidence retrieved → must be downgraded.
    _mock_llm(monkeypatch, {"verdict": "SUPPORTED", "confidence": 0.7, "grounding": "grounded", "reason": "i think so"})
    out = await factcheck.factcheck("water boils at 100C at sea level", retrieval_fn=_retrieval_empty)
    assert out["grounding"] == "model_knowledge"
    assert out["evidence"] == []


@pytest.mark.asyncio
async def test_retrieval_failure_degrades_to_model_knowledge(monkeypatch):
    _mock_llm(monkeypatch, {"verdict": "REFUTED", "confidence": 0.6, "grounding": "model_knowledge", "reason": "no"})
    out = await factcheck.factcheck("the earth is flat", retrieval_fn=_retrieval_boom)
    assert out["verdict"] == "REFUTED"
    assert out["grounding"] == "model_knowledge"


@pytest.mark.asyncio
async def test_bad_verdict_normalized(monkeypatch):
    _mock_llm(monkeypatch, {"verdict": "probably true", "confidence": 0.5, "grounding": "model_knowledge"})
    out = await factcheck.factcheck("some claim", retrieval_fn=_retrieval_empty)
    assert out["verdict"] == "UNVERIFIABLE"

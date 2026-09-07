"""Test intent for shared source-backed abstraction, not model-quality claims.

- Every child reaches the request with its verbatim underlying source.
- Overlapping and distant memberships survive; no nearest-neighbor adoption.
- Foreign/omitted children and invented or misattributed quotes reject output.
- Full request budget is enforced before inference; input remains immutable.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.source_backed_aggregation import (
    AGGREGATION_SYSTEM_PROMPT, aggregate_source_backed, build_aggregation_request, validate_aggregation,
)
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded


def fixture():
    sources = {
        "u1": {"id": "u1", "sequence_number": 1, "speaker_id": "A", "text": "Who keeps the spare key?"},
        "u2": {"id": "u2", "sequence_number": 2, "speaker_id": "B", "text": "Venus is bright tonight."},
        "u3": {"id": "u3", "sequence_number": 90, "speaker_id": "A", "text": "Returning to the key: Sam keeps it."},
    }
    nodes = [{"id": "n1", "semantic_level": 1, "utterance_ids": ["u1"], "thread_id": "keys"},
             {"id": "n2", "semantic_level": 1, "utterance_ids": ["u2"], "thread_id": "sky"},
             {"id": "n3", "semantic_level": 1, "utterance_ids": ["u3"], "thread_id": "keys"}]
    return nodes, sources


def output():
    return {"nodes": [
        {"node_name": "Key custody", "summary": "Sam keeps the spare key.",
         "children_ids": ["n1", "n3"], "membership_evidence": [
             {"child_id": "n1", "utterance_id": "u1", "quote": "Who keeps the spare key?"},
             {"child_id": "n3", "utterance_id": "u3", "quote": "Sam keeps it."}]},
        {"node_name": "Night sky", "summary": "Venus is bright.",
         "children_ids": ["n2"], "membership_evidence": [
             {"child_id": "n2", "utterance_id": "u2", "quote": "Venus is bright tonight."}]},
    ]}


def test_request_retains_distant_verbatim_sources_and_source_attribution():
    nodes, sources = fixture()
    before = copy.deepcopy((nodes, sources))
    request = build_aggregation_request(nodes, sources, target_level=2)
    assert json.loads(json.dumps(request))["sources"] == list(sources.values())
    assert request["children"][2]["utterance_ids"] == ["u3"]
    assert (nodes, sources) == before


def test_distant_children_and_overlapping_memberships_are_preserved():
    nodes, sources = fixture()
    payload = output()
    payload["nodes"].append({"node_name": "A later answer", "summary": "A question receives an answer.",
        "children_ids": ["n3"], "membership_evidence": [
            {"child_id": "n3", "utterance_id": "u3", "quote": "Returning to the key"}]})
    parents = validate_aggregation(payload, build_aggregation_request(nodes, sources, target_level=2))
    assert parents[0]["children_ids"] == ["n1", "n3"]
    assert parents[2]["children_ids"] == ["n3"]
    assert parents[0]["utterance_ids"] == ["u1", "u3"]
    assert parents[0]["thread_id"] == "keys"
    assert parents[1]["thread_id"] == "sky"
    # The next abstraction sees original source, not only this summary.
    higher = build_aggregation_request(parents, sources, target_level=3)
    assert higher["sources"] == list(sources.values())


@pytest.mark.parametrize("fault", ["omitted", "foreign", "invented_quote", "wrong_source", "duplicate_child"])
def test_invalid_membership_is_rejected_not_repaired(fault):
    nodes, sources = fixture()
    payload = output()
    if fault == "omitted":
        payload["nodes"].pop()
    elif fault == "foreign":
        payload["nodes"][0]["children_ids"].append("outside-conversation")
    elif fault == "invented_quote":
        payload["nodes"][0]["membership_evidence"][0]["quote"] = "Sam has always owned the key."
    elif fault == "wrong_source":
        payload["nodes"][0]["membership_evidence"][0].update(utterance_id="u2", quote="Venus is bright tonight.")
    else:
        payload["nodes"][0]["children_ids"].append("n1")
    with pytest.raises(ValueError):
        validate_aggregation(payload, build_aggregation_request(nodes, sources, target_level=2))


def test_missing_source_and_wrong_tier_fail_before_generation():
    nodes, sources = fixture()
    with pytest.raises(ValueError, match="source"):
        build_aggregation_request(nodes, {"u1": sources["u1"]}, target_level=2)
    with pytest.raises(ValueError, match="tier"):
        build_aggregation_request(nodes, sources, target_level=3)


@pytest.mark.asyncio
async def test_aggregation_uses_budgeted_raw_source_request_without_legacy_normalization(monkeypatch):
    nodes, sources = fixture()
    calls = []
    class Result:
        data = output()
    def call(**kwargs):
        calls.append(kwargs)
        return Result()
    monkeypatch.setattr("lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync", call)
    envelope = InferenceEnvelope(system_prompt=AGGREGATION_SYSTEM_PROMPT,
        providers=[{"id": "local", "model": "synthetic", "base_url": "http://127.0.0.1:11434",
                    "type": "openai_compatible", "trust_scope": "owner_private", "context_tokens": 8000}],
        privacy={"local_llm_ok": True}, output_tokens=1000, headroom_tokens=512)
    parents = await aggregate_source_backed(nodes, sources, target_level=2, envelope=envelope)
    assert parents[0]["membership_evidence"] == output()["nodes"][0]["membership_evidence"]
    assert len(calls) == 1
    sent = json.loads(calls[0]["messages"][1]["content"])
    assert sent["sources"] == list(sources.values())
    assert calls[0]["messages"][0]["content"] == AGGREGATION_SYSTEM_PROMPT
    sources["u1"]["text"] *= 1000
    with pytest.raises(ContextBudgetExceeded):
        await aggregate_source_backed(nodes, sources, target_level=2, envelope=envelope)
    assert len(calls) == 1, "Oversized source cannot silently fall back to summaries"

"""Tests for claim extraction (self-contained claims + supports/contradicts/depends_on).

Pure helpers are tested directly; the DB orchestration is tested with a stubbed
LLM + a fake async session, so no database or model server is required.
"""

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from lct_python_backend.models import Node
from lct_python_backend.models.analysis import Claim
from lct_python_backend.services import claim_extractor
from lct_python_backend.services.claim_extractor import (
    ClaimExtractor,
    build_extraction_inputs,
    parse_claim_response,
)


class FakeNode:
    def __init__(self, name, summary="", conversation_id=None, utterance_ids=None):
        self.id = uuid.uuid4()
        self.node_name = name
        self.summary = summary
        self.conversation_id = conversation_id or uuid.uuid4()
        self.utterance_ids = utterance_ids or []


# ── build_extraction_inputs ──────────────────────────────────────────────────

def test_build_inputs_lists_nodes():
    n1 = FakeNode("Privacy is a trust problem", "trust across time")
    n2 = FakeNode("Privacy is infrastructural", "who reads the bytes")
    count, nodes_block = build_extraction_inputs([n1, n2])
    assert count == 2
    assert str(n1.id) in nodes_block and "Privacy is a trust problem" in nodes_block
    assert str(n2.id) in nodes_block


def test_build_inputs_handles_empty():
    count, nodes_block = build_extraction_inputs([])
    assert count == 0
    assert nodes_block == "(no nodes)"


def test_build_inputs_truncates_long_summary():
    n = FakeNode("X", "y" * 500)
    _, nodes_block = build_extraction_inputs([n])
    assert "…" in nodes_block and len(nodes_block) < 300


# ── parse_claim_response ─────────────────────────────────────────────────────

def test_parse_valid_claims_and_relations():
    claims, relations = parse_claim_response({
        "claims": [
            {"id": 0, "claim_text": "Markets clear efficiently", "claim_type": "worldview",
             "source_node_id": "n1", "speaker_name": "Alice", "strength": 0.8, "confidence": 0.9},
            {"id": 1, "claim_text": "Markets fail under information asymmetry", "claim_type": "factual",
             "source_node_id": "n2", "strength": 0.7, "confidence": 0.6},
        ],
        "relations": [{"from": 1, "to": 0, "type": "contradicts"}],
    })
    assert len(claims) == 2
    assert claims[0]["claim_type"] == "worldview"
    assert claims[1]["speaker_name"] is None
    assert relations == [{"from": 1, "to": 0, "type": "contradicts"}]


def test_parse_defaults_unknown_claim_type():
    claims, _ = parse_claim_response({"claims": [
        {"id": 0, "claim_text": "x", "claim_type": "made_up"},
    ]})
    assert claims[0]["claim_type"] == "factual"


def test_parse_clamps_strength_and_confidence():
    claims, _ = parse_claim_response({"claims": [
        {"id": 0, "claim_text": "x", "strength": 5.0, "confidence": -1.0},
    ]})
    assert claims[0]["strength"] == 1.0
    assert claims[0]["confidence"] == 0.0


def test_parse_drops_relations_with_unresolved_endpoints():
    claims, relations = parse_claim_response({
        "claims": [{"id": 0, "claim_text": "x"}],
        "relations": [
            {"from": 0, "to": 99, "type": "supports"},  # 99 doesn't exist
            {"from": 0, "to": 0, "type": "supports"},   # self-relation
            {"from": 0, "to": 0, "type": "bogus_type"},
        ],
    })
    assert relations == []


def test_parse_drops_duplicate_local_ids():
    claims, _ = parse_claim_response({"claims": [
        {"id": 0, "claim_text": "first"},
        {"id": 0, "claim_text": "duplicate id, dropped"},
    ]})
    assert len(claims) == 1
    assert claims[0]["claim_text"] == "first"


def test_parse_rejects_non_integer_id_rather_than_truncating():
    # int(1.9) == 1 would silently collide claim id 1.9 with claim id 1 —
    # must be dropped, not truncated.
    claims, _ = parse_claim_response({"claims": [
        {"id": 0, "claim_text": "real claim zero"},
        {"id": 1.9, "claim_text": "malformed id, must be dropped"},
    ]})
    assert len(claims) == 1
    assert claims[0]["claim_text"] == "real claim zero"


def test_parse_rejects_non_integer_relation_endpoints():
    claims, relations = parse_claim_response({
        "claims": [{"id": 0, "claim_text": "a"}, {"id": 1, "claim_text": "b"}],
        "relations": [{"from": 0, "to": 1.5, "type": "supports"}],
    })
    assert len(claims) == 2
    assert relations == []


def test_parse_tolerates_garbage():
    assert parse_claim_response(None) == ([], [])
    assert parse_claim_response({}) == ([], [])
    assert parse_claim_response({"claims": "nope"}) == ([], [])
    assert parse_claim_response({"claims": [42, {"no_id": 1}, {"id": 0, "claim_text": ""}]}) == ([], [])


# ── orchestration (stubbed LLM + fake session) ───────────────────────────────

class _FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def all(self):
        return self._items


class _FakeSession:
    """Dispatches select(Node)/select(Claim)/delete(Claim) by target entity; tracks add()/commit()."""

    def __init__(self, node_results):
        self._node_results = node_results
        self._added = []
        self.commits = 0
        self.flushes = 0

    def add(self, obj):
        self._added.append(obj)

    async def flush(self):
        self.flushes += 1

    async def execute(self, stmt):
        kind = type(stmt).__name__
        if kind == "Delete":
            return _FakeResult([])
        entity = stmt.column_descriptions[0]["entity"]
        if entity is Node:
            return _FakeResult(self._node_results)
        if entity is Claim:
            return _FakeResult(list(self._added))
        return _FakeResult([])

    async def commit(self):
        self.commits += 1


def _patch_llm(monkeypatch, response):
    class _DummyPM:
        def render_prompt(self, name, variables):
            return "PROMPT"

    monkeypatch.setattr(claim_extractor, "get_prompt_manager", lambda: _DummyPM())

    async def _fake_providers(_db, **_kw):
        return {"providers": [{"id": "m5_ollama", "base_url": "http://x", "model": "m", "enabled": True}]}

    async def _fake_chat(messages=None, providers=None, **_kw):
        return SimpleNamespace(data=response)

    monkeypatch.setattr(claim_extractor, "load_llm_providers", _fake_providers)
    monkeypatch.setattr(claim_extractor, "chat_with_provider_fallback", _fake_chat)


def test_analyze_persists_claims_and_relations(monkeypatch):
    # Same conversation_id for both nodes — a realistic single-conversation
    # extraction (a prior version of this test gave each node a distinct
    # conversation_id, which the fake session's non-filtering execute() let
    # slide, masking a would-be conversation-scoping regression).
    conversation_id = uuid.uuid4()
    n1 = FakeNode("Markets debate", conversation_id=conversation_id, utterance_ids=[uuid.uuid4()])
    n2 = FakeNode("Information asymmetry", conversation_id=conversation_id, utterance_ids=[uuid.uuid4(), uuid.uuid4()])
    response = {
        "claims": [
            {"id": 0, "claim_text": "Markets clear efficiently", "claim_type": "worldview",
             "source_node_id": str(n1.id), "strength": 0.8, "confidence": 0.9},
            {"id": 1, "claim_text": "Markets fail under information asymmetry", "claim_type": "factual",
             "source_node_id": str(n2.id), "strength": 0.7, "confidence": 0.6},
        ],
        "relations": [{"from": 1, "to": 0, "type": "contradicts"}],
    }
    _patch_llm(monkeypatch, response)

    session = _FakeSession([n1, n2])
    extractor = ClaimExtractor(session)
    result = asyncio.run(extractor.analyze_conversation(str(n1.conversation_id)))

    assert result["claim_count"] == 2
    assert result["relation_count"] == 1
    contradicting = next(c for c in result["claims"] if c["claim_text"].startswith("Markets fail"))
    supported = next(c for c in result["claims"] if c["claim_text"].startswith("Markets clear"))
    assert contradicting["contradicts_claim_ids"] == [supported["id"]]
    # Provenance: each claim inherits its source node's utterance_ids.
    assert set(contradicting["utterance_ids"]) == {str(u) for u in n2.utterance_ids}
    assert set(supported["utterance_ids"]) == {str(u) for u in n1.utterance_ids}
    assert session.commits == 1
    assert session.flushes == 1


def test_analyze_drops_claims_with_unresolved_source_node(monkeypatch):
    n1 = FakeNode("Real node")
    response = {"claims": [
        {"id": 0, "claim_text": "orphaned claim", "source_node_id": str(uuid.uuid4())},  # not in node set
    ], "relations": []}
    _patch_llm(monkeypatch, response)

    session = _FakeSession([n1])
    extractor = ClaimExtractor(session)
    result = asyncio.run(extractor.analyze_conversation(str(n1.conversation_id)))
    assert result["claim_count"] == 0


def test_analyze_empty_conversation(monkeypatch):
    _patch_llm(monkeypatch, {"claims": [], "relations": []})
    session = _FakeSession([])
    extractor = ClaimExtractor(session)
    result = asyncio.run(extractor.analyze_conversation(str(uuid.uuid4())))
    assert result == {"total_nodes": 0, "claim_count": 0, "relation_count": 0, "claims": []}


def test_analyze_llm_failure_does_not_commit(monkeypatch):
    n1 = FakeNode("node")
    _patch_llm(monkeypatch, {"claims": []})

    async def _boom(*_a, **_kw):
        raise RuntimeError("all providers failed")

    monkeypatch.setattr(claim_extractor, "chat_with_provider_fallback", _boom)
    session = _FakeSession([n1])
    extractor = ClaimExtractor(session)
    result = asyncio.run(extractor.analyze_conversation(str(n1.conversation_id)))
    assert "error" in result
    assert session.commits == 0

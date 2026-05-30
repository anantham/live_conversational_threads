"""Tests for crux detection (ADR-035).

Pure helpers are tested directly; the DB orchestration is tested with a stubbed
LLM + a fake async session, so no database or model server is required.
"""

import asyncio
import uuid

import pytest

from lct_python_backend.services import crux_detector
from lct_python_backend.services.crux_detector import (
    CruxDetector,
    build_detection_inputs,
    parse_crux_response,
)


class FakeNode:
    def __init__(self, name, summary="", is_crux=False, display_preferences=None):
        self.id = uuid.uuid4()
        self.node_name = name
        self.summary = summary
        self.is_crux = is_crux
        self.display_preferences = display_preferences
        self.conversation_id = uuid.uuid4()


class FakeRel:
    def __init__(self, frm, to, rtype, explanation=""):
        self.from_node_id = frm
        self.to_node_id = to
        self.relationship_type = rtype
        self.explanation = explanation


# ── build_detection_inputs ───────────────────────────────────────────────────

def test_build_inputs_lists_nodes_and_edges():
    n1 = FakeNode("Privacy is a trust problem", "trust across time")
    n2 = FakeNode("Privacy is infrastructural", "who reads the bytes")
    rels = [FakeRel(n1.id, n2.id, "disagrees", "social vs infra")]
    count, nodes_block, edges_block = build_detection_inputs([n1, n2], rels)
    assert count == 2
    assert str(n1.id) in nodes_block and "Privacy is a trust problem" in nodes_block
    assert "disagrees" in edges_block and str(n2.id) in edges_block


def test_build_inputs_handles_empty():
    count, nodes_block, edges_block = build_detection_inputs([], [])
    assert count == 0
    assert nodes_block == "(no nodes)"
    assert edges_block == "(no agreement/disagreement edges)"


def test_build_inputs_orders_disagreement_edges_first():
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    rels = [FakeRel(a, b, "relates_to"), FakeRel(a, c, "disagrees")]
    _, _, edges_block = build_detection_inputs([], rels)
    lines = edges_block.splitlines()
    assert "disagrees" in lines[0]  # disagreement-relevant edge ranked first


def test_build_inputs_truncates_long_summary():
    n = FakeNode("X", "y" * 500)
    _, nodes_block, _ = build_detection_inputs([n], [])
    assert "…" in nodes_block and len(nodes_block) < 300


# ── parse_crux_response ──────────────────────────────────────────────────────

def test_parse_valid():
    out = parse_crux_response({"cruxes": [
        {"node_id": "abc", "crux_type": "value_crux", "confidence": 0.9, "reason": "r"},
    ]})
    assert out == {"abc": {"crux_type": "value_crux", "confidence": 0.9, "reason": "r"}}


def test_parse_drops_low_confidence():
    out = parse_crux_response({"cruxes": [
        {"node_id": "a", "crux_type": "value_crux", "confidence": 0.4},
        {"node_id": "b", "crux_type": "value_crux", "confidence": 0.51},
    ]})
    assert "a" not in out and "b" in out


def test_parse_defaults_unknown_crux_type():
    out = parse_crux_response({"cruxes": [{"node_id": "a", "crux_type": "made_up", "confidence": 0.8}]})
    assert out["a"]["crux_type"] == "disagreement_pivot"


def test_parse_tolerates_garbage():
    assert parse_crux_response(None) == {}
    assert parse_crux_response({}) == {}
    assert parse_crux_response({"cruxes": "nope"}) == {}
    assert parse_crux_response({"cruxes": [42, {"no_id": 1}, {"node_id": "", "confidence": 0.9}]}) == {}


def test_parse_clamps_confidence():
    out = parse_crux_response({"cruxes": [{"node_id": "a", "confidence": 5.0}]})
    assert out["a"]["confidence"] == 1.0


# ── orchestration (stubbed LLM + fake session) ───────────────────────────────

class _FakeScalars:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


class _FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return _FakeScalars(self._items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


class _FakeSession:
    """Returns queued result sets in order; counts commits."""

    def __init__(self, result_sets):
        self._queue = list(result_sets)
        self.commits = 0

    async def execute(self, _stmt):
        return _FakeResult(self._queue.pop(0) if self._queue else [])

    async def commit(self):
        self.commits += 1


def _patch_llm(monkeypatch, crux_map_response):
    class _DummyPM:
        def render_prompt(self, name, variables):
            return "PROMPT"

    monkeypatch.setattr(crux_detector, "get_prompt_manager", lambda: _DummyPM())

    async def _fake_config(_db):
        return {"mode": "local", "base_url": "http://x", "chat_model": "m"}

    async def _fake_chat(_config, _messages, **_kw):
        return crux_map_response

    monkeypatch.setattr(crux_detector, "load_llm_config", _fake_config)
    monkeypatch.setattr(crux_detector, "local_chat_json", _fake_chat)


def test_analyze_sets_is_crux(monkeypatch):
    n1 = FakeNode("crux node")
    n2 = FakeNode("ordinary node")
    response = {"cruxes": [
        {"node_id": str(n1.id), "crux_type": "disagreement_pivot", "confidence": 0.9, "reason": "load-bearing"},
    ]}
    _patch_llm(monkeypatch, response)

    # execute() is called twice: nodes, then relationships.
    session = _FakeSession([[n1, n2], []])
    detector = CruxDetector(session)
    result = asyncio.run(detector.analyze_conversation(str(n1.conversation_id)))

    assert result["crux_count"] == 1
    assert result["by_type"] == {"disagreement_pivot": 1}
    assert n1.is_crux is True
    assert n2.is_crux is False
    assert n1.display_preferences["crux"]["reason"] == "load-bearing"
    assert "crux" not in (n2.display_preferences or {})
    assert session.commits == 1


def test_analyze_empty_conversation(monkeypatch):
    _patch_llm(monkeypatch, {"cruxes": []})
    session = _FakeSession([[]])  # no nodes
    detector = CruxDetector(session)
    result = asyncio.run(detector.analyze_conversation(str(uuid.uuid4())))
    assert result == {"total_nodes": 0, "crux_count": 0, "by_type": {}, "cruxes": []}


def test_analyze_clears_stale_crux(monkeypatch):
    # node previously a crux; this run returns none -> flag must clear.
    stale = FakeNode("was crux", is_crux=True, display_preferences={"crux": {"crux_type": "value_crux"}})
    _patch_llm(monkeypatch, {"cruxes": []})
    session = _FakeSession([[stale], []])
    detector = CruxDetector(session)
    result = asyncio.run(detector.analyze_conversation(str(stale.conversation_id)))
    assert result["crux_count"] == 0
    assert stale.is_crux is False
    assert "crux" not in stale.display_preferences


def test_analyze_llm_failure_preserves_flags(monkeypatch):
    node = FakeNode("node", is_crux=True, display_preferences={"crux": {"crux_type": "value_crux"}})
    _patch_llm(monkeypatch, {"cruxes": []})

    async def _boom(_config, _messages, **_kw):
        raise RuntimeError("all providers failed")

    monkeypatch.setattr(crux_detector, "local_chat_json", _boom)
    session = _FakeSession([[node], []])
    detector = CruxDetector(session)
    result = asyncio.run(detector.analyze_conversation(str(node.conversation_id)))
    assert "error" in result
    assert node.is_crux is True  # untouched on failure
    assert session.commits == 0

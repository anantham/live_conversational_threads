"""Tests for the post-streaming consolidation pipeline.

The three consolidation passes (ideas→topics, topics→themes, themes→arcs)
each make one LLM call and return parent nodes pointing into the input tier.
These tests mock the LLM and pin down the failure-mode contracts —
empty input, malformed JSON, missing children_ids, and the arcs-pass
title/summary extraction.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest

from lct_python_backend.services import hierarchy_consolidator as hc


@dataclass
class _FakeProviderResult:
    data: Any
    model: str = "gpt-4.1-mini-fake"


class _FakePromptConfig(dict):
    pass


def _install_fake_prompt_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_config = _FakePromptConfig(
        template="system prompt placeholder",
        temperature=0.0,
        max_tokens=4000,
        version="test-v1",
    )

    class _FakeMgr:
        def get_prompt(self, _name: str) -> Dict[str, Any]:
            return fake_config

    monkeypatch.setattr(hc, "get_prompt_manager", lambda: _FakeMgr())


def _install_llm(monkeypatch: pytest.MonkeyPatch, payload: Any, *, raise_exc: Optional[BaseException] = None) -> List[Dict[str, Any]]:
    """Replace the LLM caller. Returns a list that captures the prompt sent."""
    captured: List[Dict[str, Any]] = []

    def _fake_call(*, messages: List[Dict[str, str]], **_kwargs: Any) -> _FakeProviderResult:
        captured.append({"messages": messages, "kwargs": _kwargs})
        if raise_exc is not None:
            raise raise_exc
        return _FakeProviderResult(data=payload)

    monkeypatch.setattr(hc, "chat_with_provider_fallback_sync", _fake_call)
    return captured


def _ideas(n: int) -> List[Dict[str, Any]]:
    return [
        {"id": f"idea-{i}", "node_name": f"Idea {i}", "summary": f"Summary {i}"}
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Empty / under-threshold input
# ---------------------------------------------------------------------------


def test_under_threshold_input_skips_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    captured = _install_llm(monkeypatch, payload={"nodes": []})

    parents, extras = hc._run_consolidation_llm(_ideas(1), target_tier=3, providers=None)

    assert parents == []
    assert extras is None
    assert captured == [], "LLM should not be invoked with <2 inputs"


def test_empty_input_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    captured = _install_llm(monkeypatch, payload={"nodes": []})

    parents, extras = hc._run_consolidation_llm([], target_tier=3, providers=None)
    assert parents == []
    assert extras is None
    assert captured == []


# ---------------------------------------------------------------------------
# Malformed responses
# ---------------------------------------------------------------------------


def test_non_json_string_payload_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload="not valid json at all")

    parents, extras = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert parents == []
    assert extras is None


def test_payload_not_dict_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload=[1, 2, 3])

    parents, extras = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert parents == []
    assert extras is None


def test_nodes_not_a_list_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={"nodes": {"this": "is wrong"}})

    parents, extras = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert parents == []
    assert extras is None


def test_llm_exception_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={}, raise_exc=RuntimeError("provider failed"))

    parents, extras = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert parents == []
    assert extras is None


# ---------------------------------------------------------------------------
# children_ids contract — the most damaging bug class
# ---------------------------------------------------------------------------


def test_dropped_node_without_children_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "topic-1", "node_name": "Has children", "children_ids": ["idea-0", "idea-1"]},
            {"id": "topic-2", "node_name": "No children list"},  # filtered
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert len(parents) == 1
    assert parents[0]["node_name"] == "Has children"


def test_filters_children_ids_not_in_input(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {
                "id": "topic-1",
                "node_name": "Real topic",
                "children_ids": ["idea-0", "idea-99", "idea-2"],
            }
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert len(parents) == 1
    # idea-99 hallucinated by LLM — must be filtered out
    assert sorted(parents[0]["children_ids"]) == ["idea-0", "idea-2"]


def test_node_with_all_hallucinated_children_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "topic-bad", "node_name": "All fake", "children_ids": ["idea-99", "idea-100"]},
            {"id": "topic-good", "node_name": "Real", "children_ids": ["idea-1"]},
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert len(parents) == 1
    assert parents[0]["node_name"] == "Real"


def test_node_with_empty_name_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "topic-empty", "node_name": "", "children_ids": ["idea-0"]},
            {"id": "topic-named", "node_name": "Named", "children_ids": ["idea-1"]},
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(5), target_tier=3, providers=None)
    assert len(parents) == 1
    assert parents[0]["node_name"] == "Named"


def test_alt_keys_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Some prompts emit tier-specific keys (e.g. 'topics' instead of 'nodes')."""
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "topics": [
            {"id": "t-1", "node_name": "From topics key", "child_ids": ["idea-0"]},
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(3), target_tier=3, providers=None)
    assert len(parents) == 1
    assert parents[0]["children_ids"] == ["idea-0"]


# ---------------------------------------------------------------------------
# Output shape — what the persistence layer relies on
# ---------------------------------------------------------------------------


def test_output_has_required_persistence_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "topic-1", "node_name": "X", "summary": "Y", "children_ids": ["idea-0"]},
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(3), target_tier=3, providers=None)
    parent = parents[0]
    for field in (
        "id", "node_name", "summary", "semantic_level", "semantic_type",
        "level", "node_type", "children_ids", "parent_id",
    ):
        assert field in parent, f"missing field {field!r} in {parent!r}"
    assert parent["semantic_level"] == 3
    assert parent["semantic_type"] == "topic"
    assert parent["level"] == parent["semantic_level"]
    assert parent["node_type"] == parent["semantic_type"]


def test_id_synthesized_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"node_name": "Anonymous", "children_ids": ["idea-0"]},
        ]
    })

    parents, _ = hc._run_consolidation_llm(_ideas(3), target_tier=3, providers=None)
    assert parents[0]["id"].startswith("topic-")
    assert len(parents[0]["id"]) > len("topic-")


# ---------------------------------------------------------------------------
# Arcs pass — title + executive_summary extras
# ---------------------------------------------------------------------------


def test_arcs_pass_extracts_title_and_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "arc-1", "node_name": "Arc 1", "children_ids": ["theme-0"]},
            {"id": "arc-2", "node_name": "Arc 2", "children_ids": ["theme-1"]},
        ],
        "conversation_title": "Strategic Discussion of Topic X",
        "executive_summary": "Three speakers explored X. They agreed on Y. The session ended with action items on Z.",
    })

    themes = [
        {"id": "theme-0", "node_name": "Theme 0", "summary": "S0"},
        {"id": "theme-1", "node_name": "Theme 1", "summary": "S1"},
    ]
    parents, extras = hc._run_consolidation_llm(themes, target_tier=5, providers=None)

    assert len(parents) == 2
    assert all(p["semantic_type"] == "arc" for p in parents)
    assert extras is not None
    assert extras["conversation_title"] == "Strategic Discussion of Topic X"
    assert "Three speakers" in extras["executive_summary"]


def test_arcs_pass_title_summary_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [{"id": "arc-1", "node_name": "Arc", "children_ids": ["theme-0"]}],
        # no title/summary
    })

    themes = [
        {"id": "theme-0", "node_name": "T0", "summary": "S0"},
        {"id": "theme-1", "node_name": "T1", "summary": "S1"},
    ]
    parents, extras = hc._run_consolidation_llm(themes, target_tier=5, providers=None)

    assert len(parents) == 1
    assert extras is not None
    assert extras["conversation_title"] is None
    assert extras["executive_summary"] is None


def test_non_arc_tier_has_no_extras(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [{"id": "x", "node_name": "X", "children_ids": ["idea-0"]}],
        "conversation_title": "would be ignored",
    })

    _, extras = hc._run_consolidation_llm(_ideas(3), target_tier=3, providers=None)
    assert extras is None

    _, extras = hc._run_consolidation_llm(_ideas(3), target_tier=4, providers=None)
    assert extras is None


# ---------------------------------------------------------------------------
# Public async wrappers
# ---------------------------------------------------------------------------


def test_async_wrappers_unwrap_correctly(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_prompt_manager(monkeypatch)
    _install_llm(monkeypatch, payload={
        "nodes": [
            {"id": "t1", "node_name": "T", "children_ids": ["idea-0"]},
        ],
        "conversation_title": "Title",
        "executive_summary": "Summary.",
    })

    topics = asyncio.run(hc.consolidate_ideas_to_topics(_ideas(3)))
    assert len(topics) == 1
    assert topics[0]["semantic_level"] == 3

    themes_in = [
        {"id": "topic-0", "node_name": "T0", "summary": "S0"},
        {"id": "topic-1", "node_name": "T1", "summary": "S1"},
    ]
    themes = asyncio.run(hc.consolidate_topics_to_themes(themes_in))
    # children_ids will be filtered to those in themes_in; this LLM payload's child
    # "idea-0" is not in themes_in → the parent will be dropped
    assert themes == []

    arcs_in = [
        {"id": "idea-0", "node_name": "I0", "summary": "S0"},
        {"id": "theme-1", "node_name": "T1", "summary": "S1"},
    ]
    arcs, title, summary = asyncio.run(hc.consolidate_themes_to_arcs(arcs_in))
    assert len(arcs) == 1
    assert title == "Title"
    assert summary == "Summary."


# ---------------------------------------------------------------------------
# Input simplification
# ---------------------------------------------------------------------------


def test_simplify_drops_nodes_without_id() -> None:
    nodes = [
        {"id": "ok", "node_name": "A", "summary": "B"},
        {"node_name": "missing-id"},
        {"node_id": "alt-key", "node_name": "C"},
        "not a dict",
    ]
    simplified = hc._simplify_for_consolidation(nodes)
    ids = [n["id"] for n in simplified]
    assert "ok" in ids
    assert "alt-key" in ids
    assert "missing-id" not in ids
    assert len(simplified) == 2


def test_simplify_uses_node_text_when_summary_missing() -> None:
    nodes = [
        {"id": "n1", "node_name": "X", "node_text": "From node_text"},
    ]
    simplified = hc._simplify_for_consolidation(nodes)
    assert simplified[0]["summary"] == "From node_text"


# ── orphan adoption ──────────────────────────────────────────────────────────
# The prompt says "each idea belongs to EXACTLY ONE topic — no overlap, no
# orphans". The model does not obey it: measured on a real 1,125-turn
# conversation (2026-08-12), 16 of 82 ideas were claimed by NO topic, so a
# sixth of the conversation was invisible at every zoom level above L2 —
# silently, because nothing counted the leftovers.

def _kids(n):
    return [{"id": f"i{i}", "node_name": f"idea {i}", "summary": ""} for i in range(n)]


def test_orphans_join_their_nearest_claimed_neighbour():
    ideas = _kids(6)                       # i0..i5 in conversation order
    parents = [
        {"id": "t1", "children_ids": ["i0", "i1"]},
        {"id": "t2", "children_ids": ["i4", "i5"]},
    ]                                       # i2, i3 orphaned
    assert hc.adopt_orphans(ideas, parents) == 2
    claimed = {c for p in parents for c in p["children_ids"]}
    assert claimed == {f"i{i}" for i in range(6)}
    # i2 sits next to i1 (t1); i3 next to i4 (t2) — order decides, not chance
    assert "i2" in parents[0]["children_ids"]
    assert "i3" in parents[1]["children_ids"]


def test_no_orphans_is_a_noop():
    ideas = _kids(3)
    parents = [{"id": "t1", "children_ids": ["i0", "i1", "i2"]}]
    assert hc.adopt_orphans(ideas, parents) == 0
    assert parents[0]["children_ids"] == ["i0", "i1", "i2"]


def test_no_parents_claimed_anything_is_a_noop_not_a_crash():
    """Total consolidation failure must not be papered over by adoption —
    there is no evidence to attach anything TO."""
    ideas = _kids(4)
    parents = [{"id": "t1", "children_ids": []}]
    assert hc.adopt_orphans(ideas, parents) == 0
    assert parents[0]["children_ids"] == []


def test_every_child_ends_up_claimed_exactly_once():
    ideas = _kids(10)
    parents = [
        {"id": "t1", "children_ids": ["i0"]},
        {"id": "t2", "children_ids": ["i9"]},
    ]
    hc.adopt_orphans(ideas, parents)
    all_claimed = [c for p in parents for c in p["children_ids"]]
    assert sorted(all_claimed) == sorted(f"i{i}" for i in range(10))
    assert len(all_claimed) == len(set(all_claimed))     # no double-claiming

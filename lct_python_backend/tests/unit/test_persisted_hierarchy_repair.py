"""Behavior tests for the persisted hierarchy repair boundary.

Test Intent:
- Every transcript-derived model stage receives only providers allowed by the
  conversation's stored privacy block.
- Missing privacy metadata fails closed before any model stage runs.
- A complete L1-L2 repair is valuable and persists when the conversation is
  below the normal thresholds for topics, themes, or arcs.
- Successful upper tiers remain optional enhancements, matching extraction.
- A non-empty but incomplete optional tier is removed while complete lower
  tiers are still persisted.
"""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from lct_python_backend.services.import_pipeline import persisted_hierarchy_repair as repair_module
from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    synchronize_hierarchy_best_effort as real_best_effort_sync,
)


def _conversation(privacy):
    return SimpleNamespace(
        id=uuid.uuid4(),
        owner_id="owner",
        deleted_at=None,
        conversation_name="Private meeting",
        source_type="indrasnet_raw_turns",
        indrasnet_group_id="group-1",
        source_metadata={"privacy": privacy} if privacy is not None else {},
    )


def _base_graph(count):
    nodes = []
    utterances = []
    for index in range(count):
        utterance_id = uuid.uuid4()
        chunk_id = f"chunk-{index}"
        idea_id = f"idea-{index}"
        nodes.extend(
            [
                {
                    "id": chunk_id,
                    "node_name": chunk_id,
                    "summary": chunk_id,
                    "semantic_level": 1,
                    "chunk_id": f"batch-{index}",
                    "parent_id": idea_id,
                    "utterance_ids": [str(utterance_id)],
                    "edges_out": [],
                },
                {
                    "id": idea_id,
                    "node_name": idea_id,
                    "summary": idea_id,
                    "semantic_level": 2,
                    "chunk_id": f"batch-{index}",
                    "children_ids": [chunk_id],
                    "utterance_ids": [str(utterance_id)],
                    "edges_out": [],
                },
            ]
        )
        utterances.append(SimpleNamespace(id=utterance_id))
    return nodes, utterances


def _install_harness(monkeypatch, *, privacy, idea_count):
    conversation = _conversation(privacy)
    graph, utterances = _base_graph(idea_count)
    providers = [
        {"id": "m5", "enabled": True, "trust_scope": "owner_private"},
        {"id": "cloud", "enabled": True, "trust_scope": "external"},
    ]

    monkeypatch.setattr(
        repair_module,
        "_resolve_conversation",
        AsyncMock(return_value=conversation),
    )
    monkeypatch.setattr(
        repair_module,
        "fetch_conversation_bundle",
        AsyncMock(return_value=(conversation, [MagicMock()], [], utterances)),
    )
    monkeypatch.setattr(
        repair_module,
        "build_graph_data_from_nodes",
        MagicMock(return_value=graph),
    )
    monkeypatch.setattr(
        repair_module,
        "load_llm_providers",
        AsyncMock(return_value={"providers": providers}),
    )
    repair = AsyncMock(return_value={"ideas_created": 0})
    monkeypatch.setattr(repair_module, "repair_chunk_idea_hierarchy", repair)
    topics = AsyncMock(return_value=[])
    themes = AsyncMock(return_value=[])
    arcs = AsyncMock(return_value=([], "", ""))
    monkeypatch.setattr(repair_module, "consolidate_ideas_to_topics", topics)
    monkeypatch.setattr(repair_module, "consolidate_topics_to_themes", themes)
    monkeypatch.setattr(repair_module, "consolidate_themes_to_arcs", arcs)
    sync = MagicMock(
        side_effect=lambda _nodes, **kwargs: {
            "membership_links": idea_count,
            "highest_level": kwargs["through_parent_level"],
            "optional_tiers_dropped": 0,
        }
    )
    monkeypatch.setattr(repair_module, "synchronize_hierarchy_best_effort", sync)
    monkeypatch.setattr(
        repair_module,
        "audit_hierarchy",
        MagicMock(return_value={"coverage_complete": True}),
    )
    persist = AsyncMock(return_value=len(graph))
    monkeypatch.setattr(repair_module, "persist_graph", persist)
    return SimpleNamespace(
        conversation=conversation,
        repair=repair,
        topics=topics,
        themes=themes,
        arcs=arcs,
        persist=persist,
    )


@pytest.mark.asyncio
async def test_repair_filters_every_model_stage_by_conversation_privacy(monkeypatch):
    harness = _install_harness(
        monkeypatch,
        privacy={"local_llm_ok": True, "external_llm_ok": False},
        idea_count=4,
    )
    harness.topics.return_value = [
        {"id": f"topic-{index}", "semantic_level": 3}
        for index in range(3)
    ]
    harness.themes.return_value = [
        {"id": f"theme-{index}", "semantic_level": 4}
        for index in range(2)
    ]
    harness.arcs.return_value = (
        [{"id": "arc-0", "semantic_level": 5}],
        "Private title",
        "Private summary",
    )
    monkeypatch.setattr(
        repair_module,
        "canonicalize_batch_node_ids",
        lambda nodes, **_kwargs: nodes,
    )

    await repair_module.repair_persisted_hierarchy(
        MagicMock(),
        conversation_id=str(harness.conversation.id),
        owner_id="owner",
    )

    for call in (
        harness.repair.await_args,
        harness.topics.await_args,
        harness.themes.await_args,
        harness.arcs.await_args,
    ):
        assert [provider["id"] for provider in call.kwargs["providers"]] == ["m5"]


@pytest.mark.asyncio
async def test_repair_fails_closed_before_models_when_privacy_is_missing(monkeypatch):
    harness = _install_harness(monkeypatch, privacy=None, idea_count=1)

    with pytest.raises(ValueError, match="No enabled LLM provider is permitted"):
        await repair_module.repair_persisted_hierarchy(
            MagicMock(),
            conversation_id=str(harness.conversation.id),
            owner_id="owner",
        )

    harness.repair.assert_not_awaited()
    harness.persist.assert_not_awaited()


@pytest.mark.asyncio
async def test_short_repair_persists_complete_l1_l2_without_upper_tiers(monkeypatch):
    harness = _install_harness(
        monkeypatch,
        privacy={"local_llm_ok": True, "external_llm_ok": False},
        idea_count=1,
    )

    result = await repair_module.repair_persisted_hierarchy(
        MagicMock(),
        conversation_id=str(harness.conversation.id),
        owner_id="owner",
    )

    harness.topics.assert_not_awaited()
    harness.themes.assert_not_awaited()
    harness.arcs.assert_not_awaited()
    harness.persist.assert_awaited_once()
    assert result["success"] is True
    assert result["tier_counts"] == {
        "1": 1,
        "2": 1,
        "3": 0,
        "4": 0,
        "5": 0,
    }
    assert repair_module.synchronize_hierarchy_best_effort.call_args.kwargs == {
        "through_parent_level": 2,
        "required_parent_level": 2,
        "materialize_membership_edges": True,
    }


@pytest.mark.asyncio
async def test_empty_optional_topic_result_still_persists_l1_l2(monkeypatch):
    harness = _install_harness(
        monkeypatch,
        privacy={"local_llm_ok": True, "external_llm_ok": False},
        idea_count=4,
    )

    result = await repair_module.repair_persisted_hierarchy(
        MagicMock(),
        conversation_id=str(harness.conversation.id),
        owner_id="owner",
    )

    harness.topics.assert_awaited_once()
    harness.themes.assert_not_awaited()
    harness.arcs.assert_not_awaited()
    harness.persist.assert_awaited_once()
    assert result["success"] is True
    assert result["tier_counts"]["2"] == 4
    assert result["tier_counts"]["3"] == 0


@pytest.mark.asyncio
async def test_partial_arc_is_dropped_while_complete_lower_tiers_persist(monkeypatch):
    harness = _install_harness(
        monkeypatch,
        privacy={"local_llm_ok": True, "external_llm_ok": False},
        idea_count=4,
    )
    harness.topics.return_value = [
        {
            "id": "topic-0",
            "semantic_level": 3,
            "children_ids": ["idea-0", "idea-1"],
        },
        {
            "id": "topic-1",
            "semantic_level": 3,
            "children_ids": ["idea-2"],
        },
        {
            "id": "topic-2",
            "semantic_level": 3,
            "children_ids": ["idea-3"],
        },
    ]
    harness.themes.return_value = [
        {
            "id": "theme-0",
            "semantic_level": 4,
            "children_ids": ["topic-0", "topic-1"],
        },
        {
            "id": "theme-1",
            "semantic_level": 4,
            "children_ids": ["topic-2"],
        },
    ]
    harness.arcs.return_value = (
        [
            {
                "id": "arc-0",
                "semantic_level": 5,
                "children_ids": ["theme-0"],
            }
        ],
        "Incomplete title",
        "Incomplete summary",
    )
    monkeypatch.setattr(
        repair_module,
        "canonicalize_batch_node_ids",
        lambda nodes, **_kwargs: nodes,
    )
    monkeypatch.setattr(
        repair_module,
        "synchronize_hierarchy_best_effort",
        real_best_effort_sync,
    )

    result = await repair_module.repair_persisted_hierarchy(
        MagicMock(),
        conversation_id=str(harness.conversation.id),
        owner_id="owner",
    )

    persisted_nodes = harness.persist.await_args.kwargs["existing_json"]
    assert max(node["semantic_level"] for node in persisted_nodes) == 4
    assert result["tier_counts"] == {
        "1": 4,
        "2": 4,
        "3": 3,
        "4": 2,
        "5": 0,
    }
    assert result["conversation_title"] is None
    assert result["executive_summary"] is None

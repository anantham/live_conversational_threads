"""Test Intent: hierarchy repair is complete, overlap-safe, and fails safely.

- A source batch with chunks but no idea is surfaced for LLM repair.
- Stray chunks in a batch that already has an idea are adopted deterministically.
- Repair responses must cover every batch; omitted children are attached locally.
- A malformed repair response retries only its small batch before failing safely.
- Provider timeouts split only the failed batch into smaller context windows.
- Retry bypasses a cached rejected response, while one unambiguous idea may own its whole batch.
- Adjacent-tier memberships may overlap while the zoom projection has one primary parent.
- Faithful edges lose dangling, duplicate, and cross-tier temporal rows only.
- Synchronizing a legacy-authored graph must not silently promote it to the
  faithful `edges_out` persistence lane and hide its temporal/semantic fields.
- A partially faithful graph fails descriptively instead of choosing a lossy
  persistence lane.
"""

import pytest

from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    clean_faithful_edges,
    synchronize_hierarchy,
)
from lct_python_backend.services.import_pipeline.idea_repair_llm import (
    materialize_repaired_ideas,
)
from lct_python_backend.services.import_pipeline.import_hierarchy_repair import (
    identify_missing_idea_groups,
    repair_chunk_idea_hierarchy,
)


def _node(node_id, level, *, chunk="batch-a", children=None, parent=None):
    return {
        "id": node_id,
        "node_name": node_id,
        "summary": node_id,
        "semantic_level": level,
        "level": level,
        "chunk_id": chunk if level <= 2 else None,
        "children_ids": list(children or []),
        "parent_id": parent,
        "utterance_ids": [f"utt-{node_id}"] if level == 1 else [],
        "edges_out": [],
    }


def test_identifies_missing_group_and_adopts_stray_chunk():
    first = _node("c1", 1, chunk="with-idea")
    stray = _node("c2", 1, chunk="with-idea")
    missing = _node("c3", 1, chunk="without-idea")
    idea = _node("i1", 2, chunk="with-idea", children=["c1"])
    nodes = [first, stray, missing, idea]

    groups, adopted = identify_missing_idea_groups(nodes)

    assert adopted == 1
    assert idea["children_ids"] == ["c1", "c2"]
    assert [group["source_batch"] for group in groups] == ["without-idea"]


def test_materializes_complete_idea_ownership_from_partial_response():
    chunks = [
        _node("c1", 1, chunk="batch-a"),
        _node("c2", 1, chunk="batch-a"),
        _node("c3", 1, chunk="batch-a"),
    ]
    groups = [{"source_batch": "batch-a", "chunks": chunks}]
    payload = {
        "ideas": [
            {
                "source_batch": "batch-a",
                "node_name": "First coherent thought",
                "summary": "The first two chunks form one thought.",
                "children_ids": ["c1", "c2"],
            }
        ]
    }

    ideas = materialize_repaired_ideas(groups, payload)

    assert len(ideas) == 1
    assert ideas[0]["children_ids"] == ["c1", "c2", "c3"]
    assert ideas[0]["semantic_level"] == 2
    assert ideas[0]["chunk_id"] == "batch-a"


def test_materializer_preserves_genuine_overlapping_memberships():
    chunks = [
        _node("c1", 1, chunk="batch-a"),
        _node("c2", 1, chunk="batch-a"),
    ]
    groups = [{"source_batch": "batch-a", "chunks": chunks}]
    payload = {
        "ideas": [
            {
                "source_batch": "batch-a",
                "node_name": "First meaning",
                "children_ids": ["c1", "c2"],
            },
            {
                "source_batch": "batch-a",
                "node_name": "Cross-cutting meaning",
                "children_ids": ["c1"],
            },
        ]
    }

    ideas = materialize_repaired_ideas(groups, payload)

    assert [idea["children_ids"] for idea in ideas] == [["c1", "c2"], ["c1"]]


def test_materializer_rejects_omitted_source_batch():
    groups = [
        {"source_batch": "batch-a", "chunks": [_node("c1", 1)]},
        {"source_batch": "batch-b", "chunks": [_node("c2", 1, chunk="batch-b")]},
    ]
    payload = {
        "ideas": [
            {
                "source_batch": "batch-a",
                "node_name": "Only one batch",
                "children_ids": ["c1"],
            }
        ]
    }

    with pytest.raises(ValueError, match="omitted source_batch batch-b"):
        materialize_repaired_ideas(groups, payload)


def test_single_idea_without_child_ids_owns_its_whole_source_batch():
    chunks = [
        _node("c1", 1, chunk="batch-a"),
        _node("c2", 1, chunk="batch-a"),
    ]
    groups = [{"source_batch": "batch-a", "chunks": chunks}]
    payload = {
        "ideas": [
            {
                "source_batch": "batch-a",
                "node_name": "One unambiguous thought",
                "summary": "Both chunks belong to the only proposed idea.",
            }
        ]
    }

    ideas = materialize_repaired_ideas(groups, payload)

    assert len(ideas) == 1
    assert ideas[0]["children_ids"] == ["c1", "c2"]


@pytest.mark.asyncio
async def test_repair_retries_only_malformed_small_batch(monkeypatch):
    chunks = [_node("c1", 1, chunk="batch-a")]
    responses = [
        {"ideas": []},
        {
            "ideas": [
                {
                    "source_batch": "batch-a",
                    "node_name": "Recovered idea",
                    "summary": "The retry returned valid ownership.",
                    "children_ids": ["c1"],
                }
            ]
        },
    ]
    calls = []

    def fake_call(groups, providers, *, skip_cache_read=False):
        calls.append(
            ([group["source_batch"] for group in groups], skip_cache_read)
        )
        return responses.pop(0)

    monkeypatch.setattr(
        "lct_python_backend.services.import_pipeline.import_hierarchy_repair._call_repair_llm",
        fake_call,
    )

    stats = await repair_chunk_idea_hierarchy(chunks, batch_size=5)

    assert calls == [(["batch-a"], False), (["batch-a"], True)]
    assert stats["ideas_created"] == 1
    assert chunks[0]["parent_id"]


@pytest.mark.asyncio
async def test_provider_failure_splits_only_failed_repair_batch(monkeypatch):
    chunks = [
        _node(f"c{index}", 1, chunk=f"batch-{index}")
        for index in range(5)
    ]
    call_sizes = []

    def fake_call(groups, providers, *, skip_cache_read=False):
        call_sizes.append(len(groups))
        if len(groups) > 3:
            raise RuntimeError("All LLM providers failed. Errors: local timeout")
        return {
            "ideas": [
                {
                    "source_batch": group["source_batch"],
                    "node_name": f"Idea for {group['source_batch']}",
                    "children_ids": [group["chunks"][0]["id"]],
                }
                for group in groups
            ]
        }

    monkeypatch.setattr(
        "lct_python_backend.services.import_pipeline.import_hierarchy_repair._call_repair_llm",
        fake_call,
    )

    stats = await repair_chunk_idea_hierarchy(chunks, batch_size=5)

    assert call_sizes == [5, 2, 3]
    assert stats["ideas_created"] == 5
    assert stats["membership_links"] == 5


def test_synchronize_hierarchy_builds_primary_zoom_projection_and_rejects_orphans():
    chunk = _node("c1", 1)
    idea = _node("i1", 2, children=["c1"])
    topic = _node("t1", 3, chunk=None, children=["i1"])
    nodes = [chunk, idea, topic]

    stats = synchronize_hierarchy(nodes, through_parent_level=3)

    assert chunk["parent_id"] == "i1"
    assert idea["parent_id"] == "t1"
    assert topic["parent_id"] is None
    assert stats["parent_links_set"] == 2

    with pytest.raises(ValueError, match="1 orphan child nodes"):
        synchronize_hierarchy([chunk, idea, _node("c2", 1)], through_parent_level=2)


def test_synchronize_hierarchy_preserves_overlapping_memberships():
    chunk = _node("c1", 1, parent="i2")
    first = _node("i1", 2, children=["c1"])
    second = _node("i2", 2, children=["c1"])
    nodes = [chunk, first, second]

    stats = synchronize_hierarchy(nodes, through_parent_level=2)

    assert chunk["parent_id"] == "i2"
    assert first["children_ids"] == []
    assert second["children_ids"] == ["c1"]
    assert chunk["memberships"] == [
        {
            "parent_id": "i1",
            "lens": "thematic",
            "role": "secondary",
            "confidence": 1.0,
        },
        {
            "parent_id": "i2",
            "lens": "thematic",
            "role": "primary",
            "confidence": 1.0,
        },
    ]
    membership_edges = [
        edge
        for edge in chunk["edges_out"]
        if edge["relationship_type"] == "member_of"
    ]
    assert [(edge["to"], edge["relationship_subtype"]) for edge in membership_edges] == [
        ("i1", "thematic:secondary"),
        ("i2", "thematic:primary"),
    ]
    assert stats["overlapping_children"] == 1
    assert stats["membership_links"] == 2


def test_synchronize_hierarchy_keeps_legacy_graph_in_legacy_edge_lane():
    chunk = _node("c1", 1)
    sibling = _node("c2", 1)
    idea = _node("i1", 2, children=["c1", "c2"])
    for node in (chunk, sibling, idea):
        node.pop("edges_out")
    chunk["successor"] = "c2"
    sibling["predecessor"] = "c1"
    sibling["edge_relations"] = [
        {
            "related_node": "c1",
            "relation_type": "supports",
            "relation_text": "The first chunk supports the second.",
        }
    ]

    synchronize_hierarchy([chunk, sibling, idea], through_parent_level=2)

    assert all("edges_out" not in node for node in (chunk, sibling, idea))
    assert chunk["successor"] == "c2"
    assert sibling["predecessor"] == "c1"
    assert sibling["edge_relations"][0]["relation_type"] == "supports"
    assert chunk["memberships"][0]["parent_id"] == "i1"


def test_synchronize_hierarchy_rejects_mixed_edge_representations():
    faithful_chunk = _node("c1", 1)
    legacy_idea = _node("i1", 2, children=["c1"])
    legacy_idea.pop("edges_out")

    with pytest.raises(ValueError, match="mixes faithful edges_out"):
        synchronize_hierarchy(
            [faithful_chunk, legacy_idea],
            through_parent_level=2,
        )


def test_clean_faithful_edges_keeps_only_valid_unique_edges():
    first = _node("c1", 1)
    second = _node("c2", 1)
    idea = _node("i1", 2, children=["c1", "c2"])
    first["successor"] = "i1"
    first["edges_out"] = [
        {"to": "c2", "relationship_type": "supports", "relationship_subtype": ""},
        {"to": "c2", "relationship_type": "supports", "relationship_subtype": ""},
        {"to": "i1", "relationship_type": "temporal", "relationship_subtype": ""},
        {"to": "missing", "relationship_type": "supports", "relationship_subtype": ""},
    ]

    stats = clean_faithful_edges([first, second, idea])

    assert len(first["edges_out"]) == 1
    assert first["edges_out"][0]["to"] == "c2"
    assert first["successor"] is None
    assert stats == {
        "edges_dangling_dropped": 1,
        "edges_duplicate_dropped": 1,
        "edges_cross_tier_temporal_dropped": 1,
    }

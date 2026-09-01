"""Behavioral intent for the owner-local argument-topology pipeline.

- Owner-local extraction must skip second-brain retrieval.
- A valid empty relation response is distinguishable from a failed scan.
- Semantic relations keep their direction and survive the persistence shape.
- Equivalent relation spellings collapse and cite exact endpoint turns.
- The exported marker is content-free and independently consumable.
- Large graphs are covered by bounded hierarchy-aware windows; a failed
  required window cannot be reported or persisted as a complete scan.
- Overlapping windows deduplicate canonical directed triples without losing
  their independently grounded turn citations.
- Faithful parallel rows and distinct hierarchy-membership lenses survive the
  additive persistence path.
"""

import json

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from lct_python_backend import share_api
from lct_python_backend.services import edge_enrichment
from lct_python_backend.services.import_pipeline import import_orchestrator


def test_managed_edge_prompt_declares_the_bounded_window_contract():
    from lct_python_backend.services.prompt_manager import get_prompt_manager

    prompt = get_prompt_manager().get_prompt("enrich_semantic_edges")

    assert prompt["version"] == "e3-bounded-grounded-edges-2026-08-31"
    assert "ONE BOUNDED SEMANTIC WINDOW" in prompt["template"]
    assert "two endpoint ids appear in this window" in prompt["template"]


@pytest.mark.asyncio
async def test_owner_local_enrichment_skips_context_lookup(monkeypatch):
    async def forbidden_context(**kwargs):
        pytest.fail("owner-local raw extraction queried second-brain context")

    async def empty_valid_scan(**kwargs):
        return [], {"parse_status": "valid", "error": None, "ms": 1}

    monkeypatch.setattr(edge_enrichment, "gather_context", forbidden_context)
    monkeypatch.setattr(edge_enrichment, "_call_enrich_llm", empty_valid_scan)

    edges, telemetry = await edge_enrichment.run_edge_enrichment(
        nodes=[{"id": "a"}], query_summary="local", providers=[],
        skip_context_lookup=True,
    )

    assert edges == []
    assert telemetry["context_telemetry"]["indrasnet_called"] is False
    assert telemetry["llm_telemetry"]["parse_status"] == "valid"


def _large_hierarchy_fixture():
    """A five-tier graph large enough to require multiple windows."""
    nodes = []
    for chunk_index in range(35):
        idea_index = chunk_index // 5
        nodes.append({
            "id": f"chunk-{chunk_index:02d}",
            "semantic_level": 1,
            "node_name": f"Chunk {chunk_index}",
            "summary": f"Evidence unit {chunk_index}",
            "parent_id": f"idea-{idea_index:02d}",
        })
    for idea_index in range(7):
        topic_index = idea_index // 4
        idea = {
            "id": f"idea-{idea_index:02d}",
            "semantic_level": 2,
            "node_name": f"Idea {idea_index}",
            "summary": f"Idea summary {idea_index}",
            "parent_id": f"topic-{topic_index:02d}",
        }
        if idea_index == 0:
            idea["memberships"] = [
                {"parent_id": "topic-00", "role": "primary"},
                {"parent_id": "topic-01", "role": "secondary"},
            ]
        nodes.append(idea)
    for topic_index in range(2):
        nodes.append({
            "id": f"topic-{topic_index:02d}",
            "semantic_level": 3,
            "node_name": f"Topic {topic_index}",
            "summary": f"Topic summary {topic_index}",
            "parent_id": "theme-00",
        })
    nodes.extend([
        {
            "id": "theme-00", "semantic_level": 4,
            "node_name": "Theme", "summary": "Theme summary",
            "parent_id": "arc-00",
        },
        {
            "id": "arc-00", "semantic_level": 5,
            "node_name": "Arc", "summary": "Arc summary",
        },
    ])
    return nodes


@pytest.mark.asyncio
async def test_large_graph_uses_bounded_windows_with_complete_coverage(monkeypatch):
    nodes = _large_hierarchy_fixture()
    calls = []

    async def valid_window_scan(**kwargs):
        window_nodes = kwargs["nodes"]
        calls.append(window_nodes)
        return [{
            "from_node_id": "theme-00",
            "to_node_id": "arc-00",
            "relation_type": "supports",
            "explanation": "The theme supplies the arc's central reasoning.",
        }], {
            "parse_status": "valid", "error": None, "ms": 5,
            "raw_edges": 1, "kept_edges": 1, "model": "test-local",
            "input_tokens": 100, "output_tokens": 20,
        }

    monkeypatch.setattr(edge_enrichment, "_call_enrich_llm", valid_window_scan)

    edges, telemetry = await edge_enrichment.run_edge_enrichment(
        nodes=nodes, query_summary="local", providers=[],
        skip_context_lookup=True,
    )

    assert len(calls) > 1
    assert all(len(window) <= 30 for window in calls)
    assert {node["id"] for window in calls for node in window} == {
        node["id"] for node in nodes
    }
    chunk_window = next(
        window for window in calls
        if any(node["id"] == "chunk-00" for node in window)
    )
    assert {"idea-00", "topic-00", "topic-01", "theme-00", "arc-00"}.issubset(
        {node["id"] for node in chunk_window}
    )
    chunk_ids = [f"chunk-{index:02d}" for index in range(35)]
    call_id_sets = [{node["id"] for node in window} for window in calls]
    assert all(
        any(left in ids and right in ids for ids in call_id_sets)
        for left, right in zip(chunk_ids, chunk_ids[1:])
    )
    assert len(edges) == 1
    aggregate = telemetry["llm_telemetry"]
    assert aggregate["parse_status"] == "valid"
    assert aggregate["window_count"] == len(calls)
    assert aggregate["completed_windows"] == len(calls)
    assert aggregate["kept_edges"] == 1


@pytest.mark.asyncio
async def test_one_invalid_required_window_fails_closed_without_partial_edges(monkeypatch):
    nodes = _large_hierarchy_fixture()
    call_count = 0

    async def second_window_invalid(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            return [], {
                "parse_status": "invalid", "error": "invalid_edge_payload",
                "ms": 3, "raw_edges": 0, "kept_edges": 0,
            }
        return [{
            "from_node_id": "theme-00",
            "to_node_id": "arc-00",
            "relation_type": "supports",
            "explanation": "Valid but incomplete partial output.",
        }], {
            "parse_status": "valid", "error": None, "ms": 3,
            "raw_edges": 1, "kept_edges": 1,
        }

    monkeypatch.setattr(edge_enrichment, "_call_enrich_llm", second_window_invalid)

    edges, telemetry = await edge_enrichment.run_edge_enrichment(
        nodes=nodes, query_summary="local", providers=[],
        skip_context_lookup=True,
    )

    assert edges == []
    aggregate = telemetry["llm_telemetry"]
    assert aggregate["parse_status"] == "invalid"
    assert aggregate["error"] == "window_2: invalid_edge_payload"
    assert aggregate["completed_windows"] == 2
    assert aggregate["window_count"] > aggregate["completed_windows"]


def test_cross_window_dedup_canonicalizes_relation_and_unions_citations():
    first_turn = "44444444-4444-4444-4444-444444444444"
    second_turn = "55555555-5555-5555-5555-555555555555"
    edges = edge_enrichment._deduplicate_edges(
        [
            {
                "from_node_id": "source", "to_node_id": "target",
                "relation_type": "support", "confidence": 0.7,
                "explanation": "Short explanation.",
                "supporting_utterance_ids": [first_turn],
            },
            {
                "from_node_id": "source", "to_node_id": "target",
                "relation_type": "supports", "confidence": 0.9,
                "explanation": "A more informative supported explanation.",
                "supporting_utterance_ids": [second_turn],
            },
        ],
        valid_node_ids={"source", "target"},
    )

    assert edges == [{
        "from_node_id": "source",
        "to_node_id": "target",
        "relation_type": "supports",
        "confidence": 0.9,
        "explanation": "A more informative supported explanation.",
        "supporting_utterance_ids": [first_turn, second_turn],
    }]


def test_merge_semantic_edges_preserves_source_to_target_direction():
    nodes = [
        {"id": "claim-a", "node_name": "Claim A"},
        {"id": "evidence-b", "node_name": "Evidence B"},
    ]
    edges = [{
        "from_node_id": "evidence-b", "to_node_id": "claim-a",
        "relation_type": "supports", "explanation": "B supports A",
        "confidence": 0.92,
    }]

    import_orchestrator._merge_semantic_edges(nodes, edges)

    target = nodes[0]
    assert "edges_out" not in nodes[0] and "edges_out" not in nodes[1]
    assert target["edge_relations"][0]["related_node_id"] == "evidence-b"
    assert target["edge_relations"][0]["related_node"] == "Evidence B"
    assert target["edge_relations"][0]["relation_type"] == "supports"
    assert target["edge_relations"][0]["relationship_subtype"] == "argument_topology:v1"


def test_parser_canonicalizes_deduplicates_and_keeps_only_grounded_edge_evidence():
    source_turn = "44444444-4444-4444-4444-444444444444"
    target_turn = "55555555-5555-5555-5555-555555555555"
    nodes = [
        {"id": "claim-a", "utterance_ids": [target_turn]},
        {"id": "evidence-b", "source_ref": {"utterance_ids": [source_turn]}},
    ]
    raw = """{
      "edges": [
        {"from_node_id":"evidence-b","to_node_id":"claim-a","relation_type":"rebut",
         "supporting_utterance_ids":["44444444-4444-4444-4444-444444444444","ghost"]},
        {"from_node_id":"evidence-b","to_node_id":"claim-a","relation_type":"rebuts",
         "supporting_utterance_ids":["55555555-5555-5555-5555-555555555555"]}
      ]
    }"""

    edges = edge_enrichment._parse_edges_response(raw, nodes=nodes)

    assert edges == [{
        "from_node_id": "evidence-b",
        "to_node_id": "claim-a",
        "relation_type": "rebuts",
        "explanation": "",
        "confidence": None,
        "supporting_utterance_ids": [source_turn, target_turn],
    }]


def test_parser_falls_back_to_source_node_turns_when_model_omits_evidence():
    source_turn = "44444444-4444-4444-4444-444444444444"
    nodes = [
        {"id": "claim-a"},
        {"id": "evidence-b", "utterance_ids": [source_turn]},
    ]
    raw = """{"edges":[{"from_node_id":"evidence-b","to_node_id":"claim-a",
      "relation_type":"supports","explanation":"Direct evidence"}]}"""

    [edge] = edge_enrichment._parse_edges_response(raw, nodes=nodes)

    assert edge["supporting_utterance_ids"] == [source_turn]


def test_parser_does_not_mislabel_a_broad_source_set_as_edge_specific_evidence():
    nodes = [
        {"id": "claim-a"},
        {"id": "theme-b", "utterance_ids": [f"u-{index}" for index in range(20)]},
    ]
    raw = """{"edges":[{"from_node_id":"theme-b","to_node_id":"claim-a",
      "relation_type":"supports"}]}"""

    [edge] = edge_enrichment._parse_edges_response(raw, nodes=nodes)

    assert edge["supporting_utterance_ids"] == []


def test_parser_rejects_endpoint_evidence_that_was_not_shown_to_the_model():
    hidden_turn = "u-13"
    nodes = [
        {"id": "claim-a"},
        {"id": "theme-b", "utterance_ids": [f"u-{index}" for index in range(1, 14)]},
    ]
    raw = json.dumps({
        "edges": [{
            "from_node_id": "theme-b",
            "to_node_id": "claim-a",
            "relation_type": "supports",
            "supporting_utterance_ids": [hidden_turn],
        }],
    })

    [edge] = edge_enrichment._parse_edges_response(raw, nodes=nodes)

    assert edge["supporting_utterance_ids"] == []


@pytest.mark.asyncio
async def test_semantic_merge_persistence_keeps_temporal_and_contextual_edges():
    from lct_python_backend.models import Node, Relationship
    from lct_python_backend.services.graph_persistence import persist_import_graph

    nodes = [
        {
            "id": "claim-a", "node_name": "Claim A", "summary": "claim",
            "successor": "Evidence B", "contextual_relation": {},
        },
        {
            "id": "evidence-b", "node_name": "Evidence B", "summary": "evidence",
            "predecessor": "Claim A",
            "contextual_relation": {"Context C": "B depends on context C"},
        },
        {"id": "context-c", "node_name": "Context C", "summary": "context"},
    ]
    import_orchestrator._merge_semantic_edges(nodes, [{
        "from_node_id": "evidence-b", "to_node_id": "claim-a",
        "relation_type": "supports", "explanation": "B supports A",
    }])
    db = MagicMock()
    db.add = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = MagicMock()
    db.execute.return_value = result

    await persist_import_graph(db=db, conversation_id="5953fd1b-2597-408c-916d-f553f8da57f2", existing_json=nodes)

    added = [call.args[0] for call in db.add.call_args_list]
    persisted_nodes = {item.node_name: item.id for item in added if isinstance(item, Node)}
    relationships = [item for item in added if isinstance(item, Relationship)]
    assert any(item.relationship_type == "temporal" for item in relationships)
    assert any(item.relationship_type == "contextual" for item in relationships)
    support = next(item for item in relationships if item.relationship_type == "supports")
    assert support.from_node_id == persisted_nodes["Evidence B"]
    assert support.to_node_id == persisted_nodes["Claim A"]


@pytest.mark.asyncio
async def test_persistence_preserves_faithful_parallel_edges_and_membership_lenses():
    import uuid

    from lct_python_backend.models import Relationship
    from lct_python_backend.services.graph_persistence import persist_import_graph

    first_edge_id = uuid.UUID("2d1af23e-c4b0-450d-8a68-7edb4760b8a0")
    second_edge_id = uuid.UUID("f4d9a855-7704-4cf8-a186-a4e0f13c95c6")
    nodes = [
        {
            "id": "child", "node_name": "Child", "summary": "child",
            "semantic_level": 1,
            "memberships": [
                {"parent_id": "parent", "lens": "thematic", "role": "primary"},
                {"parent_id": "parent", "lens": "rhetorical", "role": "secondary"},
            ],
            "edges_out": [
                {
                    "id": str(first_edge_id), "to": "peer",
                    "relationship_type": "supports",
                    "relationship_subtype": "evidence",
                    "explanation": "Empirical evidence supports the claim.",
                },
                {
                    "id": str(second_edge_id), "to": "peer",
                    "relationship_type": "supports",
                    "relationship_subtype": "mechanism",
                    "explanation": "The mechanism independently supports it.",
                },
            ],
        },
        {
            "id": "peer", "node_name": "Peer", "summary": "peer",
            "semantic_level": 1,
        },
        {
            "id": "parent", "node_name": "Parent", "summary": "parent",
            "semantic_level": 2,
        },
    ]
    db = MagicMock()
    db.add = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = MagicMock()
    db.execute.return_value = result

    await persist_import_graph(
        db=db,
        conversation_id="7ac74fa0-a1b1-4659-8651-a1d77fae496b",
        existing_json=nodes,
    )

    relationships = [
        call.args[0] for call in db.add.call_args_list
        if isinstance(call.args[0], Relationship)
    ]
    supports = [item for item in relationships if item.relationship_type == "supports"]
    memberships = [item for item in relationships if item.relationship_type == "member_of"]
    assert {item.id for item in supports} == {first_edge_id, second_edge_id}
    assert {(item.relationship_subtype, item.explanation) for item in supports} == {
        ("evidence", "Empirical evidence supports the claim."),
        ("mechanism", "The mechanism independently supports it."),
    }
    assert {item.relationship_subtype for item in memberships} == {
        "thematic:primary", "rhetorical:secondary",
    }


def test_completed_zero_edge_scan_and_failed_scan_are_distinct():
    complete = import_orchestrator._topology_marker([], status="complete")
    failed = import_orchestrator._topology_marker(
        [], status="failed", reason="invalid_edge_payload"
    )

    assert complete == {
        "version": "1.0", "status": "complete", "semantic_edge_count": 0,
        "relation_type_counts": {},
    }
    assert failed["status"] == "failed"
    assert failed["reason"] == "invalid_edge_payload"


def test_threads_export_surfaces_content_free_scan_marker():
    marker = {
        "version": "1.0", "status": "complete", "semantic_edge_count": 3,
        "relation_type_counts": {"supports": 2, "rebuts": 1},
    }
    conversation = SimpleNamespace(source_metadata={
        "argument_topology": marker,
        "private_transcript": "must not leak through marker helper",
    })

    exported = share_api._export_argument_topology(conversation)

    assert exported == marker
    assert "private_transcript" not in exported


def test_combined_topology_rollup_fails_closed_on_missing_meeting_marker():
    complete = {
        "version": "1.0", "status": "complete", "semantic_edge_count": 2,
        "relation_type_counts": {"supports": 2},
    }

    rollup = share_api._combine_argument_topology([complete, None])

    assert rollup["status"] == "incomplete"
    assert rollup["semantic_edge_count"] == 2
    assert rollup["conversation_count"] == 2
    assert rollup["complete_conversation_count"] == 1


def test_combined_topology_rollup_fails_closed_when_no_meetings_are_present():
    rollup = share_api._combine_argument_topology([])

    assert rollup["status"] == "incomplete"
    assert rollup["conversation_count"] == 0
    assert rollup["complete_conversation_count"] == 0
    assert rollup["reason"] == "one_or_more_conversations_missing_or_failed_topology_scan"

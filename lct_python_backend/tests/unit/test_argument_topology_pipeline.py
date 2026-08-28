"""Behavioral intent for the owner-local argument-topology pipeline.

- Owner-local extraction must skip second-brain retrieval.
- A valid empty relation response is distinguishable from a failed scan.
- Semantic relations keep their direction and survive the persistence shape.
- Equivalent relation spellings collapse and cite exact endpoint turns.
- The exported marker is content-free and independently consumable.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from lct_python_backend import share_api
from lct_python_backend.services import edge_enrichment
from lct_python_backend.services.import_pipeline import import_orchestrator


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
    assert target["edge_relations"][0]["related_node"] == "Evidence B"
    assert target["edge_relations"][0]["relation_type"] == "supports"


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

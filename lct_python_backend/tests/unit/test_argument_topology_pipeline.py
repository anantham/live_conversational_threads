"""Behavioral intent for the owner-local argument-topology pipeline.

- Owner-local extraction must skip second-brain retrieval.
- A valid empty relation response is distinguishable from a failed scan.
- Semantic relations keep their direction and survive the persistence shape.
- The exported marker is content-free and independently consumable.
"""

from types import SimpleNamespace

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
    nodes = [{"id": "claim-a"}, {"id": "evidence-b"}]
    edges = [{
        "from_node_id": "evidence-b", "to_node_id": "claim-a",
        "relation_type": "supports", "explanation": "B supports A",
        "confidence": 0.92,
    }]

    import_orchestrator._merge_semantic_edges(nodes, edges)

    source = nodes[1]
    assert source["edges_out"][0]["to"] == "claim-a"
    assert source["edges_out"][0]["relationship_type"] == "supports"
    assert source["edge_relations"][0]["related_node"] == "claim-a"


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

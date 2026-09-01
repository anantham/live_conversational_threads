"""Behavioral intent for edge-only persisted topology repair.

- A successful repair replaces only prior argument-topology relationships.
- Structural membership, temporal, and contextual relationships are preserved.
- Repeated identical repairs mint stable edge ids and never rewrite nodes.
- A failed required window performs no relationship replacement or insertion.
- The public repair route resolves and forwards the owner boundary.
- Grounded edge citations survive the edge-only replacement transaction.
"""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from lct_python_backend.models import Relationship
from lct_python_backend.services.import_pipeline import argument_topology_repair


def _relationship(kind, *, subtype=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        relationship_type=kind,
        relationship_subtype=subtype,
    )


def test_argument_edge_classifier_never_selects_structural_relationships():
    marker = {
        "status": "complete",
        "relation_type_counts": {"supports": 1, "rebuts": 1},
    }
    for kind in argument_topology_repair.PRESERVED_RELATION_TYPES:
        assert argument_topology_repair.relationship_is_replaceable_argument_edge(
            _relationship(kind, subtype=kind), previous_marker=marker
        ) is False

    assert argument_topology_repair.relationship_is_replaceable_argument_edge(
        _relationship("supports", subtype="argument_topology:v1"),
        previous_marker=marker,
    ) is True
    assert argument_topology_repair.relationship_is_replaceable_argument_edge(
        _relationship("rebuts", subtype="rebuts"), previous_marker=marker
    ) is True


@pytest.mark.asyncio
async def test_repair_route_forwards_the_resolved_owner_boundary(monkeypatch):
    from lct_python_backend import import_api
    from lct_python_backend.import_schemas import ExtractTurnsRequest

    db = MagicMock()
    repair = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(import_api, "repair_persisted_argument_topology", repair)
    monkeypatch.setattr(import_api, "resolve_owner_id", lambda owner_id: f"resolved:{owner_id}")

    result = await import_api.repair_turn_topology(
        ExtractTurnsRequest(conversation_id="conversation", owner_id="owner"),
        db,
    )

    assert result == {"success": True}
    repair.assert_awaited_once_with(
        db,
        conversation_id="conversation",
        group_id=None,
        owner_id="resolved:owner",
    )


@pytest.mark.asyncio
async def test_successful_edge_only_repair_is_scoped_and_idempotent(monkeypatch):
    conversation_id = uuid.uuid4()
    source_id = uuid.uuid4()
    target_id = uuid.uuid4()
    supporting_id = uuid.uuid4()
    conversation = SimpleNamespace(
        id=conversation_id,
        source_metadata={
            "privacy": {"local_llm_ok": True, "external_llm_ok": False},
            "argument_topology": {
                "status": "complete",
                "relation_type_counts": {"rebuts": 1},
            }
        },
    )
    db_nodes = [SimpleNamespace(id=source_id), SimpleNamespace(id=target_id)]
    relationships = [
        _relationship("member_of", subtype="thematic:primary"),
        _relationship("temporal"),
        _relationship("contextual"),
        _relationship("rebuts", subtype="argument_topology:v1"),
    ]
    db = MagicMock()
    db.execute = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()

    monkeypatch.setattr(
        argument_topology_repair, "_resolve_conversation",
        AsyncMock(return_value=conversation),
    )
    monkeypatch.setattr(
        argument_topology_repair, "fetch_conversation_bundle",
        AsyncMock(return_value=(conversation, db_nodes, relationships, [])),
    )
    monkeypatch.setattr(
        argument_topology_repair, "build_graph_data_from_nodes",
        lambda *_args, **_kwargs: [
            {"id": str(source_id), "semantic_level": 2, "node_name": "Evidence"},
            {"id": str(target_id), "semantic_level": 3, "node_name": "Claim"},
        ],
    )
    monkeypatch.setattr(
        argument_topology_repair, "load_llm_providers",
        AsyncMock(return_value={"providers": [{
            "id": "local", "enabled": True,
            "base_url": "http://127.0.0.1:11434", "model": "test",
            "trust_scope": "owner_private",
        }]}),
    )
    monkeypatch.setattr(
        argument_topology_repair, "load_llm_config",
        AsyncMock(return_value={}),
    )
    edge = {
        "from_node_id": str(source_id),
        "to_node_id": str(target_id),
        "relation_type": "supports",
        "explanation": "The evidence directly supports the claim.",
        "confidence": 0.94,
        "supporting_utterance_ids": [str(supporting_id), "not-a-uuid"],
    }
    monkeypatch.setattr(
        argument_topology_repair, "run_edge_enrichment",
        AsyncMock(return_value=([edge], {
            "llm_telemetry": {
                "parse_status": "valid", "error": None,
                "window_count": 1, "completed_windows": 1,
            }
        })),
    )

    first = await argument_topology_repair.repair_persisted_argument_topology(
        db, conversation_id=str(conversation_id), owner_id="owner"
    )
    second = await argument_topology_repair.repair_persisted_argument_topology(
        db, conversation_id=str(conversation_id), owner_id="owner"
    )

    assert first["success"] is True
    assert first["replaced_argument_edge_count"] == 1
    assert first["argument_topology"]["semantic_edge_count"] == 1
    assert db.execute.await_count == 2
    added = [call.args[0] for call in db.add.call_args_list]
    assert all(isinstance(item, Relationship) for item in added)
    assert added[0].id == added[1].id
    assert added[0].from_node_id == source_id
    assert added[0].to_node_id == target_id
    assert added[0].relationship_subtype == "argument_topology:v1"
    assert added[0].supporting_utterance_ids == [supporting_id]
    assert db.commit.await_count == 2


@pytest.mark.asyncio
async def test_failed_window_does_not_replace_or_insert_relationships(monkeypatch):
    conversation_id = uuid.uuid4()
    conversation = SimpleNamespace(
        id=conversation_id,
        source_metadata={
            "privacy": {"local_llm_ok": True, "external_llm_ok": False},
            "argument_topology": {
                "status": "failed", "relation_type_counts": {},
            }
        },
    )
    db_node = SimpleNamespace(id=uuid.uuid4())
    db = MagicMock()
    db.execute = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()

    monkeypatch.setattr(
        argument_topology_repair, "_resolve_conversation",
        AsyncMock(return_value=conversation),
    )
    monkeypatch.setattr(
        argument_topology_repair, "fetch_conversation_bundle",
        AsyncMock(return_value=(conversation, [db_node], [], [])),
    )
    monkeypatch.setattr(
        argument_topology_repair, "build_graph_data_from_nodes",
        lambda *_args, **_kwargs: [{
            "id": str(db_node.id), "semantic_level": 2, "node_name": "Claim",
        }],
    )
    monkeypatch.setattr(
        argument_topology_repair, "load_llm_providers",
        AsyncMock(return_value={"providers": [{
            "id": "local", "enabled": True,
            "base_url": "http://127.0.0.1:11434", "model": "test",
            "trust_scope": "owner_private",
        }]}),
    )
    monkeypatch.setattr(
        argument_topology_repair, "load_llm_config", AsyncMock(return_value={}),
    )
    monkeypatch.setattr(
        argument_topology_repair, "run_edge_enrichment",
        AsyncMock(return_value=([], {
            "llm_telemetry": {
                "parse_status": "invalid",
                "error": "window_2: invalid_edge_payload",
                "window_count": 4,
                "completed_windows": 2,
            }
        })),
    )

    result = await argument_topology_repair.repair_persisted_argument_topology(
        db, conversation_id=str(conversation_id), owner_id="owner"
    )

    assert result["success"] is False
    assert result["argument_topology"]["status"] == "failed"
    assert result["scan"]["completed_windows"] == 2
    db.execute.assert_not_awaited()
    db.add.assert_not_called()
    db.commit.assert_awaited_once()

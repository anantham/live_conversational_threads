"""Tests for conversation_reader.build_graph_data_from_nodes."""

from __future__ import annotations

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace

from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes


def _fake_node(node_id, name):
    """A Node row stand-in with every attribute build_graph_data_from_nodes
    reads, at inert defaults."""
    return SimpleNamespace(
        id=node_id,
        node_name=name,
        summary="summary",
        level=1,
        claim_ids=[],
        key_points=[],
        predecessor_id=None,
        successor_id=None,
        is_bookmark=False,
        is_contextual_progress=False,
        is_tangent=False,
        chunk_ids=[],
        utterance_ids=[],
        parent_id=None,
        children_ids=[],
        source_excerpt=None,
        cluster_info={},
        display_preferences={},
        speaker_info=None,
        timestamp_start=None,
        timestamp_end=None,
    )


def _fake_rel(from_id, to_id, **overrides):
    return SimpleNamespace(
        id=overrides.get("id", uuid.uuid4()),
        from_node_id=from_id,
        to_node_id=to_id,
        relationship_type=overrides.get("relationship_type", "supports"),
        relationship_subtype=overrides.get("relationship_subtype"),
        explanation=overrides.get("explanation", "because"),
        strength=overrides.get("strength", 0.8),
        confidence=overrides.get("confidence", 0.9),
        is_bidirectional=overrides.get("is_bidirectional", False),
        supporting_utterance_ids=overrides.get("supporting_utterance_ids", []),
    )


def test_edges_out_absent_by_default():
    """Read/export callers don't pass include_edges_out — payloads stay lean."""
    a, b = uuid.uuid4(), uuid.uuid4()
    nodes = [_fake_node(a, "A"), _fake_node(b, "B")]
    rels = [_fake_rel(a, b)]

    graph = build_graph_data_from_nodes(nodes, rels)

    assert all("edges_out" not in node for node in graph)


def test_edges_out_is_faithful_when_requested():
    """include_edges_out=True gives each node its outgoing Relationship rows
    verbatim — id + every field — so persist_graph can re-persist losslessly."""
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    nodes = [_fake_node(a, "A"), _fake_node(b, "B"), _fake_node(c, "C")]
    rel_id = uuid.uuid4()
    rels = [
        _fake_rel(a, b, id=rel_id, relationship_type="supports", strength=0.7,
                  confidence=0.95, explanation="A backs B"),
        _fake_rel(a, c, relationship_type="rebuts"),
    ]

    graph = build_graph_data_from_nodes(nodes, rels, include_edges_out=True)
    by_id = {node["id"]: node for node in graph}

    # A has two outgoing edges; B and C have none.
    a_edges = by_id[str(a)]["edges_out"]
    assert {edge["to"] for edge in a_edges} == {str(b), str(c)}
    assert by_id[str(b)]["edges_out"] == []
    assert by_id[str(c)]["edges_out"] == []

    # The edge carries the original relationship id and all fields verbatim.
    supports = next(e for e in a_edges if e["relationship_type"] == "supports")
    assert supports["id"] == str(rel_id)
    assert supports["strength"] == 0.7
    assert supports["confidence"] == 0.95
    assert supports["explanation"] == "A backs B"


def test_edges_out_preserves_multiple_edges_between_the_same_pair():
    """The lossiness this fix targets: two edges A->B collapse to one in the
    legacy predecessor/successor representation. edges_out keeps both."""
    a, b = uuid.uuid4(), uuid.uuid4()
    nodes = [_fake_node(a, "A"), _fake_node(b, "B")]
    rels = [
        _fake_rel(a, b, relationship_type="supports"),
        _fake_rel(a, b, relationship_type="follows"),
    ]

    graph = build_graph_data_from_nodes(nodes, rels, include_edges_out=True)
    a_edges = {node["id"]: node for node in graph}[str(a)]["edges_out"]

    assert len(a_edges) == 2
    assert {e["relationship_type"] for e in a_edges} == {"supports", "follows"}


def test_member_of_edges_serialize_as_memberships_not_contextual_relations():
    """Canonical memberships survive lean export without polluting semantic edges."""
    child, primary, secondary = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    child_node = _fake_node(child, "Child")
    child_node.parent_id = primary
    primary_node = _fake_node(primary, "Primary")
    primary_node.level = 2
    secondary_node = _fake_node(secondary, "Secondary")
    secondary_node.level = 2
    rels = [
        _fake_rel(
            child,
            primary,
            relationship_type="member_of",
            relationship_subtype="thematic:primary",
            confidence=0.98,
        ),
        _fake_rel(
            child,
            secondary,
            relationship_type="member_of",
            relationship_subtype="thematic:secondary",
            confidence=0.72,
        ),
    ]

    graph = build_graph_data_from_nodes(
        [child_node, primary_node, secondary_node],
        rels,
    )
    by_id = {node["id"]: node for node in graph}

    assert by_id[str(child)]["memberships"] == [
        {
            "parent_id": str(primary),
            "lens": "thematic",
            "role": "primary",
            "confidence": 0.98,
        },
        {
            "parent_id": str(secondary),
            "lens": "thematic",
            "role": "secondary",
            "confidence": 0.72,
        },
    ]
    assert by_id[str(child)]["contextual_relation"] == {}
    assert by_id[str(primary)]["edge_relations"] == []
    assert by_id[str(secondary)]["edge_relations"] == []

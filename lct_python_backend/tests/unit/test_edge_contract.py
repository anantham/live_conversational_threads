"""Test Intent for the explicit directed-edge boundary.

- Preserve source and target exactly instead of inferring direction from nodes.
- Preserve fidelity fields needed for audit and future rendering.
- Canonicalize equivalent relation spellings at the public boundary.
- Collapse duplicate endpoint/type triples while preserving their evidence.
- Namespace combined-corpus node and edge identifiers together.
- Skip malformed rows rather than emitting dangling endpoint placeholders.
"""

from types import SimpleNamespace
from uuid import UUID

import pytest

from lct_python_backend.services.edge_contract import (
    EDGE_SCHEMA_VERSION,
    THREADS_FORMAT_VERSION,
    canonical_relation_type,
    edge_schema_descriptor,
    relationship_edge_kind,
    serialize_relationships,
    validate_serialized_edge_contract,
)


def relationship(**overrides):
    values = {
        "id": UUID("11111111-1111-1111-1111-111111111111"),
        "from_node_id": UUID("22222222-2222-2222-2222-222222222222"),
        "to_node_id": UUID("33333333-3333-3333-3333-333333333333"),
        "relationship_type": "supports",
        "relationship_subtype": "evidential",
        "explanation": "The measurement supports the claim.",
        "strength": 0.8,
        "confidence": 0.9,
        "is_bidirectional": False,
        "supporting_utterance_ids": [
            UUID("44444444-4444-4444-4444-444444444444")
        ],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_descriptor_declares_explicit_directed_node_id_space():
    assert THREADS_FORMAT_VERSION == 2
    assert edge_schema_descriptor() == {
        "version": EDGE_SCHEMA_VERSION,
        "directed": True,
        "endpoint_space": "graph_data.id",
    }


def test_serialization_preserves_direction_and_fidelity():
    [edge] = serialize_relationships([relationship()])

    assert edge == {
        "id": "11111111-1111-1111-1111-111111111111",
        "from_node_id": "22222222-2222-2222-2222-222222222222",
        "to_node_id": "33333333-3333-3333-3333-333333333333",
        "relation_type": "supports",
        "edge_kind": "semantic",
        "relation_subtype": "evidential",
        "explanation": "The measurement supports the claim.",
        "strength": 0.8,
        "confidence": 0.9,
        "is_bidirectional": False,
        "supporting_utterance_ids": ["44444444-4444-4444-4444-444444444444"],
    }


def test_combined_namespace_applies_to_both_endpoints_and_edge_id():
    [edge] = serialize_relationships(
        [relationship()],
        node_id_transform=lambda value: f"c3-{value}",
        edge_id_transform=lambda value: f"c3-{value}",
    )

    assert edge["id"].startswith("c3-")
    assert edge["from_node_id"].startswith("c3-")
    assert edge["to_node_id"].startswith("c3-")


def test_temporal_relationships_are_explicitly_classified():
    assert relationship_edge_kind("temporal") == "temporal"
    assert relationship_edge_kind("leads_to") == "temporal"
    assert relationship_edge_kind("supports") == "semantic"
    [edge] = serialize_relationships([relationship(relationship_type="follows")])
    assert edge["edge_kind"] == "temporal"


def test_relation_aliases_are_canonicalized_without_changing_direction():
    assert canonical_relation_type("rebut") == "rebuts"
    assert canonical_relation_type("support") == "supports"
    [edge] = serialize_relationships([relationship(relationship_type="Rebut")])
    assert edge["relation_type"] == "rebuts"
    assert edge["from_node_id"] == "22222222-2222-2222-2222-222222222222"
    assert edge["to_node_id"] == "33333333-3333-3333-3333-333333333333"


def test_duplicate_semantic_triples_merge_supporting_turns():
    first = relationship(
        id=UUID("11111111-1111-1111-1111-111111111111"),
        relationship_type="rebut",
        supporting_utterance_ids=[UUID("44444444-4444-4444-4444-444444444444")],
    )
    second = relationship(
        id=UUID("55555555-5555-5555-5555-555555555555"),
        relationship_type="rebuts",
        supporting_utterance_ids=[UUID("66666666-6666-6666-6666-666666666666")],
    )

    [edge] = serialize_relationships([first, second])

    assert edge["id"] == "11111111-1111-1111-1111-111111111111"
    assert edge["relation_type"] == "rebuts"
    assert edge["supporting_utterance_ids"] == [
        "44444444-4444-4444-4444-444444444444",
        "66666666-6666-6666-6666-666666666666",
    ]


def test_saved_contract_requires_real_schema_and_resolvable_endpoints():
    nodes = [{"id": "source"}, {"id": "target"}]
    edges = [{
        "id": "edge-1",
        "from_node_id": "source",
        "to_node_id": "target",
        "relation_type": "supports",
        "edge_kind": "semantic",
    }]
    assert validate_serialized_edge_contract(edge_schema_descriptor(), edges, nodes) is edges

    with pytest.raises(ValueError, match="edge_schema"):
        validate_serialized_edge_contract(None, edges, nodes)
    with pytest.raises(ValueError, match="unknown node"):
        validate_serialized_edge_contract(
            edge_schema_descriptor(),
            [{**edges[0], "to_node_id": "missing"}],
            nodes,
        )


def test_malformed_rows_are_not_emitted():
    assert serialize_relationships([
        relationship(from_node_id=None),
        relationship(to_node_id=None),
        relationship(relationship_type=""),
    ]) == []

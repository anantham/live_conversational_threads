"""Test Intent: canonical identity at the streaming graph boundary.

- Reused model ids across separate batches must never collide in shared state.
- Parent/child and same-batch semantic references must follow rewritten ids.
- References to already-canonical prior nodes must remain unchanged.
- Duplicate ids inside one model response must fail loudly as ambiguous.
"""

from itertools import count

import pytest

from lct_python_backend.services.transcript.transcript_identity import (
    canonicalize_batch_node_ids,
)


def _id_factory(prefix: str):
    values = count(1)
    return lambda: f"{prefix}-{next(values)}"


def test_reused_model_ids_are_unique_across_batches():
    first = canonicalize_batch_node_ids(
        [{"id": "chunk-001", "node_name": "First"}],
        id_factory=_id_factory("first"),
    )
    second = canonicalize_batch_node_ids(
        [{"id": "chunk-001", "node_name": "Second"}],
        existing_nodes=first,
        id_factory=_id_factory("second"),
    )

    assert first[0]["id"] == "first-1"
    assert second[0]["id"] == "second-1"
    assert first[0]["id"] != second[0]["id"]


def test_rewrites_intra_batch_hierarchy_and_semantic_references():
    nodes = [
        {
            "id": "chunk-001",
            "node_name": "Evidence",
            "parent_id": "idea-001",
            "successor": "chunk-002",
            "linked_nodes": ["chunk-002", "A node name"],
            "contextual_relation": {"chunk-002": "continues"},
            "edge_relations": [
                {"related_node": "chunk-002", "relation_type": "supports"}
            ],
        },
        {
            "id": "chunk-002",
            "node_name": "Consequence",
            "predecessor": "chunk-001",
            "parent_id": "idea-001",
        },
        {
            "id": "idea-001",
            "node_name": "Combined idea",
            "children_ids": ["chunk-001", "chunk-002"],
        },
    ]

    result = canonicalize_batch_node_ids(nodes, id_factory=_id_factory("node"))
    first, second, idea = result

    assert [node["id"] for node in result] == ["node-1", "node-2", "node-3"]
    assert first["parent_id"] == "node-3"
    assert second["parent_id"] == "node-3"
    assert idea["children_ids"] == ["node-1", "node-2"]
    assert first["successor"] == "node-2"
    assert second["predecessor"] == "node-1"
    assert first["linked_nodes"] == ["node-2", "A node name"]
    assert first["contextual_relation"] == {"node-2": "continues"}
    assert first["edge_relations"][0]["related_node"] == "node-2"


def test_preserves_reference_to_prior_canonical_node():
    prior_id = "51fca8be-2381-49ac-a000-0317cf0cdd46"
    result = canonicalize_batch_node_ids(
        [
            {
                "id": "chunk-001",
                "node_name": "Return",
                "predecessor": prior_id,
            }
        ],
        existing_nodes=[{"id": prior_id, "node_name": "Earlier"}],
        id_factory=_id_factory("new"),
    )

    assert result[0]["id"] == "new-1"
    assert result[0]["predecessor"] == prior_id


def test_duplicate_ids_inside_one_response_fail_loudly():
    with pytest.raises(ValueError, match="duplicate node id 'chunk-001'"):
        canonicalize_batch_node_ids(
            [
                {"id": "chunk-001", "node_name": "A"},
                {"id": "chunk-001", "node_name": "B"},
            ]
        )

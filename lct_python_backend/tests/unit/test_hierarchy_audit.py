"""Test Intent: canonical memberships and derived zoom projections agree.

- Many-to-many memberships are valid when one thematic parent is primary.
- Projection caches must be the exact inverse of primary memberships.
- Membership and semantic edges must never point at absent nodes.
"""

import pytest

from lct_python_backend.services.import_pipeline.hierarchy_audit import (
    audit_hierarchy,
)
from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    synchronize_hierarchy,
)


def _node(node_id, level, *, children=None, parent=None):
    return {
        "id": node_id,
        "semantic_level": level,
        "level": level,
        "parent_id": parent,
        "children_ids": list(children or []),
        "utterance_ids": [f"utt-{node_id}"],
        "edges_out": [],
    }


def test_audit_accepts_overlap_with_one_primary_zoom_parent():
    chunk = _node("c1", 1, parent="i2")
    first = _node("i1", 2, children=["c1"])
    second = _node("i2", 2, children=["c1"])
    nodes = [chunk, first, second]
    synchronize_hierarchy(nodes, through_parent_level=2)

    result = audit_hierarchy(nodes, through_parent_level=2)

    assert result == {
        "node_count": 3,
        "edge_count": 2,
        "membership_links": 2,
        "overlapping_children": 1,
        "projected_children": 1,
    }


def test_audit_rejects_projection_that_hides_the_wrong_primary_child():
    chunk = _node("c1", 1)
    idea = _node("i1", 2, children=["c1"])
    nodes = [chunk, idea]
    synchronize_hierarchy(nodes, through_parent_level=2)
    idea["children_ids"] = []

    with pytest.raises(ValueError, match="projection mismatch"):
        audit_hierarchy(nodes, through_parent_level=2)


def test_audit_rejects_dangling_semantic_edge():
    chunk = _node("c1", 1)
    idea = _node("i1", 2, children=["c1"])
    nodes = [chunk, idea]
    synchronize_hierarchy(nodes, through_parent_level=2)
    chunk["edges_out"].append(
        {"id": "edge-missing", "to": "absent", "relationship_type": "supports"}
    )

    with pytest.raises(ValueError, match="dangling edge"):
        audit_hierarchy(nodes, through_parent_level=2)

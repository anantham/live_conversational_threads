"""Independent invariants for canonical memberships and zoom projections."""

from __future__ import annotations

from typing import Any, Dict, List

from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    MEMBERSHIP_LENS,
    MEMBERSHIP_RELATIONSHIP_TYPE,
    node_id,
    node_level,
    unique_ids,
)


def audit_hierarchy(
    nodes: List[Dict[str, Any]], *, through_parent_level: int = 5
) -> Dict[str, int]:
    """Validate the many-to-many canonical graph and one-parent zoom view."""

    ids = [node_id(node) for node in nodes]
    if any(not value for value in ids):
        raise ValueError("Hierarchy contains a node without an id")
    if len(ids) != len(set(ids)):
        raise ValueError("Hierarchy contains duplicate node ids")

    node_by_id = {node_id(node): node for node in nodes}
    edge_ids = set()
    edge_count = 0
    for source in nodes:
        source_id = node_id(source)
        for edge in source.get("edges_out") or []:
            if not isinstance(edge, dict):
                raise ValueError(f"Node {source_id} contains a malformed edge")
            target_id = str(edge.get("to") or "").strip()
            if target_id not in node_by_id:
                raise ValueError(
                    f"Hierarchy contains dangling edge {source_id}->{target_id}"
                )
            if target_id == source_id:
                raise ValueError(f"Hierarchy contains self edge on {source_id}")
            edge_id = str(edge.get("id") or "").strip()
            if edge_id:
                if edge_id in edge_ids:
                    raise ValueError(f"Hierarchy contains duplicate edge id {edge_id}")
                edge_ids.add(edge_id)
            edge_count += 1

    membership_links = 0
    overlapping_children = 0
    projected_children = 0
    max_parent_level = min(5, through_parent_level)
    for parent_level in range(2, max_parent_level + 1):
        child_level = parent_level - 1
        children = [node for node in nodes if node_level(node) == child_level]
        parents = [node for node in nodes if node_level(node) == parent_level]
        valid_parent_ids = {node_id(parent) for parent in parents}
        expected_projection = {parent_id: set() for parent_id in valid_parent_ids}

        for child in children:
            child_id = node_id(child)
            memberships = child.get("memberships") or []
            if not isinstance(memberships, list):
                raise ValueError(f"Node {child_id} memberships must be a list")

            thematic = []
            membership_keys = set()
            for membership in memberships:
                if not isinstance(membership, dict):
                    raise ValueError(f"Node {child_id} has a malformed membership")
                parent_id = str(membership.get("parent_id") or "").strip()
                lens = str(membership.get("lens") or MEMBERSHIP_LENS).strip()
                role = str(membership.get("role") or "secondary").strip()
                parent = node_by_id.get(parent_id)
                if parent is None or node_level(parent) != parent_level:
                    raise ValueError(
                        f"Node {child_id} has invalid adjacent-tier membership {parent_id}"
                    )
                key = (parent_id, lens)
                if key in membership_keys:
                    raise ValueError(f"Node {child_id} has duplicate membership {key}")
                membership_keys.add(key)
                if lens == MEMBERSHIP_LENS:
                    if role not in {"primary", "secondary"}:
                        raise ValueError(
                            f"Node {child_id} has invalid membership role {role}"
                        )
                    thematic.append((parent_id, role))

            if not thematic:
                raise ValueError(
                    f"Hierarchy level {child_level}->{parent_level} has orphan child {child_id}"
                )
            primary_ids = [
                parent_id for parent_id, role in thematic if role == "primary"
            ]
            if len(primary_ids) != 1:
                raise ValueError(
                    f"Node {child_id} must have exactly one primary thematic membership"
                )
            primary_id = primary_ids[0]
            if str(child.get("parent_id") or "").strip() != primary_id:
                raise ValueError(
                    f"Node {child_id} parent_id does not match primary membership"
                )
            expected_projection[primary_id].add(child_id)
            membership_links += len(thematic)
            projected_children += 1
            if len(thematic) > 1:
                overlapping_children += 1

            edge_memberships = {
                (
                    str(edge.get("to") or "").strip(),
                    str(edge.get("relationship_subtype") or "").strip(),
                )
                for edge in (child.get("edges_out") or [])
                if isinstance(edge, dict)
                and str(edge.get("relationship_type") or "").strip()
                == MEMBERSHIP_RELATIONSHIP_TYPE
            }
            expected_edges = {
                (parent_id, f"{MEMBERSHIP_LENS}:{role}")
                for parent_id, role in thematic
            }
            if edge_memberships != expected_edges:
                raise ValueError(
                    f"Node {child_id} membership fields and edges disagree"
                )

        for parent in parents:
            parent_id = node_id(parent)
            actual = set(unique_ids(parent.get("children_ids") or []))
            if actual != expected_projection[parent_id]:
                raise ValueError(f"Parent {parent_id} projection mismatch")

    return {
        "node_count": len(nodes),
        "edge_count": edge_count,
        "membership_links": membership_links,
        "overlapping_children": overlapping_children,
        "projected_children": projected_children,
    }


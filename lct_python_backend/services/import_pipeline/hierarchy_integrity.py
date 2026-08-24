"""Pure graph-hierarchy and faithful-edge integrity helpers."""

from __future__ import annotations

import uuid
from typing import Any, Dict, Iterable, List, Optional


MEMBERSHIP_RELATIONSHIP_TYPE = "member_of"
MEMBERSHIP_LENS = "thematic"


class HierarchyOrphanError(ValueError):
    """An adjacent hierarchy tier leaves one or more children unclaimed."""

    def __init__(self, *, child_level: int, parent_level: int, orphan_count: int):
        self.child_level = child_level
        self.parent_level = parent_level
        self.orphan_count = orphan_count
        super().__init__(
            f"Hierarchy level {child_level}->{parent_level} has "
            f"{orphan_count} orphan child nodes"
        )


def node_level(node: Dict[str, Any]) -> int:
    try:
        return int(node.get("semantic_level") or node.get("level") or 1)
    except (TypeError, ValueError):
        return 1


def node_id(node: Dict[str, Any]) -> str:
    return str(node.get("id") or node.get("node_id") or "").strip()


def unique_ids(values: Iterable[Any]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        token = str(value or "").strip()
        if token and token not in seen:
            seen.add(token)
            result.append(token)
    return result


def uses_faithful_edge_representation(nodes: List[Dict[str, Any]]) -> bool:
    """Return whether every node carries the lossless ``edges_out`` contract.

    A partially faithful graph is ambiguous: choosing either persistence lane
    would silently discard the other representation. Fail before mutation so a
    caller must normalize the graph deliberately.
    """

    presence = ["edges_out" in node for node in nodes if isinstance(node, dict)]
    if any(presence) and not all(presence):
        raise ValueError(
            "Graph mixes faithful edges_out nodes with legacy-authored nodes; "
            "normalize one edge representation before hierarchy synchronization"
        )
    return bool(presence and all(presence))


def synchronize_hierarchy(
    nodes: List[Dict[str, Any]],
    *,
    through_parent_level: int = 5,
    materialize_membership_edges: Optional[bool] = None,
) -> Dict[str, int]:
    """Preserve overlapping memberships and derive one stable zoom projection.

    ``memberships`` plus ``member_of`` edges are the canonical, potentially
    many-to-many semantic structure. ``parent_id`` and parent ``children_ids``
    are a projection cache: exactly one primary parent is selected per child so
    the current drill-down UI can render a tree without erasing secondary
    affiliations.

    ``persist_graph`` selects its lossless relationship path when ``edges_out``
    is present. Therefore legacy-authored graphs keep canonical memberships only
    in ``memberships``; injecting even one membership ``edges_out`` key would
    hide their predecessor/successor and ``edge_relations`` fields. Faithful
    read-model graphs continue to materialize membership edges losslessly.
    """

    if materialize_membership_edges is None:
        materialize_membership_edges = uses_faithful_edge_representation(nodes)

    dangling_removed = 0
    parent_links_set = 0
    membership_links = 0
    overlapping_children = 0
    for parent_level in range(2, min(5, through_parent_level) + 1):
        child_level = parent_level - 1
        children = [node for node in nodes if node_level(node) == child_level]
        parents = [node for node in nodes if node_level(node) == parent_level]
        valid_child_ids = {node_id(child) for child in children}
        valid_parent_ids = {node_id(parent) for parent in parents}
        parent_order = {
            node_id(parent): index for index, parent in enumerate(parents)
        }
        memberships: Dict[str, List[str]] = {
            node_id(child): [] for child in children
        }
        confidence_by_pair: Dict[tuple[str, str], float] = {}
        primary_hints: Dict[str, List[str]] = {
            node_id(child): [] for child in children
        }

        for child in children:
            child_id = node_id(child)
            for membership in child.get("memberships") or []:
                if not isinstance(membership, dict):
                    continue
                parent_id = str(membership.get("parent_id") or "").strip()
                if parent_id not in valid_parent_ids:
                    continue
                memberships[child_id].append(parent_id)
                try:
                    confidence_by_pair[(child_id, parent_id)] = float(
                        membership.get("confidence", 1.0)
                    )
                except (TypeError, ValueError):
                    confidence_by_pair[(child_id, parent_id)] = 1.0
                if str(membership.get("role") or "").strip() == "primary":
                    primary_hints[child_id].append(parent_id)

            for edge in child.get("edges_out") or []:
                if not isinstance(edge, dict):
                    continue
                if str(edge.get("relationship_type") or "").strip() != MEMBERSHIP_RELATIONSHIP_TYPE:
                    continue
                parent_id = str(edge.get("to") or "").strip()
                if parent_id not in valid_parent_ids:
                    continue
                memberships[child_id].append(parent_id)
                try:
                    confidence_by_pair.setdefault(
                        (child_id, parent_id), float(edge.get("confidence", 1.0))
                    )
                except (TypeError, ValueError):
                    confidence_by_pair.setdefault((child_id, parent_id), 1.0)
                subtype = str(edge.get("relationship_subtype") or "").strip()
                if subtype.endswith(":primary"):
                    primary_hints[child_id].append(parent_id)

        for parent in parents:
            parent_id = node_id(parent)
            for child_id in unique_ids(parent.get("children_ids") or []):
                if child_id not in valid_child_ids:
                    dangling_removed += 1
                    continue
                memberships[child_id].append(parent_id)

        memberships = {
            child_id: sorted(
                unique_ids(parent_ids),
                key=lambda parent_id: (parent_order.get(parent_id, len(parents)), parent_id),
            )
            for child_id, parent_ids in memberships.items()
        }
        orphans = sorted(
            child_id for child_id, parent_ids in memberships.items() if not parent_ids
        )
        if orphans:
            raise HierarchyOrphanError(
                child_level=child_level,
                parent_level=parent_level,
                orphan_count=len(orphans),
            )

        primary_by_child: Dict[str, str] = {}
        for child in children:
            child_id = node_id(child)
            parent_ids = memberships[child_id]
            if len(parent_ids) > 1:
                overlapping_children += 1
            declared_parent = str(child.get("parent_id") or "").strip()
            hinted_primary = next(
                (
                    candidate
                    for candidate in primary_hints[child_id]
                    if candidate in parent_ids
                ),
                None,
            )
            desired_parent = (
                declared_parent
                if declared_parent in parent_ids
                else hinted_primary or parent_ids[0]
            )
            primary_by_child[child_id] = desired_parent
            if str(child.get("parent_id") or "") != desired_parent:
                parent_links_set += 1
            child["parent_id"] = desired_parent

            child["memberships"] = [
                {
                    "parent_id": parent_id,
                    "lens": MEMBERSHIP_LENS,
                    "role": "primary" if parent_id == desired_parent else "secondary",
                    "confidence": confidence_by_pair.get((child_id, parent_id), 1.0),
                }
                for parent_id in parent_ids
            ]
            membership_links += len(parent_ids)

            if materialize_membership_edges:
                non_membership_edges = [
                    dict(edge)
                    for edge in (child.get("edges_out") or [])
                    if isinstance(edge, dict)
                    and str(edge.get("relationship_type") or "").strip()
                    != MEMBERSHIP_RELATIONSHIP_TYPE
                ]
                membership_edges = []
                for membership in child["memberships"]:
                    parent_id = membership["parent_id"]
                    role = membership["role"]
                    stable_id = uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"lct:{MEMBERSHIP_LENS}:{child_id}:{parent_id}",
                    )
                    membership_edges.append(
                        {
                            "id": str(stable_id),
                            "to": parent_id,
                            "relationship_type": MEMBERSHIP_RELATIONSHIP_TYPE,
                            "relationship_subtype": f"{MEMBERSHIP_LENS}:{role}",
                            "explanation": "Semantic membership used to derive the zoom projection",
                            "strength": 1.0,
                            "confidence": membership["confidence"],
                            "is_bidirectional": False,
                            "supporting_utterance_ids": unique_ids(
                                child.get("utterance_ids") or []
                            ),
                        }
                    )
                child["edges_out"] = [*non_membership_edges, *membership_edges]
            else:
                child.pop("edges_out", None)

        projection_children: Dict[str, List[str]] = {
            parent_id: [] for parent_id in valid_parent_ids
        }
        for child in children:
            child_id = node_id(child)
            projection_children[primary_by_child[child_id]].append(child_id)
        for parent in parents:
            parent["children_ids"] = projection_children[node_id(parent)]

    for node in nodes:
        if node_level(node) == through_parent_level:
            node["parent_id"] = None
            node["memberships"] = []
            if materialize_membership_edges:
                node["edges_out"] = [
                    dict(edge)
                    for edge in (node.get("edges_out") or [])
                    if isinstance(edge, dict)
                    and str(edge.get("relationship_type") or "").strip()
                    != MEMBERSHIP_RELATIONSHIP_TYPE
                ]
            else:
                node.pop("edges_out", None)
    return {
        "dangling_removed": dangling_removed,
        "parent_links_set": parent_links_set,
        "membership_links": membership_links,
        "overlapping_children": overlapping_children,
    }


def synchronize_hierarchy_best_effort(
    nodes: List[Dict[str, Any]],
    *,
    through_parent_level: int = 5,
    required_parent_level: int = 2,
    materialize_membership_edges: Optional[bool] = None,
) -> Dict[str, int]:
    """Synchronize the highest complete hierarchy prefix.

    L1-L2 is the durable minimum and remains a hard invariant. If an optional
    tier is non-empty but incomplete, discard that tier and every tier above it
    before retrying. This keeps a partial L5 result from invalidating complete
    L1-L4 evidence while preserving strict failure for the required base.
    """

    if materialize_membership_edges is None:
        materialize_membership_edges = uses_faithful_edge_representation(nodes)
    target_level = min(5, max(required_parent_level, through_parent_level))
    dropped_levels: set[int] = set()

    while True:
        try:
            stats = synchronize_hierarchy(
                nodes,
                through_parent_level=target_level,
                materialize_membership_edges=materialize_membership_edges,
            )
            return {
                **stats,
                "highest_level": target_level,
                "optional_tiers_dropped": len(dropped_levels),
            }
        except HierarchyOrphanError as exc:
            if exc.parent_level <= required_parent_level:
                raise
            dropped_levels.update(range(exc.parent_level, target_level + 1))
            nodes[:] = [
                node for node in nodes if node_level(node) < exc.parent_level
            ]
            target_level = exc.parent_level - 1


def clean_faithful_edges(nodes: List[Dict[str, Any]]) -> Dict[str, int]:
    """Drop stale/dangling, duplicate, and cross-tier temporal relationships."""

    node_by_id = {node_id(node): node for node in nodes if node_id(node)}
    seen: set[tuple[str, str, str, str]] = set()
    dropped_dangling = 0
    dropped_duplicates = 0
    dropped_cross_tier_temporal = 0
    for source in nodes:
        source_id = node_id(source)
        cleaned: List[Dict[str, Any]] = []
        for edge in source.get("edges_out") or []:
            if not isinstance(edge, dict):
                continue
            target_id = str(edge.get("to") or "").strip()
            target = node_by_id.get(target_id)
            if target is None:
                dropped_dangling += 1
                continue
            relationship_type = str(edge.get("relationship_type") or "").strip()
            if relationship_type == "temporal" and node_level(source) != node_level(target):
                dropped_cross_tier_temporal += 1
                continue
            key = (
                source_id,
                target_id,
                relationship_type,
                str(edge.get("relationship_subtype") or "").strip(),
            )
            if key in seen:
                dropped_duplicates += 1
                continue
            seen.add(key)
            cleaned.append(dict(edge))
        source["edges_out"] = cleaned

        for field in ("predecessor", "successor"):
            target_id = str(source.get(field) or "").strip()
            target = node_by_id.get(target_id)
            if target_id and (target is None or node_level(source) != node_level(target)):
                source[field] = None

    return {
        "edges_dangling_dropped": dropped_dangling,
        "edges_duplicate_dropped": dropped_duplicates,
        "edges_cross_tier_temporal_dropped": dropped_cross_tier_temporal,
    }

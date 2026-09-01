"""Deterministic bounded windows for semantic edge enrichment.

The edge model cannot safely receive an arbitrarily large finalized graph in
one prompt.  This planner keeps every request below a hard node budget while
preserving the hierarchy needed to interpret local evidence:

* higher-order nodes (L3-L5) form an overlapping argument-backbone pass;
* L1/L2 focal nodes travel with their complete ancestor closure;
* adjacent L1 chunks are guaranteed to co-occur in at least one window.

Window construction is content-independent and deterministic.  A graph that
cannot satisfy the declared coverage contract within the configured budget is
rejected instead of being silently truncated.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Sequence, Tuple


MAX_EDGE_WINDOW_NODES = 30
EDGE_WINDOW_OVERLAP_FOCALS = 1


@dataclass(frozen=True)
class EdgeWindow:
    """One model request plus content-free planning metadata."""

    kind: str
    nodes: Tuple[Dict[str, Any], ...]
    focal_node_count: int


def _node_id(node: Dict[str, Any]) -> str:
    return str(node.get("id") or node.get("node_id") or "").strip()


def _node_level(node: Dict[str, Any]) -> int:
    try:
        return int(node.get("semantic_level") or node.get("level") or 1)
    except (TypeError, ValueError):
        return 1


def _chronological_key(
    node_id: str,
    *,
    by_id: Dict[str, Dict[str, Any]],
    order_by_id: Dict[str, int],
) -> Tuple[int, float, int]:
    raw = by_id[node_id].get("timestamp_start")
    try:
        timestamp = float(raw)
    except (TypeError, ValueError):
        return (1, 0.0, order_by_id[node_id])
    return (0, timestamp, order_by_id[node_id])


def _unique(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _parent_ids(node: Dict[str, Any], valid_ids: set[str]) -> List[str]:
    parents: List[str] = []
    declared = str(node.get("parent_id") or "").strip()
    if declared in valid_ids:
        parents.append(declared)
    for membership in node.get("memberships") or []:
        if not isinstance(membership, dict):
            continue
        parent_id = str(membership.get("parent_id") or "").strip()
        if parent_id in valid_ids:
            parents.append(parent_id)
    for edge in node.get("edges_out") or []:
        if not isinstance(edge, dict):
            continue
        if str(edge.get("relationship_type") or "").strip() != "member_of":
            continue
        parent_id = str(edge.get("to") or "").strip()
        if parent_id in valid_ids:
            parents.append(parent_id)
    return _unique(parents)


def _ancestor_closure(
    node_id: str,
    *,
    parents_by_id: Dict[str, List[str]],
    order_by_id: Dict[str, int],
) -> List[str]:
    pending = list(parents_by_id.get(node_id, []))
    seen: set[str] = set()
    while pending:
        parent_id = pending.pop(0)
        if parent_id in seen:
            continue
        seen.add(parent_id)
        pending.extend(parents_by_id.get(parent_id, []))
    return sorted(seen, key=lambda value: order_by_id[value])


def _materialize_window(
    *,
    kind: str,
    node_ids: Iterable[str],
    focal_count: int,
    by_id: Dict[str, Dict[str, Any]],
    order_by_id: Dict[str, int],
) -> EdgeWindow:
    ordered_ids = sorted(_unique(node_ids), key=lambda value: order_by_id[value])
    return EdgeWindow(
        kind=kind,
        nodes=tuple(by_id[node_id] for node_id in ordered_ids),
        focal_node_count=focal_count,
    )


def _pack_focals(
    *,
    kind: str,
    focal_ids: Sequence[str],
    ancestors_by_id: Dict[str, List[str]],
    by_id: Dict[str, Dict[str, Any]],
    order_by_id: Dict[str, int],
    max_nodes: int,
    overlap_focals: int,
) -> List[EdgeWindow]:
    windows: List[EdgeWindow] = []
    current_focals: List[str] = []

    def expanded(ids: Sequence[str]) -> List[str]:
        values: List[str] = []
        for focal_id in ids:
            values.extend(ancestors_by_id.get(focal_id, []))
            values.append(focal_id)
        return _unique(values)

    def append_current() -> None:
        if not current_focals:
            return
        windows.append(_materialize_window(
            kind=kind,
            node_ids=expanded(current_focals),
            focal_count=len(current_focals),
            by_id=by_id,
            order_by_id=order_by_id,
        ))

    for focal_id in focal_ids:
        candidate = [*current_focals, focal_id]
        if len(expanded(candidate)) <= max_nodes:
            current_focals = candidate
            continue

        if not current_focals:
            raise ValueError(
                f"edge_window_budget_exceeded: node {focal_id} and its ancestors "
                f"require more than {max_nodes} nodes"
            )
        append_current()

        retained = (
            current_focals[-overlap_focals:]
            if overlap_focals > 0
            else []
        )
        while retained and len(expanded([*retained, focal_id])) > max_nodes:
            retained = retained[1:]
        current_focals = [*retained, focal_id]
        if len(expanded(current_focals)) > max_nodes:
            raise ValueError(
                f"edge_window_budget_exceeded: node {focal_id} and its ancestors "
                f"require more than {max_nodes} nodes"
            )

    append_current()
    return windows


def plan_edge_windows(
    nodes: List[Dict[str, Any]],
    *,
    max_nodes: int = MAX_EDGE_WINDOW_NODES,
    overlap_focals: int = EDGE_WINDOW_OVERLAP_FOCALS,
) -> List[EdgeWindow]:
    """Return a complete, deterministic bounded-window coverage plan.

    Raises ``ValueError`` for missing/duplicate ids or a hierarchy closure that
    cannot fit.  Callers treat planning failures exactly like model failures.
    """
    if max_nodes < 2:
        raise ValueError("edge_window_budget must be at least 2")

    usable = [node for node in nodes if isinstance(node, dict)]
    ids = [_node_id(node) for node in usable]
    if any(not node_id for node_id in ids):
        raise ValueError("edge_window_graph_contains_missing_node_id")
    if len(ids) != len(set(ids)):
        raise ValueError("edge_window_graph_contains_duplicate_node_id")
    if not usable:
        return []
    if len(usable) <= max_nodes:
        return [EdgeWindow("full_graph", tuple(usable), len(usable))]

    by_id = dict(zip(ids, usable))
    order_by_id = {node_id: index for index, node_id in enumerate(ids)}
    valid_ids = set(ids)
    parents_by_id = {
        node_id: _parent_ids(by_id[node_id], valid_ids)
        for node_id in ids
    }
    ancestors_by_id = {
        node_id: _ancestor_closure(
            node_id,
            parents_by_id=parents_by_id,
            order_by_id=order_by_id,
        )
        for node_id in ids
    }

    higher_ids = [node_id for node_id in ids if _node_level(by_id[node_id]) >= 3]
    local_ids = sorted(
        [node_id for node_id in ids if _node_level(by_id[node_id]) <= 2],
        key=lambda node_id: _chronological_key(
            node_id, by_id=by_id, order_by_id=order_by_id
        ),
    )
    windows: List[EdgeWindow] = []
    if higher_ids:
        windows.extend(_pack_focals(
            kind="argument_backbone",
            focal_ids=higher_ids,
            ancestors_by_id=ancestors_by_id,
            by_id=by_id,
            order_by_id=order_by_id,
            max_nodes=max_nodes,
            overlap_focals=overlap_focals,
        ))
    if local_ids:
        windows.extend(_pack_focals(
            kind="local_evidence",
            focal_ids=local_ids,
            ancestors_by_id=ancestors_by_id,
            by_id=by_id,
            order_by_id=order_by_id,
            max_nodes=max_nodes,
            overlap_focals=overlap_focals,
        ))

    # Guarantee every chronological L1 boundary is visible.  The overlapping
    # pack normally satisfies this; targeted windows close any hierarchy-heavy
    # gap rather than silently missing a tangent/return or question/answer pair.
    chunk_ids = sorted(
        [node_id for node_id in ids if _node_level(by_id[node_id]) == 1],
        key=lambda node_id: _chronological_key(
            node_id, by_id=by_id, order_by_id=order_by_id
        ),
    )
    visible_pairs = {
        (left, right)
        for window in windows
        for left, right in zip(chunk_ids, chunk_ids[1:])
        if left in {_node_id(node) for node in window.nodes}
        and right in {_node_id(node) for node in window.nodes}
    }
    for left, right in zip(chunk_ids, chunk_ids[1:]):
        if (left, right) in visible_pairs:
            continue
        closure = _unique([
            *ancestors_by_id[left], left,
            *ancestors_by_id[right], right,
        ])
        if len(closure) > max_nodes:
            raise ValueError(
                "edge_window_budget_exceeded: adjacent chunk boundary and "
                f"ancestor context require more than {max_nodes} nodes"
            )
        windows.append(_materialize_window(
            kind="chronological_boundary",
            node_ids=closure,
            focal_count=2,
            by_id=by_id,
            order_by_id=order_by_id,
        ))

    covered_ids = {
        _node_id(node)
        for window in windows
        for node in window.nodes
    }
    if covered_ids != valid_ids:
        raise ValueError(
            f"edge_window_coverage_incomplete: covered={len(covered_ids)} "
            f"expected={len(valid_ids)}"
        )
    if any(len(window.nodes) > max_nodes for window in windows):
        raise ValueError("edge_window_budget_invariant_failed")
    return windows

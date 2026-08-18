"""Canonical identity handling for LLM-authored transcript graph batches.

Model-authored ids are scoped to one response.  The streaming processor merges
many responses into one graph, so those ids must be replaced before a batch
enters shared graph state.  This module owns that boundary transformation.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from typing import Any, Dict, List, Optional


_SCALAR_ID_FIELDS = ("parent_id", "predecessor", "successor")


def _clean_id(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _rewrite_reference(value: Any, id_map: Dict[str, str]) -> Any:
    reference = _clean_id(value)
    if not reference:
        return value
    return id_map.get(reference, reference)


def canonicalize_batch_node_ids(
    nodes: Iterable[Dict[str, Any]],
    *,
    existing_nodes: Optional[Iterable[Dict[str, Any]]] = None,
    id_factory: Optional[Callable[[], str]] = None,
) -> List[Dict[str, Any]]:
    """Return a batch with pipeline-owned ids and rewritten local references.

    The LLM may legitimately reuse ids such as ``chunk-001`` in later calls.
    Every node in a newly generated batch therefore receives a fresh id.  Id
    references to nodes in the same batch are rewritten; references to prior
    canonical nodes are preserved.

    Duplicate ids *inside one response* are rejected because their references
    are ambiguous and cannot be repaired without guessing.
    """

    batch = [dict(node) for node in nodes if isinstance(node, dict)]
    raw_ids: List[str] = []
    seen_raw_ids: set[str] = set()
    for index, node in enumerate(batch):
        raw_id = _clean_id(node.get("id") or node.get("node_id"))
        if not raw_id:
            # Normal production output already receives an id in the output
            # normalizer. Keep this boundary independently robust for legacy
            # callers and lightweight processor doubles: an id-less node has
            # no inbound reference that can be rewritten, so a private batch
            # key is unambiguous.
            raw_id = f"\0missing-node-id:{index}"
        if raw_id in seen_raw_ids:
            raise ValueError(
                "Generated graph batch contains duplicate node id "
                f"{raw_id!r}; hierarchy references are ambiguous"
            )
        seen_raw_ids.add(raw_id)
        raw_ids.append(raw_id)

    used_ids = {
        _clean_id(node.get("id") or node.get("node_id"))
        for node in (existing_nodes or [])
        if isinstance(node, dict)
    }
    used_ids.discard("")
    make_id = id_factory or (lambda: str(uuid.uuid4()))

    id_map: Dict[str, str] = {}
    for raw_id in raw_ids:
        canonical_id = ""
        for _ in range(100):
            canonical_id = _clean_id(make_id())
            if canonical_id and canonical_id not in used_ids:
                break
        else:
            raise RuntimeError("Unable to allocate a unique canonical node id")
        used_ids.add(canonical_id)
        id_map[raw_id] = canonical_id

    for node, raw_id in zip(batch, raw_ids):
        node["id"] = id_map[raw_id]
        node.pop("node_id", None)

        for field in _SCALAR_ID_FIELDS:
            if field in node:
                node[field] = _rewrite_reference(node.get(field), id_map)

        if isinstance(node.get("children_ids"), list):
            node["children_ids"] = [
                _rewrite_reference(child_id, id_map)
                for child_id in node["children_ids"]
            ]

        if isinstance(node.get("linked_nodes"), list):
            node["linked_nodes"] = [
                _rewrite_reference(related, id_map)
                for related in node["linked_nodes"]
            ]

        contextual = node.get("contextual_relation")
        if isinstance(contextual, dict):
            node["contextual_relation"] = {
                _rewrite_reference(related, id_map): explanation
                for related, explanation in contextual.items()
            }

        relations = node.get("edge_relations")
        if isinstance(relations, list):
            rewritten_relations = []
            for relation in relations:
                if not isinstance(relation, dict):
                    rewritten_relations.append(relation)
                    continue
                rewritten = dict(relation)
                for field in ("related_node", "related_node_id"):
                    if field in rewritten:
                        rewritten[field] = _rewrite_reference(rewritten[field], id_map)
                rewritten_relations.append(rewritten)
            node["edge_relations"] = rewritten_relations

    return batch

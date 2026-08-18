"""Repair incomplete adjacent-tier ownership without re-running extraction.

The streaming transcript model is asked to emit chunks (L1) and ideas (L2) in
each finalized batch.  Local models occasionally emit only chunks.  The raw
turn linkage is still complete, but those chunks disappear when a viewer zooms
out because no idea owns them.  This module repairs that narrow defect before
higher-order consolidation and can also repair an already-persisted graph.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Iterable, List, Optional, Sequence

from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    clean_faithful_edges,
    node_id as _node_id,
    node_level as _level,
    synchronize_hierarchy,
    unique_ids as _unique,
)
from lct_python_backend.services.import_pipeline.idea_repair_llm import (
    REPAIR_GROUP_BATCH_SIZE,
    call_repair_llm as _call_repair_llm,
    materialize_repaired_ideas,
)

logger = logging.getLogger("lct_backend")
REPAIR_BATCH_MAX_ATTEMPTS = 3


async def _repair_batch(
    batch: Sequence[Dict[str, Any]],
    providers: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Retry invalid model output for this batch without accepting partial data."""

    group_ids = [str(group.get("source_batch") or "") for group in batch]
    for attempt in range(1, REPAIR_BATCH_MAX_ATTEMPTS + 1):
        payload = await asyncio.to_thread(
            _call_repair_llm,
            batch,
            providers,
            skip_cache_read=attempt > 1,
        )
        try:
            return materialize_repaired_ideas(batch, payload)
        except ValueError as exc:
            if attempt >= REPAIR_BATCH_MAX_ATTEMPTS:
                raise ValueError(
                    "Chunk-to-idea repair failed validation after "
                    f"{attempt} attempts for source batches {group_ids}: {exc}"
                ) from exc
            logger.warning(
                "[HIERARCHY REPAIR] invalid response attempt=%d/%d groups=%s error=%s; retrying batch",
                attempt,
                REPAIR_BATCH_MAX_ATTEMPTS,
                group_ids,
                exc,
            )
    raise AssertionError("unreachable repair retry state")


async def _repair_batch_resilient(
    batch: Sequence[Dict[str, Any]],
    providers: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Bisect only provider-failed batches to fit slower local context lanes."""

    try:
        return await _repair_batch(batch, providers)
    except RuntimeError as exc:
        if "All LLM providers failed" not in str(exc) or len(batch) <= 1:
            raise
        midpoint = len(batch) // 2
        left = batch[:midpoint]
        right = batch[midpoint:]
        logger.warning(
            "[HIERARCHY REPAIR] provider failure for %d groups; "
            "splitting failed context window into %d+%d groups",
            len(batch),
            len(left),
            len(right),
        )
        return [
            *(await _repair_batch_resilient(left, providers)),
            *(await _repair_batch_resilient(right, providers)),
        ]

def _chunk_id(node: Dict[str, Any]) -> str:
    return str(node.get("chunk_id") or "").strip()


def _ordered(nodes: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def key(node: Dict[str, Any]):
        start = node.get("timestamp_start")
        try:
            start_key = float(start) if start is not None else float("inf")
        except (TypeError, ValueError):
            start_key = float("inf")
        return (start_key, _node_id(node))

    return sorted((node for node in nodes if isinstance(node, dict)), key=key)


def _group_level_one(nodes: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for node in _ordered(node for node in nodes if _level(node) == 1):
        group_id = _chunk_id(node)
        if not group_id:
            raise ValueError(f"Level-1 node {_node_id(node)!r} has no chunk_id")
        groups.setdefault(group_id, []).append(node)
    return groups


def _ideas_by_group(nodes: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for node in _ordered(node for node in nodes if _level(node) == 2):
        group_id = _chunk_id(node)
        if group_id:
            groups.setdefault(group_id, []).append(node)
    return groups


def _clean_group_ownership(
    chunks: List[Dict[str, Any]], ideas: List[Dict[str, Any]]
) -> int:
    """Attach unrepresented chunks without deleting overlapping memberships."""

    child_ids = [_node_id(child) for child in chunks]
    child_set = set(child_ids)
    idea_by_id = {_node_id(idea): idea for idea in ideas}
    first_parent: Dict[str, Dict[str, Any]] = {}

    for idea in ideas:
        cleaned: List[str] = []
        for child_id in _unique(idea.get("children_ids") or []):
            if child_id not in child_set:
                continue
            cleaned.append(child_id)
            first_parent.setdefault(child_id, idea)
        idea["children_ids"] = cleaned

    adopted = 0
    positions = {child_id: index for index, child_id in enumerate(child_ids)}
    for child in chunks:
        child_id = _node_id(child)
        if child_id in first_parent:
            continue

        declared = str(child.get("parent_id") or "").strip()
        parent = idea_by_id.get(declared)
        if parent is None:
            claimed = [cid for cid in child_ids if cid in first_parent]
            if claimed:
                nearest_id = min(
                    claimed,
                    key=lambda cid: abs(positions[cid] - positions[child_id]),
                )
                parent = first_parent[nearest_id]
            elif ideas:
                parent = ideas[0]
        if parent is None:
            continue
        parent.setdefault("children_ids", []).append(child_id)
        first_parent[child_id] = parent
        adopted += 1
    return adopted


def identify_missing_idea_groups(
    nodes: Sequence[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], int]:
    """Return L1 source batches with no L2 idea, adopting local stragglers."""

    chunk_groups = _group_level_one(nodes)
    idea_groups = _ideas_by_group(nodes)
    missing: List[Dict[str, Any]] = []
    adopted = 0
    for group_id, chunks in chunk_groups.items():
        ideas = idea_groups.get(group_id, [])
        if ideas:
            adopted += _clean_group_ownership(chunks, ideas)
            continue
        missing.append({"source_batch": group_id, "chunks": chunks})
    return missing, adopted


async def repair_chunk_idea_hierarchy(
    nodes: List[Dict[str, Any]],
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
    batch_size: int = REPAIR_GROUP_BATCH_SIZE,
) -> Dict[str, int]:
    """Make L1->L2 ownership complete, using small LLM calls only when needed."""

    missing_groups, adopted = identify_missing_idea_groups(nodes)
    created: List[Dict[str, Any]] = []
    for start in range(0, len(missing_groups), max(1, int(batch_size))):
        batch = missing_groups[start : start + max(1, int(batch_size))]
        created.extend(await _repair_batch_resilient(batch, providers))
    nodes.extend(created)
    sync_stats = synchronize_hierarchy(nodes, through_parent_level=2)
    logger.info(
        "[HIERARCHY REPAIR] groups=%d ideas_created=%d chunks_adopted=%d dangling_removed=%d",
        len(missing_groups),
        len(created),
        adopted,
        sync_stats["dangling_removed"],
    )
    return {
        "missing_groups": len(missing_groups),
        "ideas_created": len(created),
        "chunks_adopted": adopted,
        **sync_stats,
    }

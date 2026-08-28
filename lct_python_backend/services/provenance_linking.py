"""Deterministic leaf-node to utterance evidence localization.

Graph generation batches several transcript turns together, but provenance is
node-specific.  This module maps each L1 node's grounded ``source_excerpt``
back onto ordered transcript fragments without copying the whole batch onto
every node.  Callers retain their batch-level map separately for accounting.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple


def normalize_provenance_text(value: Any) -> str:
    """Return a Unicode-safe comparison form without changing stored text."""
    folded = str(value or "").casefold()
    return " ".join(
        "".join(char if char.isalnum() else " " for char in folded).split()
    )


def assign_grounded_leaf_utterance_ids(
    nodes: List[Dict[str, Any]],
    text_batch: Sequence[str],
    utterance_ids_batch: Sequence[Sequence[Any]],
) -> Dict[str, int]:
    """Attach precise direct evidence to generated level-one nodes.

    Existing authored IDs are preserved.  A grounded excerpt receives only IDs
    from transcript fragments it overlaps.  An unmatched excerpt fails closed
    to no direct evidence so a later persisted-data reconciler can retry.
    """
    fragment_spans: List[Tuple[int, int, List[str]]] = []
    transcript_parts: List[str] = []
    cursor = 0
    for index, fragment in enumerate(text_batch or []):
        normalized = normalize_provenance_text(fragment)
        ids: List[str] = []
        seen_ids: set[str] = set()
        slot_ids = utterance_ids_batch[index] if index < len(utterance_ids_batch) else []
        for raw_id in slot_ids or []:
            if raw_id is None:
                continue
            value = str(raw_id)
            if value in seen_ids:
                continue
            seen_ids.add(value)
            ids.append(value)
        if not normalized:
            continue
        start = cursor
        transcript_parts.append(normalized)
        cursor += len(normalized)
        fragment_spans.append((start, cursor, ids))
        cursor += 1

    transcript = " ".join(transcript_parts)
    search_cursor = 0
    linked_nodes = 0
    unmatched_nodes = 0
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        try:
            semantic_level = int(node.get("semantic_level") or node.get("level") or 1)
        except (TypeError, ValueError):
            semantic_level = 1
        if semantic_level != 1 or node.get("utterance_ids"):
            continue
        excerpt = normalize_provenance_text(node.get("source_excerpt"))
        if not excerpt or not transcript:
            unmatched_nodes += 1
            continue
        start = transcript.find(excerpt, search_cursor)
        if start < 0:
            start = transcript.find(excerpt)
        if start < 0:
            unmatched_nodes += 1
            continue
        end = start + len(excerpt)
        matched_ids: List[str] = []
        seen_matched: set[str] = set()
        for fragment_start, fragment_end, fragment_ids in fragment_spans:
            if fragment_end <= start or fragment_start >= end:
                continue
            for utterance_id in fragment_ids:
                if utterance_id in seen_matched:
                    continue
                seen_matched.add(utterance_id)
                matched_ids.append(utterance_id)
        if matched_ids:
            node["utterance_ids"] = matched_ids
            linked_nodes += 1
            search_cursor = end
        else:
            unmatched_nodes += 1
    return {"linked_nodes": linked_nodes, "unmatched_nodes": unmatched_nodes}

"""Helpers for live graph patch generation and speaker reconciliation."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from lct_python_backend.services.transcript_normalizer import format_speaker_prefixed_transcript


_WHITESPACE_RE = re.compile(r"\s+")


def clean_transcript_text(value: Any) -> str:
    return _WHITESPACE_RE.sub(" ", str(value or "")).strip()


def _matchable_text(value: Any) -> str:
    return clean_transcript_text(value).lower()


def source_texts_overlap(left: Any, right: Any) -> bool:
    left_text = _matchable_text(left)
    right_text = _matchable_text(right)
    if not left_text or not right_text:
        return False
    if left_text == right_text:
        return True
    if left_text in right_text or right_text in left_text:
        return True

    left_words = set(left_text.split())
    right_words = set(right_text.split())
    if not left_words or not right_words:
        return False

    overlap = len(left_words & right_words)
    minimum = max(2, min(len(left_words), len(right_words)) // 2)
    return overlap >= minimum


def primary_speaker_from_segments(segments: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    if not segments:
        return None

    speaker_weights: Dict[str, int] = {}
    for segment in segments:
        speaker = clean_transcript_text((segment or {}).get("speaker"))
        if not speaker:
            continue
        segment_text = clean_transcript_text((segment or {}).get("text"))
        speaker_weights[speaker] = speaker_weights.get(speaker, 0) + max(1, len(segment_text))

    if not speaker_weights:
        return None
    return max(speaker_weights, key=speaker_weights.get)


def should_emit_draft_update(text: Any, previous_text: Any = "") -> bool:
    clean_text = clean_transcript_text(text)
    if not clean_text:
        return False

    words = clean_text.split()
    if len(words) < 2 and len(clean_text) < 12:
        return False

    previous = clean_transcript_text(previous_text)
    if not previous:
        return True
    if clean_text == previous:
        return False

    if len(clean_text) - len(previous) >= 6:
        return True

    current_word_count = len(words)
    previous_word_count = len(previous.split())
    if current_word_count > previous_word_count:
        return True

    return clean_text.endswith((".", "!", "?", ";", ","))


def draft_label_from_text(text: Any, *, max_words: int = 8, max_chars: int = 56) -> str:
    clean_text = clean_transcript_text(text)
    if not clean_text:
        return "Draft"

    words = clean_text.split()
    preview = " ".join(words[:max_words])
    if len(preview) > max_chars:
        preview = preview[: max_chars - 1].rstrip() + "…"
    elif len(words) > max_words:
        preview = preview.rstrip() + "…"
    return preview or "Draft"


def build_draft_graph_patch(
    text: Any,
    *,
    node_id: str,
    chunk_id: str,
    speaker_segments: Optional[List[Dict[str, Any]]] = None,
    predecessor_id: Optional[str] = None,
) -> Dict[str, Any]:
    clean_text = clean_transcript_text(text)
    speaker_id = primary_speaker_from_segments(speaker_segments)
    node: Dict[str, Any] = {
        "id": node_id,
        "chunk_id": chunk_id,
        "node_name": draft_label_from_text(clean_text),
        "summary": clean_text,
        "node_text": clean_text,
        "source_excerpt": clean_text,
        "full_text": clean_text,
        "speaker_id": speaker_id,
        "predecessor": predecessor_id or "",
        "successor": "",
        "edge_relations": [],
        "contextual_relation": {},
        "thread_id": f"draft::{chunk_id}",
        "thread_state": "draft",
        "linked_nodes": [],
        "claims": [],
        "is_draft": True,
    }
    return {
        "kind": "draft",
        "nodes": [node],
        "chunks": {chunk_id: clean_text},
        "node_count": 1,
        "chunk_count": 1,
        "remove_node_ids": [],
        "remove_chunk_ids": [],
        "source_text": clean_text,
    }


def _find_matching_chunk_id(
    chunk_dict: Dict[str, str],
    *,
    source_text: Any,
) -> Optional[str]:
    normalized_source = clean_transcript_text(source_text)
    if not normalized_source:
        return None

    chunk_items = list((chunk_dict or {}).items())

    # Strategy 1: semantic overlap (existing logic)
    for chunk_id, chunk_text in reversed(chunk_items):
        if source_texts_overlap(chunk_text, normalized_source):
            return str(chunk_id)

    # Strategy 2: substring containment (case-insensitive)
    # Handles short diarization fragments like "um" or "Duh"
    source_lower = normalized_source.lower()
    for chunk_id, chunk_text in reversed(chunk_items):
        if source_lower in clean_transcript_text(chunk_text).lower():
            return str(chunk_id)

    # Strategy 3: most recent chunk (diarization runs on recent audio)
    if chunk_items:
        return str(chunk_items[-1][0])

    return None


def _find_nodes_for_source_text(
    existing_json: List[Dict[str, Any]],
    source_text: str,
) -> List[int]:
    """Find node indices whose source_excerpt or summary overlaps with source_text."""
    normalized = _matchable_text(source_text)
    if not normalized:
        return []

    matches = []
    for idx, node in enumerate(existing_json or []):
        if not isinstance(node, dict):
            continue
        for field in ("source_excerpt", "summary", "node_name"):
            field_text = _matchable_text(node.get(field))
            if field_text and (normalized in field_text or field_text in normalized):
                matches.append(idx)
                break
            if field_text and source_texts_overlap(field_text, normalized):
                matches.append(idx)
                break
    return matches


def build_speaker_reconciliation_patch(
    existing_json: List[Dict[str, Any]],
    chunk_dict: Dict[str, str],
    *,
    source_text: Any,
    segments: Optional[List[Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    if not segments:
        return None

    speaker_id = primary_speaker_from_segments(segments)
    if not speaker_id:
        return None

    chunk_id = _find_matching_chunk_id(chunk_dict or {}, source_text=source_text)

    updated_nodes: List[Dict[str, Any]] = []
    chunk_update: Dict[str, str] = {}

    if chunk_id:
        # Primary path: update all nodes in the matched chunk
        existing_chunk_text = clean_transcript_text((chunk_dict or {}).get(chunk_id))
        reconciled_chunk_text = str(
            format_speaker_prefixed_transcript(
                existing_chunk_text or source_text, segments
            ) or ""
        ).strip()

        for node in existing_json or []:
            if str((node or {}).get("chunk_id") or "") != chunk_id:
                continue
            updated = dict(node)
            updated["speaker_id"] = speaker_id
            updated_nodes.append(updated)

        if reconciled_chunk_text and clean_transcript_text(reconciled_chunk_text) != existing_chunk_text:
            chunk_update[chunk_id] = reconciled_chunk_text
    else:
        # Fallback: match directly against node text fields
        matched_indices = _find_nodes_for_source_text(existing_json or [], source_text)
        if not matched_indices and existing_json:
            # Last resort: update the most recent node
            matched_indices = [len(existing_json) - 1]

        for idx in matched_indices:
            node = existing_json[idx]
            if not isinstance(node, dict):
                continue
            updated = dict(node)
            updated["speaker_id"] = speaker_id
            updated_nodes.append(updated)

    if not updated_nodes and not chunk_update:
        return None

    return {
        "kind": "speaker_reconciliation",
        "nodes": updated_nodes,
        "chunks": chunk_update,
        "node_count": len(existing_json or []),
        "chunk_count": len(chunk_dict or {}),
        "remove_node_ids": [],
        "remove_chunk_ids": [],
        "chunk_id": chunk_id or "",
        "source_text": clean_transcript_text(source_text),
        "segments_count": len(segments or []),
        "speaker_id": speaker_id,
    }

"""Pure functions for cleaning and normalizing LLM-generated transcript output.

Extracted from transcript_processing.py — these are stateless transformation
functions that depend only on the standard library.
"""

import uuid
from typing import Any, Dict, List, Optional, Tuple


_THREAD_STATES = {"new_thread", "continue_thread", "return_to_thread"}
_RELATION_TYPES = {
    "supports",
    "rebuts",
    "clarifies",
    "asks",
    "tangent",
    "return_to_thread",
    "contextual",
    "temporal_next",
}
_SEMANTIC_TYPES = {"chunk", "idea", "topic", "theme"}


def _as_clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    seen = set()
    output: List[str] = []
    for item in value:
        text = _as_clean_str(item)
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(text)
    return output


def _as_clean_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    text = _as_clean_str(value)
    if not text:
        return None
    if text.isdigit():
        return int(text)
    return None


def _as_string_map(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    normalized: Dict[str, str] = {}
    for key, map_value in value.items():
        normalized_key = _as_clean_str(key)
        normalized_value = _as_clean_str(map_value)
        if normalized_key and normalized_value:
            normalized[normalized_key] = normalized_value
    return normalized


def _extract_contextual_relation_pair(value: Any) -> Tuple[str, str]:
    if not isinstance(value, dict):
        return "", ""
    related_node = _as_clean_str(
        value.get("related_node_name")
        or value.get("related_node")
        or value.get("relatedNode")
        or value.get("source")
        or value.get("from")
        or value.get("node")
    )
    relation_text = _as_clean_str(
        value.get("relation_text")
        or value.get("relationText")
        or value.get("description")
        or value.get("explanation")
    )
    return related_node, relation_text


def _looks_like_single_contextual_relation_object(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {str(key).strip() for key in value.keys()}
    if not keys:
        return False
    allowed = {
        "related_node_name",
        "related_node",
        "relatedNode",
        "source",
        "from",
        "node",
        "relation_text",
        "relationText",
        "description",
        "explanation",
        "relation_type",
        "type",
    }
    return keys.issubset(allowed)


def _normalize_contextual_relation(value: Any) -> Dict[str, str]:
    normalized: Dict[str, str] = {}

    def _add_entry(node_name: str, relation_text: str) -> None:
        related = _as_clean_str(node_name)
        text = _as_clean_str(relation_text)
        if not related or not text:
            return
        if related not in normalized:
            normalized[related] = text

    if isinstance(value, dict):
        if _looks_like_single_contextual_relation_object(value):
            related_node, relation_text = _extract_contextual_relation_pair(value)
            _add_entry(related_node, relation_text)
            return normalized

        for node_name, relation_text in _as_string_map(value).items():
            _add_entry(node_name, relation_text)
        return normalized

    if isinstance(value, list):
        for item in value:
            related_node, relation_text = _extract_contextual_relation_pair(item)
            if related_node and relation_text:
                _add_entry(related_node, relation_text)
                continue
            if isinstance(item, dict):
                for node_name, text in _as_string_map(item).items():
                    _add_entry(node_name, text)
        return normalized

    return normalized


def _slugify(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in value)
    slug = "-".join(segment for segment in cleaned.split("-") if segment)
    return slug[:48] or "untitled-thread"


def _normalize_thread_state(value: Any, predecessor: Optional[str]) -> str:
    raw = _as_clean_str(value).lower()
    if raw in _THREAD_STATES:
        return raw
    if "return" in raw:
        return "return_to_thread"
    if predecessor:
        return "continue_thread"
    return "new_thread"


def _normalize_relation_type(value: Any) -> str:
    raw = _as_clean_str(value).lower()
    if raw in _RELATION_TYPES:
        return raw
    if "support" in raw:
        return "supports"
    if "rebut" in raw or "contradict" in raw:
        return "rebuts"
    if "clarif" in raw:
        return "clarifies"
    if "question" in raw or "ask" in raw:
        return "asks"
    if "return" in raw:
        return "return_to_thread"
    if "tangent" in raw or "branch" in raw:
        return "tangent"
    return "contextual"


def _normalize_semantic_level(value: Any) -> int:
    raw = _as_clean_int(value)
    if raw and 1 <= raw <= 5:
        return raw
    # Default to 1 (chunk) — the safe granular tier. Defaulting to 2 (idea)
    # silently swallows missing-level LLM output and hides the chunk tier;
    # this caused refinement to flatten level-1 chunks into ideas.
    return 1


def _normalize_semantic_type(value: Any, semantic_level: int) -> str:
    raw = _as_clean_str(value).lower()
    if raw in _SEMANTIC_TYPES:
        return raw
    return {
        1: "chunk",
        2: "idea",
        3: "topic",
        4: "theme",
    }.get(semantic_level, "idea")


def _normalize_edge_relations(value: Any) -> List[Dict[str, str]]:
    if not isinstance(value, list):
        return []
    normalized: List[Dict[str, str]] = []
    seen = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        related_node = _as_clean_str(
            item.get("related_node")
            or item.get("relatedNode")
            or item.get("source")
            or item.get("from")
            or item.get("node")
        )
        relation_text = _as_clean_str(
            item.get("relation_text")
            or item.get("relationText")
            or item.get("description")
            or item.get("explanation")
        )
        relation_type = _normalize_relation_type(item.get("relation_type") or item.get("type"))
        if not related_node:
            continue
        if not relation_text:
            relation_text = f"{related_node} -> current node"
        key = (related_node, relation_type, relation_text)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "related_node": related_node,
                "relation_type": relation_type,
                "relation_text": relation_text,
            }
        )
    return normalized


def _normalize_generated_output(parsed: Any) -> List[Dict[str, Any]]:
    if isinstance(parsed, list):
        raw_nodes = parsed
        raw_edges = []
    elif isinstance(parsed, dict):
        if isinstance(parsed.get("nodes"), list):
            raw_nodes = parsed.get("nodes") or []
            raw_edges = parsed.get("edges") if isinstance(parsed.get("edges"), list) else []
        elif parsed.get("node_name") or parsed.get("title") or parsed.get("name"):
            raw_nodes = [parsed]
            raw_edges = []
        else:
            return []
    else:
        return []

    id_to_name: Dict[str, str] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue
        node_name = _as_clean_str(raw.get("node_name") or raw.get("title") or raw.get("name"))
        raw_id = _as_clean_str(raw.get("id") or raw.get("node_id"))
        if node_name and raw_id:
            id_to_name[raw_id] = node_name

    incoming_edges_by_target: Dict[str, List[Dict[str, str]]] = {}
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, dict):
            continue
        source_raw = _as_clean_str(raw_edge.get("source") or raw_edge.get("from") or raw_edge.get("from_node"))
        target_raw = _as_clean_str(raw_edge.get("target") or raw_edge.get("to") or raw_edge.get("to_node"))
        source_name = id_to_name.get(source_raw, source_raw)
        target_name = id_to_name.get(target_raw, target_raw)
        if not source_name or not target_name:
            continue
        entry = {
            "related_node": source_name,
            "relation_type": _normalize_relation_type(raw_edge.get("relation_type") or raw_edge.get("type")),
            "relation_text": _as_clean_str(
                raw_edge.get("relation_text")
                or raw_edge.get("description")
                or raw_edge.get("label")
            )
            or f"{source_name} -> {target_name}",
        }
        incoming_edges_by_target.setdefault(target_name, []).append(entry)

    normalized_nodes: List[Dict[str, Any]] = []
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue

        node_name = _as_clean_str(raw.get("node_name") or raw.get("title") or raw.get("name"))
        if not node_name:
            continue

        predecessor = _as_clean_str(raw.get("predecessor")) or None
        successor = _as_clean_str(raw.get("successor")) or None
        summary = _as_clean_str(raw.get("summary") or raw.get("node_text") or raw.get("text")) or node_name
        source_excerpt = _as_clean_str(raw.get("source_excerpt") or raw.get("source") or summary)
        semantic_level = _normalize_semantic_level(
            raw.get("semantic_level") or raw.get("level") or raw.get("zoom_level")
        )
        semantic_type = _normalize_semantic_type(
            raw.get("semantic_type") or raw.get("unit_type") or raw.get("node_type"),
            semantic_level,
        )
        contextual_relation = _normalize_contextual_relation(raw.get("contextual_relation"))
        edge_relations = _normalize_edge_relations(raw.get("edge_relations"))
        edge_relations.extend(incoming_edges_by_target.get(node_name, []))

        for relation in edge_relations:
            related_name = relation["related_node"]
            if related_name not in contextual_relation:
                contextual_relation[related_name] = relation["relation_text"]

        existing_edge_keys = {
            (
                relation.get("related_node", ""),
                relation.get("relation_type", ""),
                relation.get("relation_text", ""),
            )
            for relation in edge_relations
        }
        for related_name, relation_text in contextual_relation.items():
            contextual_edge = (related_name, "contextual", relation_text)
            if contextual_edge in existing_edge_keys:
                continue
            edge_relations.append(
                {
                    "related_node": related_name,
                    "relation_type": "contextual",
                    "relation_text": relation_text,
                }
            )
            existing_edge_keys.add(contextual_edge)

        linked_nodes = _as_string_list(raw.get("linked_nodes"))
        for related_name in contextual_relation:
            if related_name not in linked_nodes:
                linked_nodes.append(related_name)

        thread_id = _as_clean_str(raw.get("thread_id")) or f"thread::{_slugify(node_name)}"
        thread_state = _normalize_thread_state(raw.get("thread_state"), predecessor)
        parent_id = _as_clean_str(raw.get("parent_id") or raw.get("parent_node_id")) or None
        children_ids = _as_string_list(raw.get("children_ids") or raw.get("child_ids"))

        normalized_nodes.append(
            {
                "id": _as_clean_str(raw.get("id") or raw.get("node_id")) or str(uuid.uuid4()),
                "node_name": node_name,
                "summary": summary,
                "node_text": summary,
                "source_excerpt": source_excerpt,
                "semantic_level": semantic_level,
                "semantic_type": semantic_type,
                "level": semantic_level,
                "node_type": semantic_type,
                "parent_id": parent_id,
                "children_ids": children_ids,
                "predecessor": predecessor,
                "successor": successor,
                "contextual_relation": contextual_relation,
                "edge_relations": edge_relations,
                "thread_id": thread_id,
                "thread_state": thread_state,
                "linked_nodes": linked_nodes,
                "claims": _as_string_list(raw.get("claims")),
                "is_bookmark": bool(raw.get("is_bookmark")),
                "is_contextual_progress": bool(raw.get("is_contextual_progress")),
                # Carry the tangent/crux flags through to persistence. They were
                # silently dropped here, so the Node columns were always 0 no
                # matter what the model emitted — tangent/crux capture was never
                # actually exercised (see accumulate-echo-truncation-and-flag-drop).
                "is_tangent": bool(raw.get("is_tangent")),
                "is_crux": bool(raw.get("is_crux")),
                "chunk_id": raw.get("chunk_id"),
                "speaker_id": _as_clean_str(raw.get("speaker_id")) or None,
            }
        )
    return normalized_nodes


_UPWARD_PROPAGATED_FLAGS = ("is_tangent", "is_crux", "is_bookmark", "is_contextual_progress")


def propagate_flags_upward(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Bottom-up flag propagation across the tier hierarchy (mutates in place).

    is_tangent / is_crux (and bookmark / contextual_progress) are authored at the
    chunk tier (semantic_level 1). Consolidation builds topics/themes/arcs that
    reference children via children_ids but never copies these flags upward, so
    the zoomed-out map (which renders topics/themes/arcs) was flag-blind — a
    tangential cluster rolled up into a non-tangent topic, and crux navigation was
    impossible above level 2 (see ADR consistency audit H2). Here a parent carries
    a flag if it OR any descendant carries it.

    Nodes are processed in ascending semantic_level so every child is final before
    its parent reads it (children are always a strictly lower tier).
    """
    by_id: Dict[str, Dict[str, Any]] = {}
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        nid = str(node.get("id") or node.get("node_id") or "").strip()
        if nid:
            by_id[nid] = node

    def _level(node: Dict[str, Any]) -> int:
        raw = node.get("semantic_level") or node.get("level") or 0
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0

    ordered = sorted((n for n in (nodes or []) if isinstance(n, dict)), key=_level)
    for node in ordered:
        children = [
            by_id[str(cid)]
            for cid in (node.get("children_ids") or [])
            if str(cid) in by_id
        ]
        if not children:
            continue
        for flag in _UPWARD_PROPAGATED_FLAGS:
            if not node.get(flag) and any(bool(child.get(flag)) for child in children):
                node[flag] = True
    return nodes


def format_speaker_prefixed_transcript(
    text: str,
    speaker_segments: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Format transcript with speaker labels when diarized segments are available.

    Returns speaker-prefixed text like:
        [SPEAKER_00]: Hello there
        [SPEAKER_01]: Hi, how are you

    Falls back to plain text when no segments are available.
    """
    if not speaker_segments:
        return text

    lines: List[str] = []
    for seg in speaker_segments:
        speaker = seg.get("speaker", "")
        seg_text = str(seg.get("text", "")).strip()
        if not seg_text:
            continue
        if speaker:
            lines.append(f"[{speaker}]: {seg_text}")
        else:
            lines.append(seg_text)

    return "\n".join(lines) if lines else text

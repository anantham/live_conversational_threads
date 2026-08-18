"""Small-batch LLM adapter for synthesizing missing level-2 idea parents."""

from __future__ import annotations

import json
import uuid
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Sequence

from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    node_id,
    unique_ids,
)
from lct_python_backend.services.local_llm_client import (
    chat_with_provider_fallback_sync,
)

REPAIR_GROUP_BATCH_SIZE = 5
REPAIR_PROMPT_NAME = "repair_chunks_to_ideas"
REPAIR_PROMPT_VERSION = "v2-overlapping-memberships-2026-08-13"

_REPAIR_SYSTEM_PROMPT = """You repair one missing layer in a conversation hierarchy.

Input contains several independent source_batch groups. Each group contains
chronologically ordered level-1 chunk nodes from ONE finalized transcript
segment. Create one or more level-2 idea nodes for EACH group.

Rules:
- Never mix chunks from different source_batch groups.
- Every input chunk_id must appear in at least one output idea.
- A chunk may appear in more than one idea when it genuinely carries both
  meanings. Use overlap sparingly and only for substantive cross-cutting content.
- Preserve chunk order within each idea.
- Prefer 1-3 coherent ideas per group; do not create one idea per chunk unless
  the meanings are genuinely unrelated.
- node_name is a specific 5-10 word noun phrase.
- summary is one or two grounded sentences.
- Return JSON only in this shape:
  {"ideas": [{"source_batch": "...", "node_name": "...", "summary": "...",
               "children_ids": ["<chunk UUID>", ...]}]}
"""


def _simplify_groups(groups: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "source_batch": group["source_batch"],
            "chunks": [
                {
                    "id": node_id(chunk),
                    "node_name": str(chunk.get("node_name") or "").strip(),
                    "summary": str(chunk.get("summary") or "").strip(),
                }
                for chunk in group["chunks"]
            ],
        }
        for group in groups
    ]


def call_repair_llm(
    groups: Sequence[Dict[str, Any]],
    providers: Optional[List[Dict[str, Any]]],
    *,
    skip_cache_read: bool = False,
) -> Any:
    result = chat_with_provider_fallback_sync(
        messages=[
            {"role": "system", "content": _REPAIR_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(_simplify_groups(groups), ensure_ascii=False, indent=2),
            },
        ],
        providers=providers,
        temperature=0.2,
        max_tokens=4000,
        require_json=True,
        prompt_name=REPAIR_PROMPT_NAME,
        prompt_version=REPAIR_PROMPT_VERSION,
        skip_cache_read=skip_cache_read,
    )
    return result.data


def _majority(values: Iterable[Any]) -> Optional[str]:
    tokens = [str(value).strip() for value in values if str(value or "").strip()]
    return Counter(tokens).most_common(1)[0][0] if tokens else None


def _idea_from_raw(
    raw: Dict[str, Any],
    *,
    group_id: str,
    children: List[Dict[str, Any]],
) -> Dict[str, Any]:
    child_by_id = {node_id(child): child for child in children}
    child_ids = [
        cid for cid in unique_ids(raw.get("children_ids") or []) if cid in child_by_id
    ]
    utterance_ids = unique_ids(
        uid
        for child_id in child_ids
        for uid in (child_by_id[child_id].get("utterance_ids") or [])
    )
    excerpts = [
        str(child_by_id[child_id].get("source_excerpt") or "").strip()
        for child_id in child_ids
    ]
    return {
        "id": str(uuid.uuid4()),
        "node_name": str(raw.get("node_name") or "").strip(),
        "summary": str(raw.get("summary") or "").strip(),
        "source_excerpt": " ".join(value for value in excerpts if value)[:800],
        "semantic_level": 2,
        "semantic_type": "idea",
        "level": 2,
        "parent_id": None,
        "children_ids": child_ids,
        "predecessor": None,
        "successor": None,
        "thread_id": _majority(child.get("thread_id") for child in children),
        "thread_state": "new_thread",
        "contextual_relation": {},
        "edge_relations": [],
        "edges_out": [],
        "linked_nodes": [],
        "claims": [],
        "is_bookmark": any(bool(child.get("is_bookmark")) for child in children),
        "is_contextual_progress": any(
            bool(child.get("is_contextual_progress")) for child in children
        ),
        "is_tangent": any(bool(child.get("is_tangent")) for child in children),
        "is_crux": any(bool(child.get("is_crux")) for child in children),
        "chunk_id": group_id,
        "utterance_ids": utterance_ids,
        "speaker_id": _majority(child.get("speaker_id") for child in children),
    }


def materialize_repaired_ideas(
    groups: Sequence[Dict[str, Any]], payload: Any
) -> List[Dict[str, Any]]:
    """Validate one repair response and return complete L2 idea nodes."""

    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        raise ValueError("Chunk-to-idea repair response must be a JSON object")
    raw_ideas = payload.get("ideas") or payload.get("nodes") or []
    if not isinstance(raw_ideas, list):
        raise ValueError("Chunk-to-idea repair response 'ideas' must be a list")

    group_by_id = {str(group["source_batch"]): group for group in groups}
    output: List[Dict[str, Any]] = []
    for group_id, group in group_by_id.items():
        children = list(group["chunks"])
        child_ids = [node_id(child) for child in children]
        valid_ids = {node_id(child) for child in children}
        group_raw = [
            raw
            for raw in raw_ideas
            if isinstance(raw, dict)
            and str(raw.get("source_batch") or "").strip() == group_id
            and str(raw.get("node_name") or "").strip()
        ]
        if not group_raw:
            raise ValueError(f"Repair response omitted source_batch {group_id}")

        owners: Dict[str, int] = {}
        ideas: List[Dict[str, Any]] = []
        for raw in group_raw:
            idea = _idea_from_raw(raw, group_id=group_id, children=children)
            cleaned: List[str] = []
            for child_id in idea["children_ids"]:
                if child_id in valid_ids:
                    owners.setdefault(child_id, len(ideas))
                    cleaned.append(child_id)
            idea["children_ids"] = cleaned
            if cleaned:
                ideas.append(idea)
        if not ideas and len(group_raw) == 1:
            fallback_raw = dict(group_raw[0])
            fallback_raw["children_ids"] = child_ids
            idea = _idea_from_raw(fallback_raw, group_id=group_id, children=children)
            ideas = [idea]
            owners = {child_id: 0 for child_id in child_ids}
        if not ideas:
            raise ValueError(f"Repair response produced no valid ideas for source_batch {group_id}")

        positions = {child_id: index for index, child_id in enumerate(child_ids)}
        for child_id in child_ids:
            if child_id in owners:
                continue
            nearest_id = min(
                owners,
                key=lambda cid: abs(positions[cid] - positions[child_id]),
            )
            owner_index = owners[nearest_id]
            ideas[owner_index]["children_ids"].append(child_id)
            owners[child_id] = owner_index

        for idea in ideas:
            by_id = {node_id(child): child for child in children}
            idea["utterance_ids"] = unique_ids(
                uid
                for child_id in idea["children_ids"]
                for uid in (by_id[child_id].get("utterance_ids") or [])
            )
        output.extend(ideas)
    return output

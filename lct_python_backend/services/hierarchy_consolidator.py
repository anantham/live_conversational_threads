"""Post-streaming hierarchy consolidation.

The streaming graph-generation LLM authors a per-batch tier-1/tier-2
(chunks + ideas) graph correctly — but it never sees the whole conversation,
so it can't cluster ideas into meaningful topics or topics into themes
across batches. The result was tier inflation: 107 topics + 100 themes for
147 ideas (i.e. ~1:1 with no real compression).

This module fixes that by running THREE focused LLM consolidation passes
over the completed graph, each seeing its whole input tier at once:

    ideas (N)  →  consolidate_ideas_to_topics      →  topics (8-15)
    topics     →  consolidate_topics_to_themes     →  themes (4-8)
    themes     →  consolidate_themes_to_arcs       →  arcs (2-5)
                                                   +  conversation_title
                                                   +  executive_summary

Each pass emits new nodes (semantic_level 3/4/5) that reference the prior
tier's nodes via children_ids. A child may appear under multiple parents when
its meaning is genuinely cross-cutting; hierarchy synchronization preserves
those memberships and derives one primary zoom projection. The arcs pass also
produces a one-line title and a 3-sentence summary for the conversation banner.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from lct_python_backend.services.local_llm_client import chat_with_provider_fallback_sync
from lct_python_backend.services.prompt_manager import get_prompt_manager

logger = logging.getLogger(__name__)


_TIER_LABEL = {3: "topic", 4: "theme", 5: "arc"}
_TIER_PROMPT_ID = {
    3: "consolidate_ideas_to_topics",
    4: "consolidate_topics_to_themes",
    5: "consolidate_themes_to_arcs",
}


def _simplify_for_consolidation(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Slim node payload — the LLM only needs identity + meaning, not the full graph."""
    out: List[Dict[str, Any]] = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        nid = str(n.get("id") or n.get("node_id") or "").strip()
        if not nid:
            continue
        out.append({
            "id": nid,
            "node_name": str(n.get("node_name") or "").strip(),
            "summary": str(n.get("summary") or n.get("node_text") or "").strip(),
            "thread_id": str(n.get("thread_id") or "").strip() or None,
            "thread_label": str(n.get("thread_label") or "").strip() or None,
        })
    return out


def _run_consolidation_llm(
    input_nodes: List[Dict[str, Any]],
    *,
    target_tier: int,
    providers: Optional[List[Dict[str, Any]]],
) -> tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Single LLM call: input tier (slim list) → output tier (clustered).

    Returns (parent_nodes, extras). For the arcs pass, extras may include
    {"conversation_title": str, "executive_summary": str}.
    """
    prompt_id = _TIER_PROMPT_ID[target_tier]
    mgr = get_prompt_manager()
    prompt_config = mgr.get_prompt(prompt_id)
    system_prompt = str(prompt_config.get("template") or "")
    if "thread_label" not in system_prompt:
        system_prompt += (
            "\n\nFor every node with a thread_id, also return thread_label: a concise "
            "3-10 word human-readable subject name. Never use hashes, counters, "
            "or generic labels such as 'Topic 3'."
        )
    prompt_metadata = {
        "temperature": prompt_config.get("temperature", 0.3),
        "max_tokens": prompt_config.get("max_tokens", 4000),
        "version": prompt_config.get("version"),
    }

    simplified = _simplify_for_consolidation(input_nodes)
    if len(simplified) < 2:
        # Not enough material to consolidate. Skip.
        return [], None

    user_prompt = (
        f"Input nodes ({len(simplified)} of tier {target_tier - 1}):\n"
        f"{json.dumps(simplified, ensure_ascii=False, indent=2)}"
    )

    try:
        provider_result = chat_with_provider_fallback_sync(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            providers=providers,
            temperature=float(prompt_metadata.get("temperature", 0.3)),
            max_tokens=int(prompt_metadata.get("max_tokens", 6000)),
            require_json=True,
            prompt_name=prompt_id,
            prompt_version=prompt_metadata.get("version"),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[CONSOLIDATE tier=%d] LLM call failed: %s", target_tier, exc)
        return [], None

    payload = provider_result.data
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            logger.warning("[CONSOLIDATE tier=%d] non-JSON payload", target_tier)
            return [], None
    if not isinstance(payload, dict):
        logger.warning("[CONSOLIDATE tier=%d] payload not a dict: %r", target_tier, type(payload))
        return [], None

    raw_nodes = payload.get("nodes") or payload.get(_TIER_LABEL[target_tier] + "s") or []
    if not isinstance(raw_nodes, list):
        logger.warning("[CONSOLIDATE tier=%d] 'nodes' is not a list", target_tier)
        return [], None

    input_ids = {str(n["id"]) for n in simplified}
    input_by_id = {str(n["id"]): n for n in simplified}
    parents: List[Dict[str, Any]] = []
    semantic_type = _TIER_LABEL[target_tier]

    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue
        children_raw = raw.get("children_ids") or raw.get("child_ids") or []
        if not isinstance(children_raw, list):
            continue
        # Keep only children that exist in the input set
        children_ids = [str(c) for c in children_raw if str(c) in input_ids]
        if not children_ids:
            continue
        node_name = str(raw.get("node_name") or "").strip()
        if not node_name:
            continue
        thread_id = str(raw.get("thread_id") or "").strip() or None
        inherited_labels = {
            str(input_by_id[child_id].get("thread_label") or "").strip()
            for child_id in children_ids
            if child_id in input_by_id
            and input_by_id[child_id].get("thread_id") == thread_id
            and str(input_by_id[child_id].get("thread_label") or "").strip()
        }
        thread_label = (
            str(raw.get("thread_label") or "").strip()
            or (next(iter(inherited_labels)) if len(inherited_labels) == 1 else "")
            or (node_name if thread_id else None)
        )
        parents.append({
            "id": str(raw.get("id") or "").strip() or f"{semantic_type}-{uuid.uuid4().hex[:8]}",
            "node_name": node_name,
            "summary": str(raw.get("summary") or "").strip(),
            "node_text": str(raw.get("summary") or "").strip(),
            "source_excerpt": "",
            "semantic_level": target_tier,
            "semantic_type": semantic_type,
            "level": target_tier,
            "node_type": semantic_type,
            "parent_id": None,
            "children_ids": children_ids,
            "predecessor": None,
            "successor": None,
            "thread_id": thread_id,
            "thread_label": thread_label,
            "thread_state": "new_thread",
            "contextual_relation": {},
            "edge_relations": [],
            "linked_nodes": [],
            "claims": [],
            "argument_role": "context",
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": None,
            "speaker_id": None,
        })

    extras: Optional[Dict[str, Any]] = None
    if target_tier == 5:
        extras = {
            "conversation_title": str(payload.get("conversation_title") or "").strip() or None,
            "executive_summary": str(payload.get("executive_summary") or "").strip() or None,
        }

    logger.info(
        "[CONSOLIDATE tier=%d] %d input → %d output (model=%s)",
        target_tier, len(simplified), len(parents), provider_result.model,
    )
    return parents, extras


def adopt_orphans(children: List[Dict[str, Any]],
                  parents: List[Dict[str, Any]]) -> int:
    """Attach every child no parent claimed to its nearest claimed neighbour's
    parent. Returns how many were adopted.

    WHY: the prompt requires every child to have at least one membership, but
    the model does not always obey it. Measured on a real
    1,125-turn conversation (2026-08-12): **16 of 82 ideas were claimed by no
    topic at all**, so a sixth of the conversation was invisible at every zoom
    level above L2 — silently, because nothing counted the leftovers.

    Deterministic, no second model call: ideas arrive in conversation order,
    so an unclaimed idea belongs with whatever its neighbours belong to. We
    walk outward from the orphan's position to the closest claimed sibling and
    join that parent. The guesser never holds the pen — this is arithmetic on
    ordering the model already committed to, not a fresh guess about meaning.
    """
    ids = [str(c.get("id") or "") for c in children]
    pos = {cid: i for i, cid in enumerate(ids) if cid}
    owner: Dict[str, Dict[str, Any]] = {}
    for p in parents:
        for cid in (p.get("children_ids") or []):
            owner.setdefault(str(cid), p)
    orphans = [cid for cid in ids if cid and cid not in owner]
    if not orphans or not owner:
        return 0
    claimed_positions = sorted(pos[c] for c in owner if c in pos)
    if not claimed_positions:
        return 0
    adopted = 0
    for cid in orphans:
        i = pos.get(cid)
        if i is None:
            continue
        nearest = min(claimed_positions, key=lambda j: abs(j - i))
        parent = owner.get(ids[nearest])
        if parent is None:
            continue
        parent.setdefault("children_ids", []).append(cid)
        owner[cid] = parent          # so later orphans can chain onto it
        adopted += 1
    if adopted:
        logger.info("[CONSOLIDATE] adopted %d orphaned child node(s) into the "
                    "nearest neighbouring parent", adopted)
    return adopted


async def consolidate_ideas_to_topics(
    ideas: List[Dict[str, Any]],
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Cluster all ideas into 8-15 topics (semantic_level 3).

    Leftovers are ADOPTED rather than dropped (see ``adopt_orphans``): the
    model routinely leaves ideas unclaimed despite the prompt forbidding it,
    and an unclaimed idea is invisible above L2."""
    import asyncio
    parents, _ = await asyncio.to_thread(
        _run_consolidation_llm, ideas, target_tier=3, providers=providers,
    )
    if parents:
        adopt_orphans(ideas, parents)
    return parents


async def consolidate_topics_to_themes(
    topics: List[Dict[str, Any]],
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Cluster all topics into 4-8 themes (semantic_level 4). Leftover topics
    are adopted too — an unclaimed topic hides its whole subtree."""
    import asyncio
    parents, _ = await asyncio.to_thread(
        _run_consolidation_llm, topics, target_tier=4, providers=providers,
    )
    if parents:
        adopt_orphans(topics, parents)
    return parents


async def consolidate_themes_to_arcs(
    themes: List[Dict[str, Any]],
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> tuple[List[Dict[str, Any]], Optional[str], Optional[str]]:
    """Cluster all themes into 2-5 arcs (semantic_level 5) and also emit
    a conversation_title (string) and executive_summary (string).

    Returns (arcs, conversation_title, executive_summary).
    """
    import asyncio
    parents, extras = await asyncio.to_thread(
        _run_consolidation_llm, themes, target_tier=5, providers=providers,
    )
    if parents:
        adopt_orphans(themes, parents)
    title = (extras or {}).get("conversation_title")
    summary = (extras or {}).get("executive_summary")
    return parents, title, summary

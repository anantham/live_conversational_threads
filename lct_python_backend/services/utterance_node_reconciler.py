"""Post-hoc reconciliation of utterance <-> node links for the live STT path.

The live STT pipeline writes ``Utterance`` rows and ``Node`` rows as two
disconnected sets: utterances stream in and are persisted incrementally, while
chunk/idea nodes are (re)generated from accumulated text. At chunk-emission
time the utterances usually have no DB id yet, so Option B's
``chunk_utterance_map`` comes out empty and ``node.utterance_ids`` /
``utterance.chunk_id`` / ``utterance.node_id`` never get set. Downstream this
breaks a cluster of things: ``_compute_speaker_rollup`` can't find a node's
speakers (node.speaker_info stays NULL), the NodeDetail speaker rename can't
resolve a node to its utterances, and audio-seek degrades.

This module reconciles them AFTER both sides are persisted. Each L1 (chunk)
node's ``source_excerpt`` is the verbatim transcript text it covers, so the
ordered utterances are localized against the reconstructed transcript and each
chunk's excerpt is found within it — assignment is by character-offset overlap,
which needs no node-ordering column (live nodes share a batch ``created_at``
and often lack timestamps). Once linked, each L1 node's ``speaker_info`` is
derived from its utterances' diarization ``speaker_id``, and both
``utterance_ids`` + ``speaker_info`` bubble up to higher tiers via
``children_ids``.

Used by:
  - the live post-flush sequence in ``stt_ws_session`` (one pass at session end)
  - ``scripts/backfill_live_utterance_links.py`` (existing live conversations)

Idempotent — safe to re-run; it recomputes the linkage from scratch each time.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select

logger = logging.getLogger("lct_backend")

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def _normalize(text: Optional[str]) -> str:
    """Lowercase, fold every non-alphanumeric run to a single space, strip.

    Punctuation and whitespace differences between an utterance's stored text
    and the chunk's ``source_excerpt`` (which may have been cleaned/linearized
    differently) would otherwise defeat substring matching.
    """
    if not text:
        return ""
    return _NON_ALNUM_RE.sub(" ", str(text).lower()).strip()


def _derive_speaker_info(speaker_ids: List[str]) -> Optional[Dict[str, Any]]:
    """Build a node ``speaker_info`` dict from its utterances' diarization
    ``speaker_id`` values. Mirrors the ``{primary_speaker,
    speaker_distribution}`` shape ``_compute_speaker_rollup`` produces from
    excerpt prefixes, plus a ``speakers`` list for the rename fallback
    (``speaker_naming_service._resolve_speaker_id_via_nodes`` reads it).
    """
    counts = Counter(s for s in speaker_ids if s)
    if not counts:
        return None
    primary, _ = counts.most_common(1)[0]
    return {
        "primary_speaker": primary,
        "speakers": sorted(counts.keys()),
        "speaker_distribution": dict(counts),
        "source": "utterance_reconciler",
    }


async def reconcile_conversation_links(
    conversation_id: Any,
    *,
    db=None,
) -> Dict[str, Any]:
    """Link utterances <-> nodes for one conversation and derive node speaker_info.

    Args:
        conversation_id: the conversation UUID (str or ``uuid.UUID``).
        db: optional ``AsyncSession``. When omitted, opens its own session —
            the live runtime and backfill script run outside FastAPI's DI.

    Returns:
        A summary dict (counts of utterances linked, nodes touched, etc.).
        Raises only on a genuinely broken call (the live caller wraps this so
        a failure never aborts the session).
    """
    if db is None:
        from lct_python_backend.db_session import get_async_session_context

        async with get_async_session_context() as own_db:
            return await _reconcile(conversation_id, own_db)
    return await _reconcile(conversation_id, db)


async def _reconcile(conversation_id: Any, db) -> Dict[str, Any]:
    from lct_python_backend.models import Node, Utterance

    try:
        conv_uuid = uuid.UUID(str(conversation_id))
    except (TypeError, ValueError):
        logger.warning("[reconciler] invalid conversation_id: %r", conversation_id)
        return {"conversation_id": str(conversation_id), "error": "invalid_uuid"}

    nodes = list(
        (
            await db.execute(select(Node).where(Node.conversation_id == conv_uuid))
        ).scalars().all()
    )
    utterances = list(
        (
            await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conv_uuid)
                .order_by(Utterance.sequence_number)
            )
        ).scalars().all()
    )

    summary: Dict[str, Any] = {
        "conversation_id": str(conv_uuid),
        "utterances": len(utterances),
        "l1_nodes": 0,
        "linked_utterances": 0,
        "fk_linked": 0,
        "unmatched_utterances": 0,
        "nodes_with_speaker_info": 0,
        "higher_tier_nodes": 0,
    }
    if not nodes or not utterances:
        return summary

    l1_nodes = [n for n in nodes if (n.level or 1) == 1]
    summary["l1_nodes"] = len(l1_nodes)
    if not l1_nodes:
        return summary

    node_to_utts: Dict[uuid.UUID, List[uuid.UUID]] = {n.id: [] for n in l1_nodes}
    node_to_speakers: Dict[uuid.UUID, List[str]] = {n.id: [] for n in l1_nodes}

    # Chunk-FK pre-pass. Imports (and pre-fix live convos) carry node.chunk_ids
    # + utterance.chunk_id authored at persist time but never linked into
    # node.utterance_ids. A direct FK join links them losslessly — no
    # source_excerpt needed (the text-match pass below only reaches the ~7% of
    # import nodes that have an excerpt; this pre-pass reaches every node whose
    # chunk_id has utterances). Utterances claimed here are skipped downstream.
    #
    # ONLY FK-link a chunk owned by EXACTLY ONE L1 node. Generation can stamp a
    # single chunk_id onto several L1 nodes of one batch (transcript_processing),
    # and the node query is unordered — FK-assigning a shared chunk would dump all
    # its utterances onto whichever node came back first and leave the siblings
    # empty (mis-attribution + wrong bubble-up/counts). Ambiguous chunks fall
    # through to the source_excerpt text-match, which resolves per node by offset.
    claimed_utt_ids: set = set()
    utts_by_chunk: Dict[Any, List[Any]] = {}
    for utt in utterances:
        if utt.chunk_id is not None:
            utts_by_chunk.setdefault(utt.chunk_id, []).append(utt)
    if utts_by_chunk:
        chunk_owners: Dict[Any, int] = {}
        for node in l1_nodes:
            for cid in set(node.chunk_ids or []):
                chunk_owners[cid] = chunk_owners.get(cid, 0) + 1
        for node in l1_nodes:
            for cid in (node.chunk_ids or []):
                if chunk_owners.get(cid, 0) != 1:
                    continue  # shared/ambiguous chunk → defer to text-match
                for utt in utts_by_chunk.get(cid, []):
                    if utt.id in claimed_utt_ids:
                        continue
                    utt.node_id = node.id
                    node_to_utts[node.id].append(utt.id)
                    node_to_speakers[node.id].append(utt.speaker_id)
                    claimed_utt_ids.add(utt.id)
                    summary["linked_utterances"] += 1
                    summary["fk_linked"] += 1

    # Reconstruct the transcript from ordered utterances, recording each
    # utterance's [start, end) char span in the normalized concatenation.
    parts: List[str] = []
    utt_spans: List[Tuple[Any, Optional[int], Optional[int]]] = []
    cursor = 0
    for utt in utterances:
        norm = _normalize(utt.text_cleaned or utt.text)
        if not norm:
            utt_spans.append((utt, None, None))
            continue
        start = cursor
        parts.append(norm)
        cursor += len(norm)
        utt_spans.append((utt, start, cursor))
        cursor += 1  # the joining space
    full_text = " ".join(parts)

    # Locate each L1 chunk's excerpt inside the reconstructed transcript.
    # Offset overlap (below) then assigns utterances — no node-order column
    # needed, which matters because live nodes share a batch created_at.
    chunk_spans: List[Tuple[Any, int, int]] = []
    for node in l1_nodes:
        exc = _normalize(node.source_excerpt)
        if not exc:
            continue
        pos = full_text.find(exc)
        if pos < 0:
            continue
        chunk_spans.append((node, pos, pos + len(exc)))
    chunk_spans.sort(key=lambda t: t[1])

    for utt, start, end in utt_spans:
        if utt.id in claimed_utt_ids:
            continue  # already linked by the chunk-FK pre-pass
        if start is None:
            summary["unmatched_utterances"] += 1
            continue
        midpoint = (start + end) / 2.0
        assigned = None
        for node, cstart, cend in chunk_spans:
            if cstart <= midpoint < cend:
                assigned = node
                break
        if assigned is None:
            summary["unmatched_utterances"] += 1
            continue
        utt.chunk_id = (assigned.chunk_ids or [None])[0]
        utt.node_id = assigned.id
        node_to_utts[assigned.id].append(utt.id)
        node_to_speakers[assigned.id].append(utt.speaker_id)
        summary["linked_utterances"] += 1

    # Write L1 node.utterance_ids + speaker_info from the linked utterances.
    for node in l1_nodes:
        node.utterance_ids = list(node_to_utts.get(node.id) or [])
        info = _derive_speaker_info(node_to_speakers.get(node.id) or [])
        if info:
            node.speaker_info = info
            summary["nodes_with_speaker_info"] += 1

    # Bubble utterance_ids + speaker_info UP to higher tiers via children_ids.
    node_by_id = {n.id: n for n in nodes}
    utt_speaker = {u.id: u.speaker_id for u in utterances}
    for node in nodes:
        if (node.level or 1) <= 1:
            continue
        descendant_utts = _collect_descendant_utterances(node, node_by_id, node_to_utts)
        if not descendant_utts:
            continue
        node.utterance_ids = descendant_utts
        info = _derive_speaker_info([utt_speaker.get(uid, "") for uid in descendant_utts])
        if info:
            node.speaker_info = info
        summary["higher_tier_nodes"] += 1

    # Defensive: every utterance should end up either linked (FK pre-pass or
    # text-match) or counted unmatched. A mismatch means a linkage path leaked;
    # warn loudly but do NOT raise — the live caller must not abort on this.
    accounted = summary["linked_utterances"] + summary["unmatched_utterances"]
    if accounted != summary["utterances"]:
        logger.warning(
            "[reconciler] conversation=%s utterance accounting mismatch: "
            "linked(%d)+unmatched(%d)=%d != total(%d)",
            summary["conversation_id"],
            summary["linked_utterances"],
            summary["unmatched_utterances"],
            accounted,
            summary["utterances"],
        )

    await db.commit()
    logger.info(
        "[reconciler] conversation=%s linked=%d/%d (fk=%d) l1_nodes=%d "
        "speaker_info=%d higher=%d unmatched=%d",
        summary["conversation_id"],
        summary["linked_utterances"],
        summary["utterances"],
        summary["fk_linked"],
        summary["l1_nodes"],
        summary["nodes_with_speaker_info"],
        summary["higher_tier_nodes"],
        summary["unmatched_utterances"],
    )
    return summary


def _collect_descendant_utterances(
    node, node_by_id: Dict[uuid.UUID, Any], node_to_utts: Dict[uuid.UUID, List[uuid.UUID]]
) -> List[uuid.UUID]:
    """DFS over ``children_ids``; gather (deduplicated, order-preserving) the
    utterance ids contributed by every L1 descendant of ``node``."""
    seen_nodes: set = set()
    seen_utts: set = set()
    out: List[uuid.UUID] = []
    stack: List[uuid.UUID] = [node.id]
    while stack:
        nid = stack.pop()
        if nid in seen_nodes:
            continue
        seen_nodes.add(nid)
        for uid in node_to_utts.get(nid) or []:
            if uid not in seen_utts:
                seen_utts.add(uid)
                out.append(uid)
        cur = node_by_id.get(nid)
        if cur is not None:
            for cid in cur.children_ids or []:
                if cid not in seen_nodes:
                    stack.append(cid)
    return out

"""Mode-agnostic backend-owned graph persistence per ADR-030 §D3.

Consolidates the formerly-split ``import_persistence`` (file-upload imports)
and ``live_graph_persistence`` (live websocket sessions) modules into one
canonical home for writes against ``Conversation`` / ``Node`` /
``Relationship`` / ``Utterance`` rows.

Per ADR-030 §P1 + §P7, the backend is the only writer of canonical
semantic state. This module is the single canonical entry point —
both the live transport (``stt_ws_session``) and the import transport
(``import_bulk_pipeline``, ``import_orchestrator``) call into it.

Public surface:

    persist_graph(...)              # the canonical materializer
    persist_live_graph_snapshot(...) # convenience: live websocket flush
    persist_transcript(...)          # convenience: parsed transcript ingest

Backward-compatible aliases:
    persist_import_graph            # alias for persist_graph during D3 grace.
"""

import copy
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

# NOTE: ``db_session`` is imported lazily inside ``persist_live_graph_snapshot``
# to preserve the property of the legacy ``import_persistence`` module — that
# the persistence helpers can be imported in test environments where
# ``DATABASE_URL`` is not configured at import time.
from lct_python_backend.models import Conversation, Utterance as DBUtterance
from lct_python_backend.services.coercion_helpers import coerce_float, coerce_str
from lct_python_backend.services.owner_context import resolve_owner_id

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Contextual relation helpers (used by persist_graph)
# ---------------------------------------------------------------------------


def _extract_contextual_relation_pair(value: Any) -> Tuple[str, str]:
    if not isinstance(value, dict):
        return "", ""
    related_node = coerce_str(
        value.get("related_node_name")
        or value.get("related_node")
        or value.get("relatedNode")
        or value.get("source")
        or value.get("from")
        or value.get("node")
    )
    relation_text = coerce_str(
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


def _iter_contextual_relations(value: Any) -> Iterable[Tuple[str, str]]:
    seen: set = set()

    def _add(related_node: Any, relation_text: Any) -> Optional[Tuple[str, str]]:
        related = coerce_str(related_node)
        text = coerce_str(relation_text)
        if not related or not text or related in seen:
            return None
        seen.add(related)
        return related, text

    if isinstance(value, dict):
        if _looks_like_single_contextual_relation_object(value):
            relation = _add(*_extract_contextual_relation_pair(value))
            if relation:
                yield relation
            return

        for related_name, relation_text in value.items():
            relation = _add(related_name, relation_text)
            if relation:
                yield relation
        return

    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                node, text = _extract_contextual_relation_pair(item)
                if node or text:
                    relation = _add(node, text)
                    if relation:
                        yield relation
                    continue
                for related_name, relation_text in item.items():
                    relation = _add(related_name, relation_text)
                    if relation:
                        yield relation
        return


def calculate_speaker_turns(transcript) -> int:
    """Calculate speaker turns from transcript utterance sequence."""
    speaker_turns = 1
    prev_speaker = None
    for utt in transcript.utterances:
        if prev_speaker and utt.speaker != prev_speaker:
            speaker_turns += 1
        prev_speaker = utt.speaker
    return speaker_turns


def build_participant_summaries(transcript):
    """Build per-participant utterance counts for conversation metadata."""
    return [
        {"name": participant, "utterance_count": sum(1 for u in transcript.utterances if u.speaker == participant)}
        for participant in transcript.participants
    ]


def extract_conversation_name(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    """Best-effort conversation name from session metadata."""
    if not isinstance(metadata, dict):
        return None
    candidate = str(
        metadata.get("conversation_name")
        or metadata.get("file_name")
        or metadata.get("title")
        or ""
    ).strip()
    return candidate or None


import re
from collections import Counter

_SPEAKER_PREFIX_RE = re.compile(r"(?:^|\n|\.\s+)([A-Z]{1,12}(?:_\d+)?):\s")


def _dominant_speakers_from_excerpt(excerpt: str) -> Counter:
    """Count speaker prefixes ('A: ', 'SPEAKER_00: ', ...) in a chunk's source_excerpt."""
    if not excerpt:
        return Counter()
    matches = _SPEAKER_PREFIX_RE.findall(excerpt)
    return Counter(matches)


def _compute_speaker_rollup(
    node_records: List[Tuple[uuid.UUID, Dict[str, Any]]],
    ref_to_id: Dict[str, uuid.UUID],
) -> Dict[uuid.UUID, Dict[str, Any]]:
    """Compute per-node speaker_info by parsing diarized excerpt prefixes.

    Chunks (level=1) read directly from their source_excerpt.
    Higher tiers aggregate counts from their children_ids descendants.
    Returns {node_id: {"primary_speaker": "A", "speaker_distribution": {"A": 5, "B": 1}}}.
    """
    # First pass: capture leaf counts + build children map keyed by node_id
    leaf_counts: Dict[uuid.UUID, Counter] = {}
    children_map: Dict[uuid.UUID, List[uuid.UUID]] = {}
    level_by_id: Dict[uuid.UUID, int] = {}

    for node_id, item in node_records:
        try:
            level = int(item.get("semantic_level") or item.get("level") or 1)
        except (TypeError, ValueError):
            level = 1
        level_by_id[node_id] = max(1, min(5, level))

        excerpt = str(item.get("source_excerpt") or item.get("node_text") or item.get("summary") or "")
        own = _dominant_speakers_from_excerpt(excerpt)
        if own:
            leaf_counts[node_id] = own

        # Resolve children_ids slug list to UUIDs we know about
        kids_raw = item.get("children_ids") or []
        resolved: List[uuid.UUID] = []
        if isinstance(kids_raw, list):
            for k in kids_raw:
                ks = coerce_str(k)
                if ks and ks in ref_to_id:
                    resolved.append(ref_to_id[ks])
        if resolved:
            children_map[node_id] = resolved

    # Second pass: for non-leaf nodes, aggregate via DFS over children. Falls
    # back to the node's own excerpt-counts if children unresolved.
    rollup: Dict[uuid.UUID, Dict[str, Any]] = {}
    memo: Dict[uuid.UUID, Counter] = {}

    def aggregate(nid: uuid.UUID, visiting: set) -> Counter:
        if nid in memo:
            return memo[nid]
        if nid in visiting:
            return Counter()  # cycle guard
        visiting.add(nid)
        total = Counter()
        for child in children_map.get(nid, []):
            total.update(aggregate(child, visiting))
        if not total:
            total.update(leaf_counts.get(nid, Counter()))
        visiting.discard(nid)
        memo[nid] = total
        return total

    for nid, _ in node_records:
        counts = aggregate(nid, set())
        if not counts:
            continue
        primary, _ = counts.most_common(1)[0]
        rollup[nid] = {
            "primary_speaker": primary,
            "speaker_distribution": dict(counts),
        }
    return rollup


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def persist_transcript(
    *,
    db,
    transcript,
    conversation_id: str,
    conversation_name: str,
    source_type: str,
    owner_id: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Persist a parsed transcript (conversation + utterances) in one transaction."""
    conversation = Conversation(
        id=uuid.UUID(conversation_id),
        conversation_name=conversation_name,
        conversation_type="transcript",
        source_type=source_type,
        owner_id=owner_id,
        participant_count=len(transcript.participants),
        participants=build_participant_summaries(transcript),
        duration_seconds=transcript.duration,
        started_at=datetime.now(),
        created_at=datetime.now(),
        total_utterances=len(transcript.utterances),
        total_nodes=calculate_speaker_turns(transcript),
        metadata=metadata or {},
    )

    db.add(conversation)

    for utt in transcript.utterances:
        db_utterance = DBUtterance(
            id=uuid.uuid4(),
            conversation_id=uuid.UUID(conversation_id),
            text=utt.text,
            speaker_id=utt.speaker,
            sequence_number=utt.sequence_number,
            timestamp_start=utt.start_time,
            timestamp_end=utt.end_time,
            platform_metadata=utt.metadata or {},
        )
        db.add(db_utterance)

    await db.commit()


async def ensure_conversation_row(
    *,
    db,
    conversation_id: str,
    conversation_name: Optional[str] = None,
    source_type: Optional[str] = None,
    owner_id: Optional[str] = None,
    source_metadata: Optional[Dict[str, Any]] = None,
) -> bool:
    """Materialize a conversation row (idempotent) so child writes have a parent FK.

    Called early in import/STT pipelines before pipeline_artifacts checkpoint
    rows or any node/utterance writes fire — those have ON-FK to conversations.
    Returns True if a new row was inserted, False if one already existed.
    """
    from sqlalchemy import select

    conv_uuid = uuid.UUID(conversation_id)
    existing = await db.execute(select(Conversation).where(Conversation.id == conv_uuid))
    if existing.scalar_one_or_none() is not None:
        return False

    fallback_name = (conversation_name or "").strip() or f"import-{conv_uuid.hex[:8]}"
    conv = Conversation(
        id=conv_uuid,
        conversation_name=fallback_name,
        conversation_type="transcript",
        source_type=(source_type or "import").strip() or "import",
        source_metadata=source_metadata or {},
        owner_id=(owner_id or "").strip() or resolve_owner_id(),
        started_at=datetime.now(),
        created_at=datetime.now(),
    )
    db.add(conv)
    await db.commit()
    return True


async def persist_turns(*, db, payload) -> Dict[str, Any]:
    """Ingest a structured ``RawTurnsPayloadV1`` (P1, see
    docs/plans/2026-06-17-p1-rawturn-data-contract.md): upsert the conversation by
    ``(owner_id, indrasnet_group_id)`` and (re)materialize its ``Utterance`` rows
    **with ``source_identifier``** — the per-turn provenance anchor the markdown
    ``/from-text`` path drops.

    Replace semantics: a re-PUSH of the same group_id keeps the same
    ``conversation_id`` and rewrites the raw turns AND clears the derived graph
    (relationships cascade off the node delete) so the conversation is a clean
    slate for re-extraction. Deliberately does NOT reuse ``persist_graph``'s
    utterance insert, which omits ``source_identifier``.

    Privacy (doc §4): the LCT mirror is redacted-by-default; storing raw text
    (``redaction_applied=false``) additionally requires ``LCT_MIRROR_RAW=1`` on the
    server (owner-local only). ``redaction_applied`` is an UNVERIFIED upstream
    claim — LCT trusts it; the real guarantee is ADR-038.

    Returns ``{conversation_id, utterance_count, participant_count}``.
    """
    from sqlalchemy import delete, select

    owner_id = resolve_owner_id(payload.owner_id)
    privacy = payload.privacy

    if not privacy.redaction_applied:
        allow_raw = os.getenv("LCT_MIRROR_RAW", "").strip().lower() in {"1", "true", "yes", "on"}
        if not allow_raw:
            raise ValueError(
                "redaction_applied=false rejected: set LCT_MIRROR_RAW=1 to let the LCT "
                "mirror store un-redacted text (owner-local only)."
            )

    # Resolve the target conversation (replace-on-reingest). An explicit
    # conversation_id MUST belong to this (owner, group) and not be soft-deleted,
    # else a stale/bad payload could destructively overwrite an unrelated
    # conversation (codex #1). A non-existent id falls through to the (owner, group)
    # lookup.
    conv = None
    if payload.conversation_id:
        by_id = (
            await db.execute(
                select(Conversation).where(Conversation.id == uuid.UUID(payload.conversation_id))
            )
        ).scalar_one_or_none()
        if by_id is not None:
            if (
                by_id.owner_id != owner_id
                or by_id.indrasnet_group_id != payload.group_id
                or by_id.deleted_at is not None
            ):
                raise ValueError(
                    "conversation_id does not belong to this owner + group_id (or is "
                    "deleted); refusing to overwrite it."
                )
            conv = by_id
    if conv is None:
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.owner_id == owner_id,
                    Conversation.indrasnet_group_id == payload.group_id,
                    Conversation.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()

    privacy_meta = {
        "external_llm_ok": privacy.external_llm_ok,
        "local_llm_ok": privacy.local_llm_ok,
        "redaction_applied": privacy.redaction_applied,
        "redaction_map_id": privacy.redaction_map_id,
    }
    speakers = {t.speaker_id for t in payload.turns}
    conv_name = (payload.conversation_name or "").strip()

    if conv is None:
        conv = Conversation(
            id=uuid.uuid4(),
            conversation_name=conv_name or f"import-{payload.group_id}",
            conversation_type="transcript",
            source_type=payload.source_type,
            owner_id=owner_id,
            indrasnet_group_id=payload.group_id,
            source_metadata={"privacy": privacy_meta, "contract_version": payload.contract_version},
            participant_count=len(speakers),
            total_utterances=len(payload.turns),
            started_at=datetime.now(),
            created_at=datetime.now(),
        )
        db.add(conv)
        await db.flush()  # assign conv.id for the utterance FK
    else:
        from lct_python_backend.models import Node
        from lct_python_backend.models.analysis import (
            BiasAnalysis,
            FrameAnalysis,
            SimulacraAnalysis,
        )

        conv.conversation_name = conv_name or conv.conversation_name
        conv.source_type = payload.source_type
        conv.indrasnet_group_id = payload.group_id
        meta = dict(conv.source_metadata or {})
        meta["privacy"] = privacy_meta
        meta["contract_version"] = payload.contract_version
        conv.source_metadata = meta
        conv.participant_count = len(speakers)
        conv.total_utterances = len(payload.turns)
        conv.total_nodes = 0
        # Whole-conversation replace: drop prior turns + derived graph for a clean
        # re-extraction slate. simulacra/bias/frame FK nodes.id WITHOUT ON DELETE
        # CASCADE (codex #3), so clear them (scoped by conversation_id) BEFORE the
        # node delete; relationships + the cascade-FK analyses drop with the nodes.
        await db.execute(delete(SimulacraAnalysis).where(SimulacraAnalysis.conversation_id == conv.id))
        await db.execute(delete(BiasAnalysis).where(BiasAnalysis.conversation_id == conv.id))
        await db.execute(delete(FrameAnalysis).where(FrameAnalysis.conversation_id == conv.id))
        await db.execute(delete(DBUtterance).where(DBUtterance.conversation_id == conv.id))
        await db.execute(delete(Node).where(Node.conversation_id == conv.id))

    for turn in payload.turns:
        db.add(
            DBUtterance(
                id=uuid.uuid4(),
                conversation_id=conv.id,
                text=turn.text,
                speaker_id=turn.speaker_id,
                sequence_number=turn.seq,
                source_identifier=turn.source_identifier,
                timestamp_start=turn.ts_start,
                timestamp_end=turn.ts_end,
                platform_metadata={"contact_id": turn.contact_id} if turn.contact_id else {},
            )
        )

    await db.commit()
    return {
        "conversation_id": str(conv.id),
        "utterance_count": len(payload.turns),
        "participant_count": len(speakers),
    }


async def persist_graph(
    *,
    db,
    conversation_id: str,
    existing_json: list,
    utterances: Optional[List[Dict[str, Any]]] = None,
    conversation_name: Optional[str] = None,
    source_type: Optional[str] = None,
    owner_id: Optional[str] = None,
    source_metadata: Optional[Dict[str, Any]] = None,
    utterance_chunk_map: Optional[Dict[str, List[str]]] = None,
    indrasnet_group_id: Optional[str] = None,
    protect_node_ids: Optional[Iterable[uuid.UUID]] = None,
) -> int:
    """
    Persist LLM-generated graph nodes and relationships to DB. Mode-agnostic:
    works for live, import, and any other transport that materializes graph
    state through the canonical pipeline.

    ``protect_node_ids`` enables the segment-and-stitch resume path. Normally
    this function is destructive — it DELETEs every Node/Relationship row for
    the conversation, then re-INSERTs from ``existing_json``. When a recording
    resumes, a prior segment's graph already lives under this conversation_id;
    pass that prior segment's node ids here and the delete is scoped to
    *exclude* them: only this segment's nodes are deleted + rewritten, and the
    prior segment's Node + Relationship rows are frozen — never deleted, never
    reconstructed. (Relationships among this segment's nodes drop via the
    ondelete=CASCADE FK on relationships.from_node_id/to_node_id.) Invariant:
    ``protect_node_ids`` and ``existing_json``'s node ids must be disjoint —
    the resume path does NOT seed this segment's processor from the DB, so
    they always are.

    Returns the count of nodes written.
    """
    from lct_python_backend.models import Node, Relationship
    from sqlalchemy import select, delete
    from lct_python_backend.services.transcript.transcript_normalizer import propagate_flags_upward

    if not existing_json and utterances is None:
        return 0

    # Propagate is_tangent/is_crux/bookmark/contextual_progress up the tier
    # hierarchy before persistence: flags are authored at the chunk tier, but the
    # zoomed-out map renders topics/themes/arcs — without this they'd be flag-blind
    # (ADR consistency audit H2). Single chokepoint for both bulk-import and live paths.
    if existing_json:
        propagate_flags_upward(existing_json)

    conv_uuid = uuid.UUID(conversation_id)
    conv_result = await db.execute(select(Conversation).where(Conversation.id == conv_uuid))
    conv = conv_result.scalar_one_or_none()
    if conv is None:
        fallback_conversation_name = (conversation_name or "").strip() or f"import-{conv_uuid.hex[:8]}"
        conv = Conversation(
            id=conv_uuid,
            conversation_name=fallback_conversation_name,
            conversation_type="transcript",
            source_type=(source_type or "import").strip() or "import",
            source_metadata=source_metadata or {},
            owner_id=(owner_id or "").strip() or resolve_owner_id(),
            indrasnet_group_id=indrasnet_group_id,
            started_at=datetime.now(),
            created_at=datetime.now(),
        )
        db.add(conv)
        # Ensure parent row exists before inserting child node/relationship rows.
        await db.flush()
    elif indrasnet_group_id and not conv.indrasnet_group_id:
        # Existing conversation gaining its IndrasNet link (first structured
        # re-import). Don't clobber an already-set id.
        conv.indrasnet_group_id = indrasnet_group_id

    # Delete any stale rows before the re-INSERT below.
    #
    # bias/frame/simulacra_analysis FK ``nodes.id`` WITHOUT ondelete=CASCADE
    # (models/analysis.py), so a Node delete on a conversation that has been
    # analyzed raises a Postgres FK violation unless those analyses are cleared
    # FIRST — exactly the pre-delete persist_turns already does (~:448-450). The
    # other node-FK tables drop on their own: claims/argument_trees/is_ought
    # CASCADE, intent_signals SET NULL. (The fuller re-extract invalidation —
    # clusters, edits_log, pipeline_artifacts, gcs_path, denorm counts — is
    # ADR-059 §6 / PR-2; this fix only prevents the FK-violation crash.)
    from lct_python_backend.models.analysis import (
        BiasAnalysis,
        FrameAnalysis,
        SimulacraAnalysis,
    )
    _analysis_models = (SimulacraAnalysis, BiasAnalysis, FrameAnalysis)

    protected_ids = list(protect_node_ids or [])
    if protected_ids:
        # Resume path (segment-and-stitch): a prior segment's graph already
        # lives under this conversation_id. Freeze it — delete only THIS
        # segment's nodes (everything not protected). Relationships among the
        # deleted nodes drop via the ondelete=CASCADE FK on
        # relationships.from_node_id / to_node_id; the prior segment's
        # Relationship rows survive untouched because both their endpoints are
        # protected. The prior segment is never reconstructed, so the
        # relationship-lossy build_graph_data_from_nodes round-trip can't
        # reach it.
        #
        # Clear analyses tied to the nodes being deleted (the unprotected ones)
        # first; analyses on protected nodes are frozen with them.
        for _model in _analysis_models:
            await db.execute(
                delete(_model).where(
                    _model.conversation_id == conv_uuid,
                    _model.node_id.not_in(protected_ids),
                )
            )
        await db.execute(
            delete(Node).where(
                Node.conversation_id == conv_uuid,
                Node.id.not_in(protected_ids),
            )
        )
    else:
        # Fresh / import path: idempotent full re-materialization.
        for _model in _analysis_models:
            await db.execute(delete(_model).where(_model.conversation_id == conv_uuid))
        await db.execute(delete(Relationship).where(Relationship.conversation_id == conv_uuid))
        await db.execute(delete(Node).where(Node.conversation_id == conv_uuid))
    if utterances is not None:
        await db.execute(delete(DBUtterance).where(DBUtterance.conversation_id == conv_uuid))

    def _coerce_uuid(value: Any) -> Optional[uuid.UUID]:
        try:
            token = coerce_str(value)
            return uuid.UUID(token) if token else None
        except (TypeError, ValueError, AttributeError):
            return None

    def _coerce_uuid_array(values: Any) -> list[uuid.UUID]:
        normalized: list[uuid.UUID] = []
        if not isinstance(values, list):
            return normalized
        for value in values:
            parsed = _coerce_uuid(value)
            if parsed is not None:
                normalized.append(parsed)
        return normalized

    def _normalize_utterances(raw_rows: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        normalized_rows: List[Dict[str, Any]] = []
        for index, row in enumerate(raw_rows or [], start=1):
            if not isinstance(row, dict):
                continue
            text = coerce_str(row.get("text"))
            if not text:
                continue
            timestamp_start = coerce_float(row.get("timestamp_start"))
            timestamp_end = coerce_float(row.get("timestamp_end"))
            duration_seconds = coerce_float(row.get("duration_seconds"))
            if duration_seconds is None and None not in {timestamp_start, timestamp_end} and timestamp_end >= timestamp_start:
                duration_seconds = round(timestamp_end - timestamp_start, 4)
            normalized_rows.append(
                {
                    "id": _coerce_uuid(row.get("id")) or uuid.uuid4(),
                    "text": text,
                    "speaker_id": coerce_str(row.get("speaker_id")) or "SPEAKER_00",
                    "speaker_name": coerce_str(row.get("speaker_name")) or None,
                    "speaker_source": coerce_str(row.get("speaker_source")) or "session_default",
                    "speaker_confidence": coerce_float(row.get("speaker_confidence")),
                    "speaker_revision": int(row.get("speaker_revision") or 0),
                    "sequence_number": int(row.get("sequence_number") or index),
                    "timestamp_start": timestamp_start,
                    "timestamp_end": timestamp_end,
                    "duration_seconds": duration_seconds,
                    "chunk_id": _coerce_uuid(row.get("chunk_id")),
                    "node_id": _coerce_uuid(row.get("node_id")),
                    "thread_id": _coerce_uuid(row.get("thread_id")),
                    "platform_metadata": row.get("platform_metadata") if isinstance(row.get("platform_metadata"), dict) else {},
                    # P1 provenance anchor: the immutable per-turn IndrasNet id.
                    # NULL for legacy/live/markdown rows that carry no source.
                    "source_identifier": coerce_str(row.get("source_identifier")) or None,
                }
            )
        normalized_rows.sort(key=lambda item: (item["sequence_number"], str(item["id"])))
        return normalized_rows

    # Step 1: Assign stable UUIDs; build reference→id map for relationship resolution
    ref_to_id: Dict[str, uuid.UUID] = {}
    node_records = []
    for item in existing_json:
        node_id = _coerce_uuid(item.get("id") or item.get("node_id")) or uuid.uuid4()
        name = coerce_str(item.get("node_name") or "")
        raw_id = coerce_str(item.get("id") or item.get("node_id"))
        if name:
            ref_to_id[name] = node_id
        if raw_id:
            ref_to_id[raw_id] = node_id
        node_records.append((node_id, item))

    # ADR-030 §D4: roll up speaker_info from diarized source_excerpt prefixes
    # so the frontend Color:Speaker mode actually colors something. Without
    # this, every node gets speaker_info=null even though the STT was diarized.
    speaker_info_by_id = _compute_speaker_rollup(node_records, ref_to_id)

    # Option B: normalize utterance_chunk_map BEFORE the timestamp lookup
    # below so my new write-time-timestamps logic can reference it.
    parsed_utterance_chunk_map: Dict[uuid.UUID, List[uuid.UUID]] = {}
    if utterance_chunk_map:
        for raw_chunk, raw_utt_ids in utterance_chunk_map.items():
            chunk_uuid = _coerce_uuid(raw_chunk)
            if chunk_uuid is None:
                continue
            seen_local: set = set()
            normalized_utts: List[uuid.UUID] = []
            for raw_utt in (raw_utt_ids or []):
                parsed_utt = _coerce_uuid(raw_utt)
                if parsed_utt is None or parsed_utt in seen_local:
                    continue
                seen_local.add(parsed_utt)
                normalized_utts.append(parsed_utt)
            if normalized_utts:
                parsed_utterance_chunk_map[chunk_uuid] = normalized_utts

    # P1.5: the IMPORT path passes no utterance_chunk_map (only the live
    # processor does), so derive one from the utterances' own chunk_id. The
    # import flow stitches chunk_id onto each utterance (import_bulk_pipeline)
    # and every utterance now carries a stable id (transcript_linearization), so
    # this maps each leaf node's chunk to its exact utterances — making import +
    # RawTurn graphs auditable (and build_coverage_summary non-null). A
    # caller-supplied map wins per chunk; this only fills chunks it didn't map.
    if utterances:
        derived_chunk_map: Dict[uuid.UUID, List[uuid.UUID]] = {}
        derived_seen: Dict[uuid.UUID, set] = {}
        for raw_utt in utterances:
            if not isinstance(raw_utt, dict):
                continue
            # Only map utterances that WILL persist. _normalize_utterances drops
            # empty-text rows (`if not text: continue`); mirror that here so a
            # node never inherits the id of an utterance that was never written —
            # which would let build_coverage_summary over-report (counting an id
            # absent from the persisted set, pct possibly > 100). codex PR#63.
            if not coerce_str(raw_utt.get("text")):
                continue
            derived_chunk_uuid = _coerce_uuid(raw_utt.get("chunk_id"))
            derived_utt_uuid = _coerce_uuid(raw_utt.get("id"))
            if derived_chunk_uuid is None or derived_utt_uuid is None:
                continue
            seen = derived_seen.setdefault(derived_chunk_uuid, set())
            if derived_utt_uuid in seen:  # O(1) dedupe; mirrors the explicit map's seen_local
                continue
            seen.add(derived_utt_uuid)
            derived_chunk_map.setdefault(derived_chunk_uuid, []).append(derived_utt_uuid)
        # A caller-supplied NON-EMPTY mapping for a chunk wins (setdefault); the
        # derived map only fills chunks the caller did not usefully map.
        for derived_chunk_uuid, derived_utt_ids in derived_chunk_map.items():
            parsed_utterance_chunk_map.setdefault(derived_chunk_uuid, derived_utt_ids)

    # ADR-032 Part G: persist timestamp_start/timestamp_end on Node rows
    # at write time. Read-time derivation (conversation_reader.py) becomes a
    # drift-check that asserts these match. Computing at write time means
    # the swim-lane layout can position nodes directly from Node.timestamp_start
    # without re-deriving on every read.
    #
    # Algorithm: for each node, collect its utterance_ids (authored OR mapped
    # via utterance_chunk_map) plus its chunk_ids. Query utterances matching
    # either set. min(timestamp_start) and max(timestamp_end) define the
    # node's temporal span. Honor any LLM-authored timestamp_start verbatim.
    referenced_utt_ids: set = set()
    referenced_chunk_ids: set = set()
    for _, item in node_records:
        for uid in (item.get("utterance_ids") or []):
            parsed = _coerce_uuid(uid)
            if parsed:
                referenced_utt_ids.add(parsed)
        cid = item.get("chunk_id")
        if cid:
            parsed_cid = _coerce_uuid(cid)
            if parsed_cid:
                referenced_chunk_ids.add(parsed_cid)
    # Also pull utterance ids from utterance_chunk_map for nodes whose
    # chunk_id is in the map.
    for chunk_uuid, utt_uuids in parsed_utterance_chunk_map.items():
        if chunk_uuid in referenced_chunk_ids:
            referenced_utt_ids.update(utt_uuids)

    utterance_timestamps: Dict[uuid.UUID, Tuple[Optional[float], Optional[float]]] = {}
    utterance_to_chunk: Dict[uuid.UUID, Optional[uuid.UUID]] = {}
    if referenced_utt_ids or referenced_chunk_ids:
        from sqlalchemy import or_
        utt_query = select(
            DBUtterance.id,
            DBUtterance.timestamp_start,
            DBUtterance.timestamp_end,
            DBUtterance.chunk_id,
        ).where(DBUtterance.conversation_id == conv_uuid)
        clauses = []
        if referenced_utt_ids:
            clauses.append(DBUtterance.id.in_(referenced_utt_ids))
        if referenced_chunk_ids:
            clauses.append(DBUtterance.chunk_id.in_(referenced_chunk_ids))
        if clauses:
            utt_query = utt_query.where(or_(*clauses))
        r = await db.execute(utt_query)
        for uid, ts_start, ts_end, chunk_id_row in r:
            utterance_timestamps[uid] = (
                float(ts_start) if ts_start is not None else None,
                float(ts_end) if ts_end is not None else None,
            )
            if chunk_id_row is not None:
                utterance_to_chunk[uid] = chunk_id_row

    # Import path: utterances passed via the ``utterances`` kwarg haven't
    # been INSERTed yet when the DB query above runs, so they don't show
    # up. Merge them in from the in-memory list so node timestamp
    # derivation works for fresh imports too. (Live STT path doesn't pass
    # utterances; the DB query above is its source.)
    if utterances:
        for raw in utterances:
            if not isinstance(raw, dict):
                continue
            utt_id = _coerce_uuid(raw.get("id"))
            if utt_id is None:
                continue
            ts_start = raw.get("timestamp_start")
            ts_end = raw.get("timestamp_end")
            try:
                ts_start_f = float(ts_start) if ts_start is not None else None
            except (TypeError, ValueError):
                ts_start_f = None
            try:
                ts_end_f = float(ts_end) if ts_end is not None else None
            except (TypeError, ValueError):
                ts_end_f = None
            utterance_timestamps[utt_id] = (ts_start_f, ts_end_f)
            chunk_id_raw = _coerce_uuid(raw.get("chunk_id"))
            if chunk_id_raw is not None:
                utterance_to_chunk[utt_id] = chunk_id_raw

    # Group utterances by chunk_id so chunk_id->derive falls out naturally.
    chunk_to_utt_ids: Dict[uuid.UUID, List[uuid.UUID]] = {}
    for uid, cid in utterance_to_chunk.items():
        if cid is None:
            continue
        chunk_to_utt_ids.setdefault(cid, []).append(uid)



    if conv and conversation_name:
        clean_conversation_name = coerce_str(conversation_name)
        if clean_conversation_name:
            conv.conversation_name = clean_conversation_name
    if conv and source_metadata:
        conv.source_metadata = source_metadata

    # ADR-032 Part G: bubble timestamps UP through the hierarchy so higher
    # tiers (topics/themes/arcs) get a temporal span derived from their
    # descendants' chunks. Higher-tier nodes don't have utterance_ids or
    # chunk_id themselves — they have children_ids pointing at lower-tier
    # nodes. Walk the children_ids tree (slug names or UUIDs both resolve
    # via ref_to_id) and aggregate min/max of leaf timestamps.
    #
    # Without this pass, only L1 chunks and L2 ideas that have utterance_ids
    # get timestamps; the swim-lane layout falls back to column-index for
    # arcs/themes/topics which kills the time-axis at the macro view.
    item_by_node_id: Dict[uuid.UUID, Dict[str, Any]] = {nid: itm for nid, itm in node_records}

    # First pass: compute the L1 chunk's own ts from its utterance_ids /
    # chunk_id (we already have utterance_timestamps + chunk_to_utt_ids).
    node_ts_cache: Dict[uuid.UUID, Tuple[Optional[float], Optional[float]]] = {}

    def _compute_leaf_ts(node_id: uuid.UUID, item: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
        candidate_utt_ids: List[uuid.UUID] = []
        for uid in (item.get("utterance_ids") or []):
            parsed = _coerce_uuid(uid)
            if parsed and parsed in utterance_timestamps:
                candidate_utt_ids.append(parsed)
        if not candidate_utt_ids:
            cid_raw = item.get("chunk_id")
            if cid_raw:
                cuid = _coerce_uuid(cid_raw)
                if cuid:
                    candidate_utt_ids = chunk_to_utt_ids.get(cuid, [])
        if not candidate_utt_ids:
            return (None, None)
        starts = [utterance_timestamps[u][0] for u in candidate_utt_ids if utterance_timestamps.get(u) and utterance_timestamps[u][0] is not None]
        ends = [utterance_timestamps[u][1] for u in candidate_utt_ids if utterance_timestamps.get(u) and utterance_timestamps[u][1] is not None]
        return (min(starts) if starts else None, max(ends) if ends else None)

    # Second pass: recursively resolve via children_ids for non-leaf tiers.
    visited_resolve: set = set()

    def _resolve_ts(node_id: uuid.UUID) -> Tuple[Optional[float], Optional[float]]:
        if node_id in node_ts_cache:
            return node_ts_cache[node_id]
        if node_id in visited_resolve:  # cycle guard
            return (None, None)
        visited_resolve.add(node_id)
        item = item_by_node_id.get(node_id)
        if item is None:
            node_ts_cache[node_id] = (None, None)
            visited_resolve.discard(node_id)
            return (None, None)
        # First try the leaf computation.
        ts = _compute_leaf_ts(node_id, item)
        if ts[0] is not None:
            node_ts_cache[node_id] = ts
            visited_resolve.discard(node_id)
            return ts
        # Then bubble up from children_ids.
        starts: List[float] = []
        ends: List[float] = []
        raw_children = item.get("children_ids") or []
        for child_ref in raw_children:
            ref_str = coerce_str(child_ref)
            child_uuid = ref_to_id.get(ref_str) if ref_str in ref_to_id else _coerce_uuid(ref_str)
            if child_uuid is None or child_uuid == node_id:
                continue
            cs, ce = _resolve_ts(child_uuid)
            if cs is not None:
                starts.append(cs)
            if ce is not None:
                ends.append(ce)
        result = (min(starts) if starts else None, max(ends) if ends else None)
        node_ts_cache[node_id] = result
        visited_resolve.discard(node_id)
        return result

    # Resolve for every node up front so the writes below just look them up.
    for nid, itm in node_records:
        _resolve_ts(nid)

    # Step 2: Write Node rows
    for node_id, item in node_records:
        chunk_id = item.get("chunk_id")
        # Option B: if the LLM didn't author utterance_ids for this node but
        # the chunk_utterance_map names some, inherit them. The live path
        # populates utterance_ids on each emitted node via the processor, so
        # this fallback mostly covers test/legacy paths that pass utterance
        # links out-of-band rather than embedded.
        if not item.get("utterance_ids") and chunk_id and parsed_utterance_chunk_map:
            chunk_uuid_for_node = _coerce_uuid(chunk_id)
            if chunk_uuid_for_node and chunk_uuid_for_node in parsed_utterance_chunk_map:
                item["utterance_ids"] = [
                    str(uid) for uid in parsed_utterance_chunk_map[chunk_uuid_for_node]
                ]
        node_type = (
            "bookmark" if item.get("is_bookmark")
            else "contextual_progress" if item.get("is_contextual_progress")
            else "conversational_thread"
        )
        thread_id = _coerce_uuid(item.get("thread_id"))
        thread_state = coerce_str(item.get("thread_state")) or None
        edge_relations = item.get("edge_relations") if isinstance(item.get("edge_relations"), list) else []
        linked_nodes = item.get("linked_nodes") if isinstance(item.get("linked_nodes"), list) else []
        # ADR-021 / ADR-030 §P5: honour the LLM-authored hierarchy level
        # if present. Falls back to 1 (chunk) for back-compat with legacy
        # JSON snapshots that don't carry semantic_level. Clamp to [1, 5]
        # — ADR-030 §D2 caps the canonical hierarchy at five tiers (arc).
        authored_level = (
            item.get("semantic_level")
            if isinstance(item.get("semantic_level"), int)
            else item.get("level")
        )
        try:
            node_level = int(authored_level) if authored_level is not None else 1
        except (TypeError, ValueError):
            node_level = 1
        node_level = max(1, min(5, node_level))

        # Resolve hierarchy links. The Node model has parent_id (single FK) and
        # children_ids (array). Authors supply either slug-style ids ("topic-001")
        # that we already mapped into ref_to_id, or raw UUIDs. Skip ids that
        # don't resolve to a node we're about to persist — referential integrity
        # matters for parent_id since it's a foreign key.
        def _resolve_node_ref(value: Any) -> Optional[uuid.UUID]:
            key = coerce_str(value)
            if not key:
                return None
            if key in ref_to_id:
                return ref_to_id[key]
            return _coerce_uuid(key)

        parent_id_resolved = _resolve_node_ref(item.get("parent_id"))
        raw_children = item.get("children_ids")
        children_resolved: List[uuid.UUID] = []
        if isinstance(raw_children, list):
            for child_ref in raw_children:
                resolved = _resolve_node_ref(child_ref)
                if resolved is not None and resolved != node_id:
                    children_resolved.append(resolved)

        # ADR-032 Part G: timestamps were resolved in the pre-pass above.
        # node_ts_cache contains the min/max for every node, derived from
        # utterance_ids for L1 chunks and from children_ids recursively
        # for higher tiers. LLM-authored item.timestamp_start wins when
        # present (rare — most authors don't supply it).
        authored_ts_start = item.get("timestamp_start")
        authored_ts_end = item.get("timestamp_end")
        cached_ts = node_ts_cache.get(node_id, (None, None))
        node_ts_start: Optional[float] = (
            float(authored_ts_start) if authored_ts_start is not None else cached_ts[0]
        )
        node_ts_end: Optional[float] = (
            float(authored_ts_end) if authored_ts_end is not None else cached_ts[1]
        )

        node_duration: Optional[float] = None
        if node_ts_start is not None and node_ts_end is not None and node_ts_end >= node_ts_start:
            node_duration = round(node_ts_end - node_ts_start, 4)

        # ADR-032 Part G: persist verbatim LLM-authored source_excerpt so
        # post-hoc passes don't need to re-call the LLM to recover it.
        source_excerpt_value = item.get("source_excerpt")
        if source_excerpt_value is not None:
            source_excerpt_value = str(source_excerpt_value)

        db.add(Node(
            id=node_id,
            conversation_id=conv_uuid,
            node_name=item.get("node_name", ""),
            summary=item.get("summary", ""),
            source_excerpt=source_excerpt_value,
            chunk_ids=_coerce_uuid_array([chunk_id] if chunk_id else []),
            node_type=node_type,
            is_bookmark=bool(item.get("is_bookmark")),
            is_contextual_progress=bool(item.get("is_contextual_progress")),
            is_tangent=bool(item.get("is_tangent")) or thread_state in {"branch", "tangent"},
            is_crux=bool(item.get("is_crux")),
            is_action_item=bool(item.get("is_action_item")),
            is_surprise=bool(item.get("is_surprise")),
            level=node_level,
            zoom_level_visible=[node_level],
            parent_id=parent_id_resolved,
            children_ids=children_resolved or None,
            # #12: promote thread fields to real columns (same slug value as the
            # cluster_info mirror below) so the API/layout can read them top-level.
            thread_id=str(thread_id) if thread_id else coerce_str(item.get("thread_id")) or None,
            thread_state=thread_state or None,
            cluster_info={
                "thread_id": str(thread_id) if thread_id else coerce_str(item.get("thread_id")) or None,
                "thread_label": coerce_str(item.get("thread_label")) or None,
                "thread_state": thread_state,
                "linked_nodes": linked_nodes,
            },
            display_preferences={
                "edge_relations": edge_relations,
                "argument_role": coerce_str(
                    item.get("argument_role") or item.get("claim_type")
                ) or "context",
            },
            utterance_ids=_coerce_uuid_array(item.get("utterance_ids")),
            # P0 provenance: persist the source_ref the graph carries (the
            # re-persist round-trip emits it from build_graph_data_from_nodes).
            # New extraction graphs leave it null here; the export read-model
            # derives it deterministically from utterance_ids.
            source_ref=item.get("source_ref"),
            speaker_info=speaker_info_by_id.get(node_id),
            timestamp_start=node_ts_start,
            timestamp_end=node_ts_end,
            duration_seconds=node_duration,
        ))

    # Step 3: Write Relationship rows.
    #
    # Faithful path — when the graph carries `edges_out` (each node's outgoing
    # Relationship rows verbatim, emitted by conversation_reader.
    # build_graph_data_from_nodes(..., include_edges_out=True)): persist every
    # relationship with its ORIGINAL id and all fields, so a DB-graph ->
    # reconstruct -> re-persist round-trip is lossless. The legacy path (3a/3b)
    # folds edges into singular predecessor/successor fields + a name-keyed
    # dict and re-mints ids — correct for LLM-authored graphs (no `edges_out`),
    # lossy for a reconstruction. A graph carries one representation, not both.
    node_record_ids = {nid for nid, _ in node_records}
    graph_has_faithful_edges = any("edges_out" in item for _, item in node_records)

    if graph_has_faithful_edges:
        seen_rel_ids: set = set()
        for node_id, item in node_records:
            edges_out = item.get("edges_out")
            if not isinstance(edges_out, list):
                continue
            for edge in edges_out:
                if not isinstance(edge, dict):
                    continue
                to_ref = coerce_str(edge.get("to"))
                to_node_id = ref_to_id.get(to_ref) or _coerce_uuid(to_ref)
                # to-node must be one of the rows we're inserting (FK), and
                # the no_self_reference CHECK forbids from == to.
                if to_node_id is None or to_node_id == node_id:
                    continue
                if to_node_id not in node_record_ids:
                    continue
                rel_id = _coerce_uuid(edge.get("id")) or uuid.uuid4()
                if rel_id in seen_rel_ids:
                    continue
                seen_rel_ids.add(rel_id)
                db.add(Relationship(
                    id=rel_id,
                    conversation_id=conv_uuid,
                    from_node_id=node_id,
                    to_node_id=to_node_id,
                    relationship_type=coerce_str(edge.get("relationship_type")) or "related",
                    relationship_subtype=coerce_str(edge.get("relationship_subtype")) or None,
                    explanation=edge.get("explanation"),
                    strength=coerce_float(edge.get("strength")),
                    confidence=coerce_float(edge.get("confidence")),
                    is_bidirectional=bool(edge.get("is_bidirectional")),
                    supporting_utterance_ids=_coerce_uuid_array(edge.get("supporting_utterance_ids")),
                ))
    else:
        # 3a. Temporal chain via successor/predecessor fields
        temporal_pairs = set()
        for node_id, item in node_records:
            successor_name = coerce_str(item.get("successor"))
            if successor_name and successor_name in ref_to_id:
                temporal_pairs.add((node_id, ref_to_id[successor_name]))
            predecessor_name = coerce_str(item.get("predecessor"))
            if predecessor_name and predecessor_name in ref_to_id:
                temporal_pairs.add((ref_to_id[predecessor_name], node_id))

        for from_node_id, to_node_id in temporal_pairs:
            if from_node_id == to_node_id:
                continue
            db.add(Relationship(
                id=uuid.uuid4(),
                conversation_id=conv_uuid,
                from_node_id=from_node_id,
                to_node_id=to_node_id,
                relationship_type="temporal",
                explanation="Sequential conversation flow",
                strength=1.0,
                confidence=1.0,
            ))

        # 3b. Contextual relations
        contextual_seen = set()
        for node_id, item in node_records:
            for related_name, relation_text in _iter_contextual_relations(item.get("contextual_relation")):
                if related_name in ref_to_id:
                    related_id = ref_to_id[related_name]
                    # CHECK constraint no_self_reference blocks from==to. The
                    # LLM occasionally fuzzy-matches a node to itself via name
                    # overlap; skip silently.
                    if related_id == node_id:
                        continue
                    relation_key = (node_id, related_id, "contextual", relation_text)
                    if relation_key in contextual_seen:
                        continue
                    contextual_seen.add(relation_key)
                    db.add(Relationship(
                        id=uuid.uuid4(),
                        conversation_id=conv_uuid,
                        from_node_id=node_id,
                        to_node_id=related_id,
                        relationship_type="contextual",
                        explanation=relation_text,
                        strength=0.8,
                        confidence=0.9,
                    ))

            raw_edge_relations = item.get("edge_relations")
            if not isinstance(raw_edge_relations, list):
                continue
            for relation in raw_edge_relations:
                if not isinstance(relation, dict):
                    continue
                related_name = coerce_str(
                    relation.get("related_node")
                    or relation.get("related_node_name")
                    or relation.get("relatedNode")
                    or relation.get("source")
                    or relation.get("from")
                    or relation.get("node")
                )
                if related_name not in ref_to_id:
                    continue
                relation_type = coerce_str(relation.get("relation_type") or relation.get("type")).lower() or "contextual"
                relation_text = coerce_str(
                    relation.get("relation_text")
                    or relation.get("relationText")
                    or relation.get("description")
                    or relation.get("explanation")
                ) or relation_type
                relation_key = (ref_to_id[related_name], node_id, relation_type, relation_text)
                if relation_key in contextual_seen or ref_to_id[related_name] == node_id:
                    continue
                contextual_seen.add(relation_key)
                db.add(Relationship(
                    id=uuid.uuid4(),
                    conversation_id=conv_uuid,
                    from_node_id=ref_to_id[related_name],
                    to_node_id=node_id,
                    relationship_type=relation_type,
                    relationship_subtype=relation_type if relation_type != "contextual" else None,
                    explanation=relation_text,
                    strength=0.8,
                    confidence=0.9,
                ))

    persisted_utterances = _normalize_utterances(utterances)
    if utterances is not None:
        for row in persisted_utterances:
            db.add(
                DBUtterance(
                    id=row["id"],
                    conversation_id=conv_uuid,
                    text=row["text"],
                    speaker_id=row["speaker_id"],
                    speaker_name=row["speaker_name"],
                    speaker_source=row["speaker_source"],
                    speaker_confidence=row["speaker_confidence"],
                    speaker_revision=row["speaker_revision"],
                    sequence_number=row["sequence_number"],
                    timestamp_start=row["timestamp_start"],
                    timestamp_end=row["timestamp_end"],
                    duration_seconds=row["duration_seconds"],
                    chunk_id=row["chunk_id"],
                    node_id=row["node_id"],
                    thread_id=row["thread_id"],
                    platform_metadata=row["platform_metadata"],
                    source_identifier=row["source_identifier"],
                )
            )

    # Option B: backfill utterances.chunk_id from the live-path mapping.
    # This is what makes the audio-seek-per-node feature work for live
    # conversations: per-node timestamp lookup walks utterances -> chunk_id.
    # We do this AFTER node writes (so any chunk_id we set is referentially
    # consistent with the freshly persisted Node rows) but BEFORE the
    # conversation aggregate counts since those don't depend on it.
    if parsed_utterance_chunk_map:
        from sqlalchemy import update as sa_update
        for chunk_uuid, utt_uuids in parsed_utterance_chunk_map.items():
            if not utt_uuids:
                continue
            await db.execute(
                sa_update(DBUtterance)
                .where(
                    DBUtterance.conversation_id == conv_uuid,
                    DBUtterance.id.in_(utt_uuids),
                )
                .values(chunk_id=chunk_uuid)
            )

    # Step 4: Update conversation aggregate counts
    # On the resume path node_records holds only THIS segment's nodes; the
    # protected prior-segment nodes are still in the DB and must be counted.
    # protected_ids is [] on the fresh/import path, so this is a no-op there.
    conv.total_nodes = len(protected_ids) + len(node_records)
    if utterances is not None:
        speaker_counts: Dict[str, int] = {}
        timestamp_values = []
        total_words = 0
        for row in persisted_utterances:
            speaker_key = row["speaker_id"]
            speaker_counts[speaker_key] = speaker_counts.get(speaker_key, 0) + 1
            total_words += len(row["text"].split())
            if row["timestamp_start"] is not None:
                timestamp_values.append(float(row["timestamp_start"]))
            if row["timestamp_end"] is not None:
                timestamp_values.append(float(row["timestamp_end"]))
        conv.total_utterances = len(persisted_utterances)
        conv.total_words = total_words
        conv.participant_count = len(speaker_counts)
        conv.participants = [
            {"name": speaker_id, "utterance_count": utterance_count}
            for speaker_id, utterance_count in sorted(speaker_counts.items())
        ]
        if timestamp_values:
            conv.duration_seconds = int(max(timestamp_values) - min(timestamp_values))

    await db.commit()
    return len(node_records)


async def record_pipeline_artifact(
    *,
    conversation_id: str,
    stage: str,
    artifact_type: str,
    artifact_json: Optional[Dict[str, Any]] = None,
    artifact_path: Optional[str] = None,
    artifact_metadata: Optional[Dict[str, Any]] = None,
    stage_index: int = 0,
    content_hash: Optional[str] = None,
) -> Optional[str]:
    """Write a row to ``pipeline_artifacts`` for a stage's output.

    Per ADR-030 §D8 + §D9, every stage should leave an addressable
    artifact behind so post-hoc analysis can reconstruct what each
    stage produced (success and failure alike). This helper is the
    canonical write path. ``stage`` is the stage's ``name`` attribute
    (e.g. ``"unlock_hierarchy"``); ``artifact_type`` is one of
    ``"audio" | "transcript" | "chunks" | "segment" | "nodes" |
    "stage_failure"`` (free-form string — schema accepts any value).

    Returns the new row's ID as a string, or None if persistence was
    skipped (e.g. no DATABASE_URL in test environment, or invalid
    conversation UUID — both common in unit tests).

    The DB session is opened lazily so this helper is safe to call
    from contexts that don't already have a session in scope.
    """
    # Lazy-import to preserve the legacy import_persistence property
    # that this module's chat-side helpers can be imported without
    # DATABASE_URL configured at module load.
    from lct_python_backend.db_session import get_async_session_context
    from lct_python_backend.models import PipelineArtifact

    try:
        conv_uuid = uuid.UUID(conversation_id)
    except (TypeError, ValueError):
        logger.warning(
            "[ARTIFACT] skipping write — invalid conversation_id=%r", conversation_id
        )
        return None

    artifact_id = uuid.uuid4()
    try:
        async with get_async_session_context() as db:
            db.add(
                PipelineArtifact(
                    id=artifact_id,
                    conversation_id=conv_uuid,
                    stage=stage,
                    stage_index=stage_index,
                    content_hash=content_hash,
                    artifact_type=artifact_type,
                    artifact_path=artifact_path,
                    artifact_json=artifact_json or {},
                    artifact_metadata=artifact_metadata or {},
                )
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        # Artifact-write failure must NOT break the calling stage.
        # ADR-030 §P2: failures in the interpretation layer never block
        # fact-layer writes. Observability writes are even further from
        # critical path; log and continue.
        logger.warning(
            "[ARTIFACT] write failed conversation=%s stage=%s: %s",
            conversation_id, stage, exc,
        )
        return None

    return str(artifact_id)


async def persist_live_graph_snapshot(
    *,
    conversation_id: str,
    existing_json: List[Dict[str, Any]],
    metadata: Optional[Dict[str, Any]] = None,
    source_type: str = "live_audio",
    utterance_chunk_map: Optional[Dict[str, List[str]]] = None,
    protect_node_ids: Optional[Iterable[uuid.UUID]] = None,
) -> int:
    """Persist the current best semantic graph for a live websocket session.

    Convenience wrapper over ``persist_graph`` that:
      - opens its own async DB session (live runtime is outside FastAPI's DI)
      - extracts conversation_name from session metadata
      - logs a [GRAPH PERSIST] line with latency for observability

    This path is intentionally backend-owned per ADR-019 / ADR-030 §P7 so
    headless replays and live websocket sessions produce durable graph state
    even when no browser autosave fires.

    ``utterance_chunk_map`` (Option B) carries the chunk_id -> [utterance_id]
    links accumulated by ``TranscriptProcessor`` during live streaming so the
    underlying ``persist_graph`` call can backfill ``utterances.chunk_id``
    on existing rows. Bulk-import path doesn't supply this — utterances
    written by that path already carry chunk_id directly.

    ``protect_node_ids`` (segment-and-stitch resume) is forwarded to
    ``persist_graph`` — when set, the prior recording segment's nodes are
    frozen instead of wiped. See ``persist_graph``'s docstring.
    """
    # Lazy import — see top-of-module note for why this is not at module level.
    from lct_python_backend.db_session import get_async_session_context

    normalized_nodes = [
        copy.deepcopy(node)
        for node in (existing_json or [])
        if isinstance(node, dict)
    ]
    if not conversation_id or not normalized_nodes:
        return 0

    started_at = time.perf_counter()
    async with get_async_session_context() as db:
        persisted = await persist_graph(
            db=db,
            conversation_id=conversation_id,
            existing_json=normalized_nodes,
            conversation_name=extract_conversation_name(metadata),
            source_type=source_type,
            source_metadata=metadata or {},
            utterance_chunk_map=utterance_chunk_map,
            protect_node_ids=protect_node_ids,
        )
    logger.info(
        "[GRAPH PERSIST] conversation=%s nodes=%s source_type=%s latency_ms=%.2f",
        conversation_id,
        persisted,
        source_type,
        max(0.0, (time.perf_counter() - started_at) * 1000.0),
    )
    return persisted


# ---------------------------------------------------------------------------
# Backward-compatible alias
# ---------------------------------------------------------------------------

#: Alias retained during the D3 grace period so existing imports of
#: ``import_persistence.persist_import_graph`` keep working. New callers
#: should use ``persist_graph`` directly. See ADR-030 §D3.
persist_import_graph = persist_graph

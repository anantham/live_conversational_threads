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
    owner_id: str = "default_user",
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
        owner_id=(owner_id or "default_user").strip() or "default_user",
        started_at=datetime.now(),
        created_at=datetime.now(),
    )
    db.add(conv)
    await db.commit()
    return True


async def persist_graph(
    *,
    db,
    conversation_id: str,
    existing_json: list,
    utterances: Optional[List[Dict[str, Any]]] = None,
    conversation_name: Optional[str] = None,
    source_type: Optional[str] = None,
    owner_id: str = "default_user",
    source_metadata: Optional[Dict[str, Any]] = None,
    utterance_chunk_map: Optional[Dict[str, List[str]]] = None,
) -> int:
    """
    Persist LLM-generated graph nodes and relationships to DB. Mode-agnostic:
    works for live, import, and any other transport that materializes graph
    state through the canonical pipeline.

    Returns the count of nodes written.
    """
    from lct_python_backend.models import Node, Relationship
    from sqlalchemy import select, delete

    if not existing_json and utterances is None:
        return 0

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
            owner_id=(owner_id or "default_user").strip() or "default_user",
            started_at=datetime.now(),
            created_at=datetime.now(),
        )
        db.add(conv)
        # Ensure parent row exists before inserting child node/relationship rows.
        await db.flush()

    # Delete any stale rows (idempotent re-runs)
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

        # ADR-032 Part G: compute timestamp_start/timestamp_end at write
        # time. Three tiers of fallback: (1) LLM-authored values on the
        # item dict; (2) min/max from utterance_ids' timestamps; (3) same
        # via chunk_ids' utterances.
        authored_ts_start = item.get("timestamp_start")
        authored_ts_end = item.get("timestamp_end")
        node_ts_start: Optional[float] = (
            float(authored_ts_start) if authored_ts_start is not None else None
        )
        node_ts_end: Optional[float] = (
            float(authored_ts_end) if authored_ts_end is not None else None
        )
        if node_ts_start is None or node_ts_end is None:
            candidate_utt_ids: List[uuid.UUID] = []
            for uid in (item.get("utterance_ids") or []):
                parsed = _coerce_uuid(uid)
                if parsed and parsed in utterance_timestamps:
                    candidate_utt_ids.append(parsed)
            if not candidate_utt_ids and chunk_id:
                chunk_uuid_for_node = _coerce_uuid(chunk_id)
                if chunk_uuid_for_node:
                    candidate_utt_ids = chunk_to_utt_ids.get(chunk_uuid_for_node, [])
            ts_starts: List[float] = [
                ts[0]
                for ts in (utterance_timestamps.get(uid) for uid in candidate_utt_ids)
                if ts and ts[0] is not None
            ]
            ts_ends: List[float] = [
                ts[1]
                for ts in (utterance_timestamps.get(uid) for uid in candidate_utt_ids)
                if ts and ts[1] is not None
            ]
            if node_ts_start is None and ts_starts:
                node_ts_start = min(ts_starts)
            if node_ts_end is None and ts_ends:
                node_ts_end = max(ts_ends)

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
            level=node_level,
            zoom_level_visible=[node_level],
            parent_id=parent_id_resolved,
            children_ids=children_resolved or None,
            cluster_info={
                "thread_id": str(thread_id) if thread_id else coerce_str(item.get("thread_id")) or None,
                "thread_state": thread_state,
                "linked_nodes": linked_nodes,
            },
            display_preferences={
                "edge_relations": edge_relations,
            },
            utterance_ids=_coerce_uuid_array(item.get("utterance_ids")),
            speaker_info=speaker_info_by_id.get(node_id),
            timestamp_start=node_ts_start,
            timestamp_end=node_ts_end,
            duration_seconds=node_duration,
        ))

    # Step 3: Write Relationship rows
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
                relation_key = (node_id, ref_to_id[related_name], "contextual", relation_text)
                if relation_key in contextual_seen:
                    continue
                contextual_seen.add(relation_key)
                db.add(Relationship(
                    id=uuid.uuid4(),
                    conversation_id=conv_uuid,
                    from_node_id=node_id,
                    to_node_id=ref_to_id[related_name],
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
    conv.total_nodes = len(node_records)
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

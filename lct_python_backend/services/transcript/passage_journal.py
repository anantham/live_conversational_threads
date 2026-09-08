"""Owner-scoped, append-only passage checkpoints in the existing artifact store.

The source cursor and generated patch share one database row/transaction. This
is a recovery journal, not another recipient graph or a transcript revision.
Canonical graph materialization and processor wiring are separate rollout work.
No function commits: callers must commit successfully BEFORE acknowledging a
passage or notifying clients. A conversation row lock serializes these writers.
"""
from __future__ import annotations

import copy
import hashlib
import json
import uuid
from typing import Any

STAGE = "conversation_passage_v1"


class JournalConflict(ValueError):
    """Stale cursor, changed evidence, or inconsistent checkpoint history."""


def _hash(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _validate_source_patch(sources: list[dict], patch: dict) -> None:
    source_by_id = {s["id"]: s for s in sources}
    if len(source_by_id) != len(sources):
        raise JournalConflict("Repeated source identity")
    chunks = patch.get("chunks", {})
    mapping = patch.get("utterance_chunk_map", {})
    referenced = [identity for ids in mapping.values() for identity in ids]
    if (set(chunks) != set(mapping) or set(referenced) != set(source_by_id)
            or len(referenced) != len(source_by_id)):
        raise JournalConflict("Patch must cover exactly this passage's source IDs")
    for cid, ids in mapping.items():
        rows = [source_by_id[identity] for identity in ids]
        if rows != sorted(rows, key=lambda row: row["sequence_number"]):
            raise JournalConflict("Chunk source order is inconsistent")
        if chunks[cid] != " ".join(row["text"] for row in rows):
            raise JournalConflict("Chunk text differs from original source")
    for node in patch.get("nodes", []):
        cid = node.get("chunk_id")
        if cid not in chunks or not set(node.get("utterance_ids") or []).issubset(mapping[cid]):
            raise JournalConflict("Node is not bound to its passage's source chunk")


def build_record(revision: int, previous_sequence: int, sources: list[dict], patch: dict,
                 policy_fingerprint: str = "interleaved-v1") -> dict:
    if not sources or revision < 1:
        raise JournalConflict("A passage needs source and a positive revision")
    _validate_source_patch(sources, patch)
    sequences = [s["sequence_number"] for s in sources]
    if sequences != sorted(set(sequences)) or sequences[0] <= previous_sequence:
        raise JournalConflict("Source order does not advance the committed cursor")
    body = copy.deepcopy({"revision": revision, "previous_sequence": previous_sequence,
                          "committed_through": sequences[-1], "sources": sources,
                          "patch": patch, "policy_fingerprint": policy_fingerprint})
    return {**body, "digest": _hash(body)}


def restore_records(records: list[dict]) -> dict:
    """Fold committed patches without running inference or changing identities."""
    state = {"revision": 0, "committed_through": -1, "nodes": [], "chunks": {},
             "utterance_chunk_map": {}}
    node_ids: set[str] = set()
    for record in records:
        body = {k: v for k, v in record.items() if k != "digest"}
        if _hash(body) != record.get("digest"):
            raise JournalConflict("Checkpoint digest mismatch")
        # Earlier one-based journals used 0 as their initial predecessor. Keep
        # those immutable receipts readable, without treating a new zero-based
        # import's first utterance as already committed.
        previous = state["committed_through"]
        if state["revision"] == 0 and record["previous_sequence"] == 0:
            previous = 0
        if (record["revision"] != state["revision"] + 1
                or record["previous_sequence"] != previous):
            raise JournalConflict("Checkpoint history is not contiguous")
        sources = record["sources"]
        sequences = [s["sequence_number"] for s in sources]
        if (not sequences or sequences != sorted(set(sequences))
                or sequences[0] <= previous
                or sequences[-1] != record["committed_through"]):
            raise JournalConflict("Checkpoint source cursor is inconsistent")
        patch = record["patch"]
        _validate_source_patch(sources, patch)
        if patch.get("remove_node_ids") or patch.get("remove_chunk_ids"):
            raise JournalConflict("Extraction journal cannot silently delete earlier interpretations")
        for node in patch.get("nodes", []):
            identity = node.get("id")
            if not identity or identity in node_ids:
                raise JournalConflict("Checkpoint repeats a node identity")
            node_ids.add(identity)
            state["nodes"].append(copy.deepcopy(node))
        for key in ("chunks", "utterance_chunk_map"):
            additions = patch.get(key, {})
            if set(additions) & set(state[key]):
                raise JournalConflict("Checkpoint repeats a source chunk")
            state[key].update(copy.deepcopy(additions))
        state["revision"] = record["revision"]
        state["committed_through"] = record["committed_through"]
    from .question_memory import fold_question_memory
    try:
        fold_question_memory(state["nodes"], state["chunks"])
    except ValueError as exc:
        raise JournalConflict("Invalid source-backed question history") from exc
    return state


async def _authorized_conversation(db, conversation_id: str, owner_id: str, *, lock: bool):
    from sqlalchemy import select
    from lct_python_backend.models import Conversation
    if not owner_id or not owner_id.strip():
        raise PermissionError("Conversation owner required")
    statement = select(Conversation).where(
        Conversation.id == uuid.UUID(conversation_id), Conversation.owner_id == owner_id,
        Conversation.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update()
    conversation = (await db.execute(statement)).scalar_one_or_none()
    if conversation is None:
        raise PermissionError("Conversation unavailable to this owner")
    return conversation


async def _records(db, conversation_id: str) -> list[dict]:
    from sqlalchemy import select
    from lct_python_backend.models import PipelineArtifact
    rows = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == uuid.UUID(conversation_id),
        PipelineArtifact.stage == STAGE,
    ).order_by(PipelineArtifact.stage_index))).scalars().all()
    records = [copy.deepcopy(row.artifact_json) for row in rows]
    for row, record in zip(rows, records):
        if row.stage_index != record.get("revision") or row.content_hash != record.get("digest"):
            raise JournalConflict("Artifact index or digest disagrees with checkpoint")
    restore_records(records)
    return records


def _source(row) -> dict:
    return {"id": str(row.id), "sequence_number": row.sequence_number, "text": row.text,
            "speaker_revision": int(getattr(row, "speaker_revision", 0) or 0),
            "speaker_id": row.speaker_id, "timestamp_start": row.timestamp_start,
            "timestamp_end": row.timestamp_end}


async def load_journal(db, *, conversation_id: str, owner_id: str) -> list[dict]:
    """Authorize before fetching any checkpoint source; detect revised evidence."""
    from sqlalchemy import select
    from lct_python_backend.models import Utterance, Node
    await _authorized_conversation(db, conversation_id, owner_id, lock=False)
    records = await _records(db, conversation_id)
    if not records:
        legacy_node = (await db.execute(select(Node.id).where(
            Node.conversation_id == uuid.UUID(conversation_id)
        ).limit(1))).scalar_one_or_none()
        if legacy_node is not None:
            raise JournalConflict("Existing graph has no passage journal; explicit migration or separate re-extraction required")
    if records:
        from .attribution_projection import inspect_source_attributions
        await inspect_source_attributions(db, records=records, conversation_id=conversation_id, owner_id=owner_id)
    return records


async def append_passage(db, *, conversation_id: str, owner_id: str, expected_revision: int,
                         source_ids: list[str], patch: dict, policy_fingerprint: str) -> dict:
    """Append under the caller's transaction; retry returns the original patch.

    The returned record is not durable until the caller commits. The input key
    includes source bytes/attribution/timing and policy, not regenerated output.
    Thus ambiguous commit acknowledgement cannot create another interpretation.
    """
    from sqlalchemy import select
    from lct_python_backend.models import Utterance, PipelineArtifact
    await _authorized_conversation(db, conversation_id, owner_id, lock=True)
    # Short commit-time locks: prevent source or human interpretation edits
    # racing validation. Never hold these locks while waiting for inference.
    from lct_python_backend.models import Node
    await db.execute(select(Utterance.id).where(Utterance.conversation_id == uuid.UUID(conversation_id)).with_for_update())
    await db.execute(select(Node.id).where(Node.conversation_id == uuid.UUID(conversation_id)).with_for_update())
    records = await load_journal(db, conversation_id=conversation_id, owner_id=owner_id)
    if expected_revision < 0 or expected_revision > len(records):
        raise JournalConflict("Unknown predecessor revision")
    previous = records[expected_revision - 1]["committed_through"] if expected_revision else -1
    if not source_ids or len(source_ids) != len(set(source_ids)):
        raise JournalConflict("Ordered distinct source IDs are required")
    rows = (await db.execute(select(Utterance).where(
        Utterance.conversation_id == uuid.UUID(conversation_id),
        Utterance.id.in_([uuid.UUID(value) for value in source_ids]),
    ).order_by(Utterance.sequence_number))).scalars().all()
    if [str(row.id) for row in rows] != source_ids:
        raise JournalConflict("Source IDs are unavailable or not in transcript order")
    sources = [_source(row) for row in rows]
    if expected_revision < len(records):
        saved = records[expected_revision]
        # load_journal already proved immutable source fields and audited any
        # later attribution changes. Recover the original acknowledgement;
        # never reinterpret a saved passage under its newer speaker labels.
        if (source_ids != [source["id"] for source in saved["sources"]]
                or policy_fingerprint != saved["policy_fingerprint"]
                or ("inference_sources" in patch and patch["inference_sources"] != saved["sources"])):
            raise JournalConflict("Retry changed source or interpretation policy")
        return copy.deepcopy(saved)
    if "inference_sources" in patch and sources != patch["inference_sources"]:
        raise JournalConflict("Inference source snapshot changed before commit")
    if patch.get("inference_context_revision") is not None:
        from .passage_projection import load_interpretation_projection
        context = await load_interpretation_projection(db, state=restore_records(records),
            conversation_id=conversation_id, owner_id=owner_id, source_records=records)
        if context.get("interpretation_revision") != patch["inference_context_revision"]:
            raise JournalConflict("Inference context changed before commit")
    pending = (await db.execute(select(Utterance.id).where(
        Utterance.conversation_id == uuid.UUID(conversation_id),
        Utterance.sequence_number > previous,
        Utterance.sequence_number <= sources[-1]["sequence_number"],
    ).order_by(Utterance.sequence_number))).scalars().all()
    if [str(value) for value in pending] != source_ids:
        raise JournalConflict("Passage skips uncommitted source evidence")
    record = build_record(expected_revision + 1, previous, sources, patch, policy_fingerprint)
    restore_records([*records, record])
    from lct_python_backend.services.graph_persistence import persist_graph
    # Reuse the canonical serializer, but never its replacement mode or its
    # internal commit. Graph rows and journal must succeed or roll back together.
    await persist_graph(
        db=db, conversation_id=conversation_id, owner_id=owner_id,
        existing_json=copy.deepcopy(record["patch"].get("nodes", [])),
        utterance_chunk_map=record["patch"].get("utterance_chunk_map", {}),
        append_only=True, commit=False,
    )
    db.add(PipelineArtifact(conversation_id=uuid.UUID(conversation_id), stage=STAGE,
                            stage_index=record["revision"], content_hash=record["digest"],
                            artifact_type="passage_checkpoint", artifact_json=record))
    await db.flush()
    return copy.deepcopy(record)

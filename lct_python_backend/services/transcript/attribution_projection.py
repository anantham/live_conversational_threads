"""Validate audited source metadata changes and flag stale interpretations.

Accepting a speaker receipt is not semantic reconciliation. Old speaker-specific
claims remain original interpretations and are explicitly marked for review.
"""
import copy
import hashlib
import json
import uuid

from .attribution_revisions import validate_attribution_history


def apply_attribution_projection(state, changes):
    projected = copy.deepcopy(state)
    for node in projected["nodes"]:
        identities = set(node.get("utterance_ids") or projected["utterance_chunk_map"].get(node.get("chunk_id"), []))
        relevant = [change for change in changes if change["utterance_id"] in identities]
        if relevant:
            node["attribution_review_required"] = True
            node["source_attributions"] = copy.deepcopy(relevant)
    if changes:
        projected["interpretation_revision"] = hashlib.sha256(json.dumps(
            [state.get("interpretation_revision"), changes], sort_keys=True).encode()).hexdigest()
    return projected


async def inspect_source_attributions(db, *, records, conversation_id, owner_id):
    from sqlalchemy import select
    from lct_python_backend.models import Utterance, SpeakerSegment
    from .passage_journal import _authorized_conversation, _source, JournalConflict

    await _authorized_conversation(db, conversation_id, owner_id, lock=False)
    if not records:
        return []
    rows = (await db.execute(select(Utterance).where(
        Utterance.conversation_id == uuid.UUID(conversation_id),
        Utterance.sequence_number <= records[-1]["committed_through"],
    ).order_by(Utterance.sequence_number))).scalars().all()
    originals = [source for record in records for source in record["sources"]]
    if len(rows) != len(originals):
        raise JournalConflict("Committed source was revised; source membership changed")
    changes = []
    for original, row in zip(originals, rows):
        current = _source(row)
        immutable = ("id", "sequence_number", "text", "timestamp_start", "timestamp_end")
        if any(original.get(key) != current.get(key) for key in immutable):
            raise JournalConflict("Committed source was revised; text/order/timing requires reconciliation")
        try:
            receipts = validate_attribution_history(
                original.get("speaker_id"), original.get("speaker_revision", 0),
                current.get("speaker_id"), current["speaker_revision"], row.platform_metadata,
            )
            evidence_ids = {uuid.UUID(value) for receipt in receipts for value in receipt["evidence_segment_ids"]}
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            raise JournalConflict("Committed source was revised without a valid attribution receipt") from exc
        if not receipts:
            continue
        evidence = (await db.execute(select(SpeakerSegment.id, SpeakerSegment.speaker_id).where(
            SpeakerSegment.conversation_id == uuid.UUID(conversation_id), SpeakerSegment.id.in_(evidence_ids),
        ))).all()
        by_id = {str(identity): speaker for identity, speaker in evidence}
        if set(by_id) != {str(identity) for identity in evidence_ids} or any(
            receipt["after"]["speaker_id"] not in {by_id[value] for value in receipt["evidence_segment_ids"]}
            for receipt in receipts
        ):
            raise JournalConflict("Attribution receipt lacks matching evidence in this conversation")
        changes.append({"utterance_id": current["id"], "original_speaker_id": original.get("speaker_id"),
                        "current_speaker_id": current.get("speaker_id"),
                        "original_revision": original.get("speaker_revision", 0),
                        "current_revision": current["speaker_revision"],
                        "evidence_segment_ids": sorted(by_id)})
    return changes

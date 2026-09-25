"""Read original retained Attendee events after exact occurrence verification."""
from __future__ import annotations

import math
from uuid import UUID

from sqlalchemy import and_, or_, select

from lct_python_backend.models import Conversation, TranscriptEvent
from .attendee_identity import parse_occurrence


def _time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


async def read_retained_source(
    db, *, conversation_id: UUID, calendar_occurrence: dict, durable_record=None,
    limit: int = 1000, after_sequence: int = 0, after_event_id=None,
):
    """SELECT only. The caller owns read-only transaction and authentication."""
    if not 1 <= limit <= 2000:
        raise ValueError("source page limit must be between 1 and 2000")
    result = await db.execute(select(
        Conversation.id, Conversation.source_metadata,
    ).where(Conversation.id == conversation_id, Conversation.deleted_at.is_(None)))
    conversation = result.mappings().one_or_none()
    if conversation is None:
        return None
    metadata = conversation["source_metadata"]
    metadata = metadata if isinstance(metadata, dict) else {}
    stored = parse_occurrence(metadata.get("calendar_occurrence"))
    requested = parse_occurrence(calendar_occurrence)
    response = {
        "identity_verified": False, "status": "identity_unverified", "segments": [],
        "next_cursor": None,
        "provenance": {
            "provider": "attendee", "conversation_id": str(conversation_id),
            "calendar_occurrence": stored, "timeline": "caption_relative",
            "drive_audio_offset_seconds": None,
            "transcription_mode": metadata.get("transcription_mode", "unknown"),
            "source": "retained_transcript_events", "timing_unit": "seconds",
        },
    }
    if (stored is None or requested is None or metadata.get("provider") != "attendee"
            or metadata.get("identity_provenance") != "authenticated_join_request"):
        return response
    if stored != requested:
        return {**response, "status": "identity_mismatch"}
    if durable_record and durable_record.get("calendar_occurrence") is not None:
        if parse_occurrence(durable_record["calendar_occurrence"]) != stored:
            return {**response, "status": "identity_conflict"}
    query = select(
        TranscriptEvent.id, TranscriptEvent.text, TranscriptEvent.event_metadata,
        TranscriptEvent.sequence_number,
    ).where(
        TranscriptEvent.conversation_id == conversation_id,
        TranscriptEvent.provider == "attendee", TranscriptEvent.event_type == "final",
    )
    if after_event_id is not None:
        query = query.where(or_(
            TranscriptEvent.sequence_number > after_sequence,
            and_(TranscriptEvent.sequence_number == after_sequence,
                 TranscriptEvent.id > after_event_id),
        ))
    query = query.order_by(TranscriptEvent.sequence_number, TranscriptEvent.id).limit(limit + 1)
    rows = (await db.execute(query)).mappings().all()
    page = rows[:limit]
    segments = []
    for row in page:
        event_metadata = row["event_metadata"]
        event_metadata = event_metadata if isinstance(event_metadata, dict) else {}
        timing = event_metadata.get("source_timing")
        timing = timing if isinstance(timing, dict) else {}
        start = _time(timing.get("start")) if timing.get("timeline") == "caption_relative" else None
        end = _time(timing.get("end")) if start is not None else None
        if end is not None and end < start:
            end = None
        segments.append({
            "id": str(row["id"]), "text": row["text"],
            "speaker": event_metadata.get("speaker_name") or event_metadata.get("speaker_uuid"),
            "start": start, "end": end,
        })
    next_cursor = None
    if len(rows) > limit:
        next_cursor = {"sequence_number": page[-1]["sequence_number"],
                       "event_id": str(page[-1]["id"])}
    return {**response, "identity_verified": True,
            "status": "ready" if segments else "empty", "segments": segments,
            "next_cursor": next_cursor}

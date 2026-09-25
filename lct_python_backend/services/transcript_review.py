"""Owner-scoped editable transcript projection; original provider events are untouched."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, update

from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.edit_logger import EditLogger


async def owned_metadata(db, conversation_id, owner_id, *, lock=False):
    query = select(Conversation.source_metadata).where(
        Conversation.id == conversation_id,
        Conversation.owner_id == owner_id,
        Conversation.deleted_at.is_(None),
    )
    if lock:
        query = query.with_for_update()
    row = (await db.execute(query)).one_or_none()
    if row is None:
        raise HTTPException(404, "Conversation not found")
    return row[0] if isinstance(row[0], dict) else {}


def utterance_query(conversation_id):
    return select(
        Utterance.id,
        Utterance.sequence_number,
        Utterance.text,
        Utterance.speaker_id,
        Utterance.speaker_name,
        Utterance.timestamp_start,
        Utterance.timestamp_end,
        Utterance.word_timings,
    ).where(Utterance.conversation_id == conversation_id)


def serialize(row):
    return {**dict(row), "id": str(row["id"])}


async def read_transcript(db, *, conversation_id: UUID, owner_id: str):
    metadata = await owned_metadata(db, conversation_id, owner_id)
    rows = (
        (
            await db.execute(
                utterance_query(conversation_id).order_by(
                    Utterance.sequence_number,
                    Utterance.id,
                )
            )
        )
        .mappings()
        .all()
    )
    # Attendee's first-caption anchor does not prove an offset into stored audio.
    caption_relative = (
        metadata.get("provider") == "attendee"
        or metadata.get("source") == "attendee_meeting_bot"
        or bool(metadata.get("meeting_url") and metadata.get("bot_name"))
    )
    return {
        "utterances": [serialize(row) for row in rows],
        "timing_basis": "caption_relative"
        if caption_relative
        else "recording_relative",
        "graph_refresh_required": bool(
            metadata.get("transcript_corrections_pending_graph_refresh")
        ),
    }


async def correct_utterance(
    db,
    *,
    conversation_id: UUID,
    utterance_id: UUID,
    expected_text: str,
    text: str,
    owner_id: str,
):
    if not text.strip():
        raise HTTPException(422, "Correction cannot be empty")
    try:
        metadata = await owned_metadata(db, conversation_id, owner_id, lock=True)
        row = (
            (
                await db.execute(
                    utterance_query(conversation_id).where(
                        Utterance.id == utterance_id,
                    )
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise HTTPException(404, "Utterance not found")
        if row["text"] != expected_text:
            raise HTTPException(
                409, "This passage changed. Reload before applying your correction."
            )
        if text == expected_text:
            return {
                "utterance": serialize(row),
                "edit_id": None,
                "graph_refresh_required": bool(
                    metadata.get("transcript_corrections_pending_graph_refresh")
                ),
            }
        changed = await db.execute(
            update(Utterance)
            .where(
                Utterance.id == utterance_id,
                Utterance.conversation_id == conversation_id,
                Utterance.text == expected_text,
            )
            .values(text=text, text_cleaned=None, word_timings=None)
        )
        if changed.rowcount != 1:
            raise HTTPException(
                409, "This passage changed. Reload before applying your correction."
            )
        await db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(
                source_metadata={
                    **metadata,
                    "transcript_corrections_pending_graph_refresh": True,
                },
            )
        )
        # Existing logger commits the pending utterance, metadata and audit row together.
        edit_id = await EditLogger(db).log_edit(
            conversation_id=str(conversation_id),
            target_type="utterance",
            target_id=str(utterance_id),
            field_name="text",
            old_value=expected_text,
            new_value=text,
            edit_type="correction",
            user_id=owner_id,
            user_comment="Transcript review correction; word alignment invalidated",
        )
        return {
            "utterance": {**serialize(row), "text": text, "word_timings": None},
            "edit_id": edit_id,
            "graph_refresh_required": True,
        }
    except Exception:
        await db.rollback()
        raise

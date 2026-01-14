import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import func, select

from lct_python_backend.models import Conversation, TranscriptEvent, Utterance


@dataclass
class SessionState:
    conversation_id: Optional[str] = None
    session_id: Optional[str] = None
    provider: Optional[str] = None
    store_audio: bool = False
    speaker_id: str = "speaker_1"
    metadata: Dict[str, Any] = None


async def ensure_conversation(session, conversation_id: str, metadata: Dict[str, Any]):
    conv_uuid = uuid.UUID(conversation_id)
    conv = await session.get(Conversation, conv_uuid)
    if conv:
        return conv

    safe_metadata = metadata or {}
    conversation_name = safe_metadata.get("conversation_name", "Live Conversation")
    owner_id = safe_metadata.get("owner_id", "default_user")

    conv = Conversation(
        id=conv_uuid,
        conversation_name=conversation_name,
        conversation_type="live_audio",
        source_type="audio_stream",
        owner_id=owner_id,
        visibility=safe_metadata.get("visibility", "private"),
        started_at=datetime.utcnow(),
        source_metadata=safe_metadata.get("source_metadata", {}),
    )
    session.add(conv)
    await session.flush()
    return conv


async def next_event_sequence(session, conversation_id: str) -> int:
    conv_uuid = uuid.UUID(conversation_id)
    result = await session.execute(
        select(func.coalesce(func.max(TranscriptEvent.sequence_number), 0)).where(
            TranscriptEvent.conversation_id == conv_uuid
        )
    )
    last = result.scalar_one()
    return int(last) + 1


async def next_utterance_sequence(session, conversation_id: str) -> int:
    conv_uuid = uuid.UUID(conversation_id)
    result = await session.execute(
        select(func.coalesce(func.max(Utterance.sequence_number), 0)).where(
            Utterance.conversation_id == conv_uuid
        )
    )
    last = result.scalar_one()
    return int(last) + 1


async def create_utterance(
    session,
    conversation: Conversation,
    text: str,
    speaker_id: str,
    speaker_name: Optional[str],
    timestamps: Dict[str, Any],
    metadata: Dict[str, Any],
) -> Utterance:
    seq = await next_utterance_sequence(session, str(conversation.id))
    timestamp_start = timestamps.get("start") if timestamps else None
    timestamp_end = timestamps.get("end") if timestamps else None
    duration = None
    if timestamp_start is not None and timestamp_end is not None:
        duration = max(0.0, float(timestamp_end) - float(timestamp_start))

    clean_text = metadata.get("text_cleaned") if metadata else None

    utterance = Utterance(
        conversation_id=conversation.id,
        text=text,
        text_cleaned=clean_text or text,
        speaker_id=speaker_id or "speaker_1",
        speaker_name=speaker_name,
        sequence_number=seq,
        timestamp_start=timestamp_start,
        timestamp_end=timestamp_end,
        duration_seconds=duration,
        platform_metadata=metadata,
    )

    word_count = len(text.split())
    conversation.total_utterances = (conversation.total_utterances or 0) + 1
    conversation.total_words = (conversation.total_words or 0) + word_count
    session.add(utterance)
    return utterance


async def persist_transcript_event(
    session,
    state: SessionState,
    payload: Dict[str, Any],
    event_type: str,
    text: str,
) -> TranscriptEvent:
    conv = await ensure_conversation(session, state.conversation_id or "", state.metadata or {})
    sequence = await next_event_sequence(session, str(conv.id))

    word_timestamps = payload.get("word_timestamps")
    segment_timestamps = payload.get("segment_timestamps")
    metadata = payload.get("metadata") or {}
    speaker_name = metadata.get("speaker_name")

    utterance_id = None
    if event_type == "final":
        utterance = await create_utterance(
            session,
            conv,
            text,
            state.speaker_id,
            speaker_name,
            payload.get("timestamps") or {},
            metadata,
        )
        utterance_id = utterance.id

    event = TranscriptEvent(
        conversation_id=conv.id,
        utterance_id=utterance_id,
        provider=state.provider,
        event_type=event_type,
        text=text,
        word_timestamps=word_timestamps,
        segment_timestamps=segment_timestamps,
        speaker_id=state.speaker_id,
        sequence_number=sequence,
        event_metadata=metadata,
    )
    session.add(event)
    return event

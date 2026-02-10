"""Persistence helpers for transcript import endpoints."""

from datetime import datetime
from typing import Any, Dict, Optional
import uuid

from lct_python_backend.models import Conversation, Utterance as DBUtterance


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

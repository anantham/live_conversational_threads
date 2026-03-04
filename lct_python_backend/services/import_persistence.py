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


async def persist_import_graph(
    *,
    db,
    conversation_id: str,
    existing_json: list,
    chunk_dict: dict,
) -> int:
    """
    Persist LLM-generated graph nodes and relationships to DB.
    Called after processor.flush() in the import pipeline.
    Returns count of nodes written.
    """
    from lct_python_backend.models import Node, Relationship
    from sqlalchemy import select, delete

    if not existing_json:
        return 0

    conv_uuid = uuid.UUID(conversation_id)

    # Delete any stale rows (idempotent re-runs)
    await db.execute(delete(Relationship).where(Relationship.conversation_id == conv_uuid))
    await db.execute(delete(Node).where(Node.conversation_id == conv_uuid))

    # Step 1: Assign stable UUIDs; build name→id map for relationship resolution
    name_to_id: Dict[str, uuid.UUID] = {}
    node_records = []
    for item in existing_json:
        node_id = uuid.uuid4()
        name = item.get("node_name") or ""
        if name:
            name_to_id[name] = node_id
        node_records.append((node_id, item))

    # Step 2: Write Node rows
    for node_id, item in node_records:
        chunk_id = item.get("chunk_id")
        node_type = (
            "bookmark" if item.get("is_bookmark")
            else "contextual_progress" if item.get("is_contextual_progress")
            else "conversational_thread"
        )
        db.add(Node(
            id=node_id,
            conversation_id=conv_uuid,
            node_name=item.get("node_name", ""),
            summary=item.get("summary", ""),
            chunk_ids=[chunk_id] if chunk_id else [],
            node_type=node_type,
            level=3,
            zoom_level_visible=[2, 3, 4],
        ))

    # Step 3: Write Relationship rows
    # 3a. Temporal chain via successor field
    for node_id, item in node_records:
        successor_name = item.get("successor")
        if successor_name and successor_name in name_to_id:
            db.add(Relationship(
                id=uuid.uuid4(),
                conversation_id=conv_uuid,
                from_node_id=node_id,
                to_node_id=name_to_id[successor_name],
                relationship_type="temporal",
                explanation="Sequential conversation flow",
                strength=1.0,
                confidence=1.0,
            ))

    # 3b. Contextual relations
    for node_id, item in node_records:
        for related_name, relation_text in (item.get("contextual_relation") or {}).items():
            if related_name in name_to_id:
                db.add(Relationship(
                    id=uuid.uuid4(),
                    conversation_id=conv_uuid,
                    from_node_id=node_id,
                    to_node_id=name_to_id[related_name],
                    relationship_type="contextual",
                    explanation=relation_text,
                    strength=0.8,
                    confidence=0.9,
                ))

    # Step 4: Update conversation node count
    conv_result = await db.execute(select(Conversation).where(Conversation.id == conv_uuid))
    conv = conv_result.scalar_one_or_none()
    if conv is not None:
        conv.total_nodes = len(node_records)

    await db.commit()
    return len(node_records)

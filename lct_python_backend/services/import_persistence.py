"""Persistence helpers for transcript import endpoints."""

from datetime import datetime
from typing import Any, Dict, Iterable, Optional, Tuple
import uuid

from lct_python_backend.models import Conversation, Utterance as DBUtterance


def _to_clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _extract_contextual_relation_pair(value: Any) -> Tuple[str, str]:
    if not isinstance(value, dict):
        return "", ""
    related_node = _to_clean_str(
        value.get("related_node_name")
        or value.get("related_node")
        or value.get("relatedNode")
        or value.get("source")
        or value.get("from")
        or value.get("node")
    )
    relation_text = _to_clean_str(
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
    seen = set()

    def _add(related_node: Any, relation_text: Any) -> Optional[Tuple[str, str]]:
        related = _to_clean_str(related_node)
        text = _to_clean_str(relation_text)
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
                relation = _add(*_extract_contextual_relation_pair(item))
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
    conversation_name: Optional[str] = None,
    source_type: Optional[str] = None,
    owner_id: str = "default_user",
    source_metadata: Optional[Dict[str, Any]] = None,
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
            is_bookmark=bool(item.get("is_bookmark")),
            is_contextual_progress=bool(item.get("is_contextual_progress")),
            level=1,
            zoom_level_visible=[1, 2, 3],
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
        for related_name, relation_text in _iter_contextual_relations(item.get("contextual_relation")):
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
    conv.total_nodes = len(node_records)

    await db.commit()
    return len(node_records)

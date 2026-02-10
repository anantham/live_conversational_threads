"""Graph generation helpers for turn-based fallback graph construction."""

import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete, select

from lct_python_backend.models import Conversation, Node, Relationship, Utterance


@dataclass
class GeneratedNodeSpec:
    """Internal representation for turn-based generated nodes."""

    id: uuid.UUID
    node_name: str
    summary: str
    speaker_id: str
    utterance_ids: List[uuid.UUID]
    start_time: Optional[float]
    end_time: Optional[float]
    chunk_id: uuid.UUID


def truncate_summary(text: str, limit: int = 320) -> str:
    normalized = (text or "").strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit].rsplit(" ", 1)[0] + "..."


def speaker_initials(value: str) -> str:
    parts = [part for part in (value or "Speaker").split() if part]
    if not parts:
        return "SP"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[1][0]).upper()


def build_turn_based_nodes(utterances: Sequence[Utterance]) -> List[GeneratedNodeSpec]:
    if not utterances:
        return []

    grouped_turns: List[List[Utterance]] = []
    current_group: List[Utterance] = []
    current_speaker: Optional[str] = None

    for utterance in utterances:
        speaker = (utterance.speaker_id or "unknown").strip() or "unknown"
        if current_speaker is None or speaker == current_speaker:
            current_group.append(utterance)
            current_speaker = speaker
        else:
            grouped_turns.append(current_group)
            current_group = [utterance]
            current_speaker = speaker

    if current_group:
        grouped_turns.append(current_group)

    node_specs: List[GeneratedNodeSpec] = []
    for group in grouped_turns:
        first = group[0]
        last = group[-1]
        speaker = (first.speaker_name or first.speaker_id or "Speaker").strip() or "Speaker"
        full_text = "\n".join((utterance.text or "").strip() for utterance in group if utterance.text)
        full_text = full_text or "(No content)"
        preview = truncate_summary(full_text, limit=90)
        node_name = f"[{speaker_initials(speaker)}] {preview}"

        node_specs.append(
            GeneratedNodeSpec(
                id=uuid.uuid4(),
                node_name=node_name,
                summary=truncate_summary(full_text),
                speaker_id=speaker,
                utterance_ids=[utterance.id for utterance in group],
                start_time=first.timestamp_start,
                end_time=last.timestamp_end,
                chunk_id=uuid.uuid4(),
            )
        )

    return node_specs


def build_temporal_edge_payload(node_specs: Sequence[GeneratedNodeSpec]) -> List[Dict[str, Any]]:
    edges: List[Dict[str, Any]] = []
    for idx in range(len(node_specs) - 1):
        source = node_specs[idx]
        target = node_specs[idx + 1]
        edges.append(
            {
                "id": uuid.uuid4(),
                "source_node_id": source.id,
                "target_node_id": target.id,
                "relationship_type": "temporal",
                "strength": 1.0,
                "description": "Sequential conversation flow",
            }
        )
    return edges


async def fetch_conversation_and_utterances(db, conversation_uuid: uuid.UUID):
    """Fetch conversation and ordered utterances for generation."""
    conversation_result = await db.execute(select(Conversation).where(Conversation.id == conversation_uuid))
    conversation = conversation_result.scalar_one_or_none()

    utterances_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number.asc())
    )
    utterances = list(utterances_result.scalars().all())

    return conversation, utterances


async def persist_generated_graph(
    db,
    conversation_uuid: uuid.UUID,
    node_specs: Sequence[GeneratedNodeSpec],
    edge_payload: Sequence[Dict[str, Any]],
) -> None:
    """Replace persisted graph for a conversation with generated turn-based graph."""
    await db.execute(delete(Relationship).where(Relationship.conversation_id == conversation_uuid))
    await db.execute(delete(Node).where(Node.conversation_id == conversation_uuid))

    for spec in node_specs:
        duration = None
        if spec.start_time is not None and spec.end_time is not None:
            duration = max(spec.end_time - spec.start_time, 0.0)

        db.add(
            Node(
                id=spec.id,
                conversation_id=conversation_uuid,
                node_name=spec.node_name,
                summary=spec.summary,
                key_points=[],
                node_type="conversational_thread",
                level=3,
                chunk_ids=[spec.chunk_id],
                utterance_ids=spec.utterance_ids,
                speaker_info={
                    "primary_speaker": spec.speaker_id,
                    "speakers": [spec.speaker_id],
                    "utterance_count": len(spec.utterance_ids),
                },
                timestamp_start=spec.start_time,
                timestamp_end=spec.end_time,
                duration_seconds=duration,
                zoom_level_visible=[2, 3, 4],
            )
        )

    for edge in edge_payload:
        db.add(
            Relationship(
                id=edge["id"],
                conversation_id=conversation_uuid,
                from_node_id=edge["source_node_id"],
                to_node_id=edge["target_node_id"],
                relationship_type="temporal",
                explanation=edge["description"],
                strength=float(edge["strength"]),
                confidence=1.0,
            )
        )

    conversation_result = await db.execute(select(Conversation).where(Conversation.id == conversation_uuid))
    conversation = conversation_result.scalar_one_or_none()
    if conversation is not None:
        conversation.total_nodes = len(node_specs)

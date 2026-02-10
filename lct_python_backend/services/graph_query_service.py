"""Graph query and serialization helpers."""

import uuid
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException
from sqlalchemy import func, select

from lct_python_backend.models import Node, Relationship

TEMPORAL_RELATIONSHIP_TYPES = {"temporal", "leads_to", "next", "follows"}


def parse_conversation_uuid(conversation_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid conversation_id format.") from exc


def is_temporal_relationship(relationship_type: Optional[str]) -> bool:
    return (relationship_type or "").strip().lower() in TEMPORAL_RELATIONSHIP_TYPES


def derive_zoom_levels(node: Node) -> List[int]:
    if node.zoom_level_visible:
        return [int(level) for level in node.zoom_level_visible if isinstance(level, int)]
    if node.level and 1 <= int(node.level) <= 5:
        return [int(node.level)]
    return [3]


def node_to_response_payload(node: Node, sequence_number: int) -> Dict[str, Any]:
    zoom_levels = derive_zoom_levels(node)
    metadata = {
        "dialogue_type": node.dialogue_type,
        "is_bookmark": bool(node.is_bookmark),
        "is_contextual_progress": bool(node.is_contextual_progress),
    }
    if node.cluster_info:
        metadata["cluster_info"] = node.cluster_info
    if node.display_preferences:
        metadata["display_preferences"] = node.display_preferences

    return {
        "id": str(node.id),
        "conversation_id": str(node.conversation_id),
        "title": node.node_name,
        "summary": node.summary,
        "node_type": node.node_type or "conversational_thread",
        "level": int(node.level or 3),
        "zoom_level_visible": zoom_levels,
        "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
        "start_time": node.timestamp_start,
        "end_time": node.timestamp_end,
        "sequence_number": sequence_number,
        "speaker_info": node.speaker_info or {},
        "keywords": node.key_points or [],
        "metadata": metadata,
        "canvas_x": node.canvas_x,
        "canvas_y": node.canvas_y,
    }


def edge_to_response_payload(edge: Relationship) -> Dict[str, Any]:
    metadata = {
        "is_temporal": is_temporal_relationship(edge.relationship_type),
        "relationship_subtype": edge.relationship_subtype,
        "confidence": edge.confidence,
        "is_bidirectional": bool(edge.is_bidirectional),
        "supporting_utterance_ids": [str(uid) for uid in (edge.supporting_utterance_ids or [])],
    }
    return {
        "id": str(edge.id),
        "source_node_id": str(edge.from_node_id),
        "target_node_id": str(edge.to_node_id),
        "relationship_type": edge.relationship_type,
        "strength": float(edge.strength or 1.0),
        "description": edge.explanation,
        "metadata": metadata,
    }


async def load_nodes_for_conversation(db, conversation_uuid: uuid.UUID, zoom_level: Optional[int] = None):
    stmt = select(Node).where(Node.conversation_id == conversation_uuid)
    if zoom_level is not None:
        stmt = stmt.where(func.array_position(Node.zoom_level_visible, zoom_level).is_not(None))
    stmt = stmt.order_by(Node.timestamp_start.asc().nullslast(), Node.created_at.asc())

    result = await db.execute(stmt)
    return list(result.scalars().all())


async def load_edges_for_nodes(db, conversation_uuid: uuid.UUID, node_ids: Sequence[uuid.UUID]):
    if not node_ids:
        return []

    stmt = (
        select(Relationship)
        .where(
            Relationship.conversation_id == conversation_uuid,
            Relationship.from_node_id.in_(node_ids),
            Relationship.to_node_id.in_(node_ids),
        )
        .order_by(Relationship.created_at.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def load_edges_for_conversation(db, conversation_uuid: uuid.UUID):
    stmt = (
        select(Relationship)
        .where(Relationship.conversation_id == conversation_uuid)
        .order_by(Relationship.created_at.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


def filter_edges_by_relationship_type(
    edges: Sequence[Relationship],
    relationship_type: Optional[str],
) -> List[Relationship]:
    if not relationship_type:
        return list(edges)

    normalized = relationship_type.strip().lower()
    if normalized == "temporal":
        return [edge for edge in edges if is_temporal_relationship(edge.relationship_type)]
    if normalized == "contextual":
        return [edge for edge in edges if not is_temporal_relationship(edge.relationship_type)]
    return [edge for edge in edges if (edge.relationship_type or "").lower() == normalized]

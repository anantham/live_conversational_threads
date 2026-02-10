"""Conversation read and serialization helpers."""

from typing import Any, Dict, List, Tuple

from sqlalchemy import select

TEMPORAL_RELATIONSHIP_TYPES = {"temporal", "leads_to", "next", "follows"}


async def fetch_conversation_bundle(db, conversation_uuid):
    """Fetch conversation, nodes, relationships, and utterances for a conversation UUID."""
    from lct_python_backend.models import Conversation, Node, Relationship, Utterance

    conversation_result = await db.execute(select(Conversation).where(Conversation.id == conversation_uuid))
    conversation = conversation_result.scalar_one_or_none()

    nodes_result = await db.execute(select(Node).where(Node.conversation_id == conversation_uuid))
    nodes = list(nodes_result.scalars().all())

    relationships_result = await db.execute(
        select(Relationship).where(Relationship.conversation_id == conversation_uuid)
    )
    relationships = list(relationships_result.scalars().all())

    utterances_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    utterances = list(utterances_result.scalars().all())

    return conversation, nodes, relationships, utterances


def build_relationship_maps(nodes, relationships):
    """Build predecessor/successor and contextual lookup maps from relationships."""
    id_to_name = {node.id: node.node_name for node in nodes}
    predecessor_by_id = {}
    successor_by_id = {}
    contextual_by_id = {}
    linked_by_id = {}

    for rel in relationships:
        source_name = id_to_name.get(rel.from_node_id)
        target_name = id_to_name.get(rel.to_node_id)
        if not source_name or not target_name:
            continue

        relationship_type = (rel.relationship_type or "related").strip() or "related"
        rel_type_lower = relationship_type.lower()
        relation_label = rel.explanation or relationship_type

        if rel_type_lower in TEMPORAL_RELATIONSHIP_TYPES:
            successor_by_id[rel.from_node_id] = str(rel.to_node_id)
            predecessor_by_id[rel.to_node_id] = str(rel.from_node_id)
            continue

        contextual_by_id.setdefault(rel.from_node_id, {})[target_name] = relation_label
        linked_by_id.setdefault(rel.from_node_id, set()).add(target_name)

        if rel.is_bidirectional:
            contextual_by_id.setdefault(rel.to_node_id, {})[source_name] = relation_label
            linked_by_id.setdefault(rel.to_node_id, set()).add(source_name)

    linked_by_id = {node_id: sorted(names) for node_id, names in linked_by_id.items()}
    return predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id


def build_graph_data_from_nodes(nodes, relationships) -> List[Dict[str, Any]]:
    """Build frontend graph payload from persisted analyzed nodes + relationships."""
    predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id = build_relationship_maps(
        nodes,
        relationships,
    )

    graph_data = []
    for node in nodes:
        contextual_relation = contextual_by_id.get(node.id, {})
        linked_nodes = linked_by_id.get(node.id, sorted(contextual_relation.keys()))
        node_data = {
            "id": str(node.id),
            "node_name": node.node_name,
            "summary": node.summary,
            "claims": [str(cid) for cid in (node.claim_ids or [])],
            "key_points": node.key_points or [],
            "predecessor": (
                str(node.predecessor_id) if node.predecessor_id else predecessor_by_id.get(node.id)
            ),
            "successor": str(node.successor_id) if node.successor_id else successor_by_id.get(node.id),
            "contextual_relation": contextual_relation,
            "linked_nodes": linked_nodes,
            "is_bookmark": node.is_bookmark,
            "is_contextual_progress": node.is_contextual_progress,
            "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
            "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
        }
        graph_data.append(node_data)

    return graph_data


def build_chunk_dict_from_utterances(utterances) -> Dict[str, str]:
    """Build chunk dictionary expected by frontend conversation view."""
    if not utterances:
        return {}

    default_chunk_id = "default_chunk"
    chunk_text = "\n".join([f"{utt.speaker_id}: {utt.text}" for utt in utterances])
    return {default_chunk_id: chunk_text}


def wrap_graph_data_chunks(graph_data: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Wrap graph data in nested chunk structure expected by frontend."""
    return [graph_data] if graph_data else []


def serialize_utterances(utterances) -> List[Dict[str, Any]]:
    """Serialize utterance rows for timeline API payload."""
    return [
        {
            "id": str(utterance.id),
            "conversation_id": str(utterance.conversation_id),
            "sequence_number": utterance.sequence_number,
            "speaker_id": utterance.speaker_id,
            "speaker_name": utterance.speaker_name,
            "text": utterance.text,
            "timestamp_start": utterance.timestamp_start,
            "timestamp_end": utterance.timestamp_end,
            "duration_seconds": utterance.duration_seconds,
        }
        for utterance in utterances
    ]

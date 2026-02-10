"""Graph generation and retrieval API endpoints."""

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation, Node, Relationship
from lct_python_backend.services.graph_generation_service import (
    build_temporal_edge_payload,
    build_turn_based_nodes,
    fetch_conversation_and_utterances,
    persist_generated_graph,
)
from lct_python_backend.services.graph_query_service import (
    edge_to_response_payload,
    filter_edges_by_relationship_type,
    is_temporal_relationship,
    load_edges_for_conversation,
    load_edges_for_nodes,
    load_nodes_for_conversation,
    node_to_response_payload,
    parse_conversation_uuid,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/graph", tags=["graph"])


class NodeResponse(BaseModel):
    """Response model for a node."""

    id: str
    conversation_id: str
    title: str
    summary: str
    node_type: str
    level: int
    zoom_level_visible: List[int]
    utterance_ids: List[str]
    start_time: Optional[float]
    end_time: Optional[float]
    sequence_number: int
    speaker_info: Dict[str, Any]
    keywords: List[str]
    metadata: Dict[str, Any]
    canvas_x: Optional[int] = None
    canvas_y: Optional[int] = None


class EdgeResponse(BaseModel):
    """Response model for an edge."""

    id: str
    source_node_id: str
    target_node_id: str
    relationship_type: str
    strength: float
    description: Optional[str] = None
    metadata: Dict[str, Any]


class GraphResponse(BaseModel):
    """Response model for a complete graph."""

    conversation_id: str
    nodes: List[NodeResponse]
    edges: List[EdgeResponse]
    node_count: int
    edge_count: int
    metadata: Dict[str, Any]


class GraphGenerationRequest(BaseModel):
    """Request model for graph generation."""

    conversation_id: str
    use_llm: bool = True
    model: Optional[str] = None
    detect_relationships: bool = True
    save_to_db: bool = True


class GraphGenerationStatusResponse(BaseModel):
    """Response model for graph generation status."""

    success: bool
    conversation_id: str
    message: str
    node_count: int
    edge_count: int
    generation_time_seconds: Optional[float]
    cost_usd: Optional[float]


def _parse_conversation_uuid(conversation_id: str):
    """Backward-compatible wrapper for internal/external imports."""
    return parse_conversation_uuid(conversation_id)


def _is_temporal_relationship(relationship_type: Optional[str]) -> bool:
    """Backward-compatible wrapper used by tests."""
    return is_temporal_relationship(relationship_type)


def _build_turn_based_nodes(utterances):
    """Backward-compatible wrapper used by tests."""
    return build_turn_based_nodes(utterances)


def _build_temporal_edge_payload(node_specs):
    """Backward-compatible wrapper used by tests."""
    return build_temporal_edge_payload(node_specs)


@router.get("/health")
async def health_check():
    """Health check endpoint for graph API."""
    return {"status": "healthy", "service": "graph_api"}


@router.post("/generate", response_model=GraphGenerationStatusResponse)
async def generate_graph(
    request: GraphGenerationRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Generate a minimal turn-based graph from utterances for a conversation."""
    started = time.perf_counter()
    conversation_uuid = _parse_conversation_uuid(request.conversation_id)

    conversation, utterances = await fetch_conversation_and_utterances(db, conversation_uuid)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not utterances:
        raise HTTPException(status_code=400, detail="No utterances found for conversation")

    node_specs = _build_turn_based_nodes(utterances)
    edge_payload = _build_temporal_edge_payload(node_specs)

    if request.save_to_db:
        try:
            await persist_generated_graph(db, conversation_uuid, node_specs, edge_payload)
            await db.commit()
        except Exception as exc:
            await db.rollback()
            logger.exception("[GRAPH] Failed to generate graph for conversation %s", request.conversation_id)
            raise HTTPException(status_code=500, detail=f"Failed to generate graph: {str(exc)}") from exc

    duration_s = round(time.perf_counter() - started, 3)
    mode_note = "LLM-assisted" if request.use_llm else "rule-based"
    return GraphGenerationStatusResponse(
        success=True,
        conversation_id=request.conversation_id,
        message=f"{mode_note} graph generation completed with turn-based fallback.",
        node_count=len(node_specs),
        edge_count=len(edge_payload),
        generation_time_seconds=duration_s,
        cost_usd=0.0,
    )


@router.get("/{conversation_id}", response_model=GraphResponse)
async def get_graph(
    conversation_id: str,
    zoom_level: Optional[int] = Query(None, ge=1, le=5, description="Filter by zoom level"),
    include_edges: bool = Query(True, description="Include edges in response"),
    db: AsyncSession = Depends(get_async_session),
):
    """Get graph payload for a conversation."""
    conversation_uuid = _parse_conversation_uuid(conversation_id)
    nodes = await load_nodes_for_conversation(db, conversation_uuid, zoom_level)
    node_responses = [NodeResponse(**node_to_response_payload(node, idx)) for idx, node in enumerate(nodes)]

    edge_responses: List[EdgeResponse] = []
    if include_edges and nodes:
        edges = await load_edges_for_nodes(db, conversation_uuid, [node.id for node in nodes])
        edge_responses = [EdgeResponse(**edge_to_response_payload(edge)) for edge in edges]

    return GraphResponse(
        conversation_id=conversation_id,
        nodes=node_responses,
        edges=edge_responses,
        node_count=len(node_responses),
        edge_count=len(edge_responses),
        metadata={
            "zoom_level_filter": zoom_level,
            "include_edges": include_edges,
        },
    )


@router.get("/{conversation_id}/nodes", response_model=List[NodeResponse])
async def get_nodes(
    conversation_id: str,
    zoom_level: Optional[int] = Query(None, ge=1, le=5, description="Filter by zoom level"),
    db: AsyncSession = Depends(get_async_session),
):
    """Get node list for a conversation."""
    conversation_uuid = _parse_conversation_uuid(conversation_id)
    nodes = await load_nodes_for_conversation(db, conversation_uuid, zoom_level)
    return [NodeResponse(**node_to_response_payload(node, idx)) for idx, node in enumerate(nodes)]


@router.get("/{conversation_id}/edges", response_model=List[EdgeResponse])
async def get_edges(
    conversation_id: str,
    relationship_type: Optional[str] = Query(None, description="temporal | contextual | explicit relationship type"),
    db: AsyncSession = Depends(get_async_session),
):
    """Get edge list for a conversation."""
    conversation_uuid = _parse_conversation_uuid(conversation_id)
    edges = await load_edges_for_conversation(db, conversation_uuid)
    filtered = filter_edges_by_relationship_type(edges, relationship_type)
    return [EdgeResponse(**edge_to_response_payload(edge)) for edge in filtered]


@router.delete("/{conversation_id}")
async def delete_graph(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete graph nodes and relationships for a conversation."""
    conversation_uuid = _parse_conversation_uuid(conversation_id)

    try:
        edges_result = await db.execute(delete(Relationship).where(Relationship.conversation_id == conversation_uuid))
        nodes_result = await db.execute(delete(Node).where(Node.conversation_id == conversation_uuid))
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("[GRAPH] Failed to delete graph for conversation %s", conversation_id)
        raise HTTPException(status_code=500, detail=f"Failed to delete graph: {str(exc)}") from exc

    return {
        "message": "Graph deleted",
        "conversation_id": conversation_id,
        "deleted_edges": int(edges_result.rowcount or 0),
        "deleted_nodes": int(nodes_result.rowcount or 0),
    }

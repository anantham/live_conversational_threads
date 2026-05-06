"""Conversation CRUD and utterance API endpoints."""

import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from google.cloud import storage
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from lct_python_backend.config import GCS_BUCKET_NAME
from lct_python_backend.db_session import get_async_session
from lct_python_backend.schemas import ConversationResponse, SaveJsonResponseExtended
from lct_python_backend.services.conversation_reader import (
    build_chunk_dict_from_utterances,
    build_graph_data_from_nodes,
    build_relationship_maps,
    fetch_conversation_bundle,
    serialize_utterances,
    wrap_graph_data_chunks,
)
from lct_python_backend.services.gcs_helpers import LOCAL_SAVE_DIR, load_conversation_from_gcs
from lct_python_backend.services.turn_synthesizer import build_turn_graph_from_utterances

logger = logging.getLogger(__name__)
router = APIRouter(tags=["conversations"])


def _build_relationship_maps(nodes, relationships):
    """Backward-compatible wrapper used by unit tests."""
    return build_relationship_maps(nodes, relationships)


@router.get("/conversations/", response_model=List[SaveJsonResponseExtended])
async def list_saved_conversations(db: AsyncSession = Depends(get_async_session)):
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation

        result = await db.execute(
            select(Conversation)
            .where(Conversation.deleted_at.is_(None))
            .order_by(Conversation.created_at.desc())
        )
        conversations_db = result.scalars().all()

        conversations = [
            {
                "file_id": str(conversation.id),
                "file_name": conversation.conversation_name,
                "message": conversation.conversation_type or "live_audio",
                "no_of_nodes": conversation.total_nodes or 0,
                "created_at": conversation.created_at.isoformat() if conversation.created_at else None,
                "conversation_type": conversation.conversation_type,
                "duration_seconds": conversation.duration_seconds,
                "started_at": conversation.started_at.isoformat() if conversation.started_at else None,
                "total_utterances": conversation.total_utterances or 0,
            }
            for conversation in conversations_db
        ]

        logger.info("Loaded %s conversations from DB", len(conversations))
        return conversations

    except Exception as exc:
        logger.exception("Error fetching conversations from DB")
        raise HTTPException(status_code=500, detail=f"Database access error: {str(exc)}")


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(conversation_id: str, db: AsyncSession = Depends(get_async_session)):
    try:
        logger.info("Fetching conversation: %s", conversation_id)
        conversation_uuid = uuid.UUID(conversation_id)

        conversation, nodes, relationships, utterances = await fetch_conversation_bundle(db, conversation_uuid)

        if not conversation:
            logger.error("Conversation not found: %s", conversation_id)
            raise HTTPException(status_code=404, detail="Conversation not found in database.")

        logger.info(
            "Found conversation '%s' with %s nodes, %s relationships, %s utterances",
            conversation.conversation_name,
            len(nodes),
            len(relationships),
            len(utterances),
        )

        graph_data = []
        chunk_dict = {}

        if nodes:
            # Preferred: use analyzed nodes from DB
            graph_data = build_graph_data_from_nodes(nodes, relationships)
            chunk_dict = build_chunk_dict_from_utterances(utterances)
        else:
            # Fallback: read graph data + chunks from saved JSON file
            # Try gcs_path first, then convention-based local path
            json_path = conversation.gcs_path
            if not json_path:
                local_candidate = LOCAL_SAVE_DIR / f"{conversation_id}.json"
                if local_candidate.exists():
                    json_path = str(local_candidate)
                    logger.info("Found local JSON by convention: %s", json_path)

            if json_path:
                try:
                    saved = load_conversation_from_gcs(json_path)
                    saved_graph = saved.get("graph_data", [])
                    saved_chunks = saved.get("chunk_dict") or saved.get("chunks", {})
                    if saved_graph:
                        # Unwrap nested [[nodes]] format if present
                        if isinstance(saved_graph[0], list):
                            graph_data = saved_graph[0]
                        else:
                            graph_data = saved_graph
                        chunk_dict = saved_chunks
                        logger.info(
                            "Loaded %s nodes + %s chunks from saved JSON: %s",
                            len(graph_data),
                            len(chunk_dict),
                            json_path,
                        )
                except Exception as exc:
                    logger.warning("Failed to load saved JSON from %s: %s", json_path, exc)

        if not graph_data and utterances:
            # Last resort: synthesize speaker turns from utterances
            graph_data = build_turn_graph_from_utterances(utterances)
            chunk_dict = build_chunk_dict_from_utterances(utterances)
            logger.info(
                "Generated %s speaker turns from %s utterances",
                len(graph_data),
                len(utterances),
            )
        elif not graph_data:
            chunk_dict = build_chunk_dict_from_utterances(utterances)

        graph_data_nested = wrap_graph_data_chunks(graph_data)

        logger.info(
            "Returning conversation payload with %s graph chunks and %s chunk_dict entries",
            len(graph_data_nested),
            len(chunk_dict),
        )

        return ConversationResponse(graph_data=graph_data_nested, chunk_dict=chunk_dict)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error loading conversation '%s'", conversation_id)
        raise HTTPException(status_code=500, detail=f"Server error: {str(exc)}")


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    hard_delete: bool = False,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete a conversation (soft or hard delete)."""
    try:
        from sqlalchemy import select, update
        from lct_python_backend.models import Conversation

        conversation_uuid = uuid.UUID(conversation_id)
        result = await db.execute(select(Conversation).where(Conversation.id == conversation_uuid))
        conversation = result.scalar_one_or_none()

        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        if hard_delete:
            if conversation.gcs_path:
                try:
                    client = storage.Client()
                    bucket = client.bucket(GCS_BUCKET_NAME)
                    blob = bucket.blob(conversation.gcs_path)
                    if blob.exists():
                        blob.delete()
                        logger.info("Deleted GCS file: %s", conversation.gcs_path)
                    else:
                        logger.warning("GCS file not found: %s", conversation.gcs_path)
                except Exception as gcs_error:
                    logger.warning("Failed to delete GCS file: %s", str(gcs_error))

            await db.delete(conversation)
            await db.commit()
            message = "Conversation permanently deleted"
            logger.info("Hard deleted conversation: %s", conversation_id)
        else:
            await db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_uuid)
                .values(deleted_at=func.now())
            )
            await db.commit()
            message = "Conversation deleted"
            logger.info("Soft deleted conversation: %s", conversation_id)

        return {"message": message, "conversation_id": conversation_id}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to delete conversation: %s", conversation_id)
        raise HTTPException(status_code=500, detail=f"Deletion failed: {str(exc)}")


class GraphSnapshotRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    chunk_dict: Optional[Dict[str, Any]] = None
    conversation_name: Optional[str] = None


@router.patch("/conversations/{conversation_id}/graph")
async def patch_conversation_graph(
    conversation_id: str,
    body: GraphSnapshotRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Upsert graph nodes + relationships for a live conversation.

    DEPRECATED for browser callers per ADR-030 §D6. The browser must not
    write canonical semantic state; use POST /api/conversations/{id}/draft
    for presentation/recovery state instead. This route is retained only
    for backend-internal use during the D6 phase 2 migration window.
    """
    from lct_python_backend.services.graph_persistence import persist_graph as persist_import_graph

    try:
        uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid conversation_id UUID")

    if not body.nodes:
        return {"persisted": 0, "conversation_id": conversation_id}

    try:
        persisted = await persist_import_graph(
            db=db,
            conversation_id=conversation_id,
            existing_json=body.nodes,
            conversation_name=body.conversation_name,
            source_type="live_audio",
        )
        logger.info(
            "[browser graph snapshot] Persisted %d nodes for conversation %s",
            persisted,
            conversation_id,
        )
        return {"persisted": persisted, "conversation_id": conversation_id}
    except Exception as exc:
        logger.exception(
            "[browser graph snapshot] Failed to persist graph for conversation %s", conversation_id
        )
        raise HTTPException(status_code=500, detail=f"Graph save failed: {exc}") from exc


class DraftStateRequest(BaseModel):
    """Browser-originated presentation/recovery draft state per ADR-030 §D6.

    Only the fields below are accepted. Any other key in the request body
    is rejected by Pydantic with a 422 ValidationError, satisfying the ADR's
    whitelist enforcement requirement (the ADR specifies "400 invalid_payload_key";
    Pydantic's structured 422 response carries equivalent semantics with field-level detail).

    Allowed (presentation/recovery, browser-authoritative):
      - conversation_name: user-edited title for the conversation
      - viewport: graph canvas zoom/pan state
      - canvas_overrides: per-node user-positioned coordinates {node_id: {x, y}}
      - dismissed_unlock_affordances: which level-unlock CTAs the user dismissed
      - active_tab: currently selected zoom-tier tab
      - active_color_mode: graph color scheme — "tier" | "speaker" | "temporal"
      - local_draft_text: in-progress notes the user typed (explicitly draft, not authored)
      - pinned_node_ids: UI focus state

    Forbidden by construction (not declared as fields, rejected by extra="forbid"):
      - nodes, relationships, clusters, claims, intent_signals, *_analysis,
        utterances, transcript_events, speaker_segments,
        is_tangent, is_crux, is_bookmark, is_contextual_progress, etc.
    """

    model_config = ConfigDict(extra="forbid")

    conversation_name: Optional[str] = None
    viewport: Optional[Dict[str, Any]] = None
    canvas_overrides: Optional[Dict[str, Any]] = None
    dismissed_unlock_affordances: Optional[List[str]] = None
    active_tab: Optional[str] = None
    active_color_mode: Optional[str] = None
    local_draft_text: Optional[str] = None
    pinned_node_ids: Optional[List[str]] = None


@router.post("/api/conversations/{conversation_id}/draft")
async def save_conversation_draft(
    conversation_id: str,
    body: DraftStateRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Persist browser-originated presentation/recovery draft state per ADR-030 §D6.

    This is the ONE explicit save path from browser to backend for non-canonical
    state. Semantic state (nodes, claims, etc.) must never pass through here —
    Pydantic's `extra="forbid"` rejects any unknown key with 422.

    Phase 1 (this commit) persists only `conversation_name` to the existing
    `conversations.conversation_name` column. Other allowed keys are accepted
    with debug logging; their persistence will land alongside D4 (custom node
    renderer) when canvas overrides become a user-visible feature.
    """
    from lct_python_backend.models import Conversation

    try:
        conversation_uuid = uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid conversation_id UUID")

    payload = body.model_dump(exclude_none=True)
    if not payload:
        return {"persisted": [], "deferred": [], "conversation_id": conversation_id}

    persisted: List[str] = []
    deferred: List[str] = []

    if "conversation_name" in payload:
        new_name = payload["conversation_name"].strip() if payload["conversation_name"] else ""
        if new_name:
            await db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_uuid)
                .values(conversation_name=new_name, updated_at=func.now())
            )
            await db.commit()
            persisted.append("conversation_name")

    # Other allowed keys: ADR-030 §D6 phase 2 — backend persistence column not
    # yet wired. Log and accept so the browser contract is honored.
    for key in (
        "viewport",
        "canvas_overrides",
        "dismissed_unlock_affordances",
        "active_tab",
        "active_color_mode",
        "local_draft_text",
        "pinned_node_ids",
    ):
        if key in payload:
            logger.debug(
                "[draft] %s received for conversation %s but persistence is deferred to D6 phase 2",
                key,
                conversation_id,
            )
            deferred.append(key)

    return {
        "persisted": persisted,
        "deferred": deferred,
        "conversation_id": conversation_id,
    }


@router.get("/api/conversations/{conversation_id}/utterances")
async def get_conversation_utterances(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get all utterances for a conversation ordered by sequence number."""
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Utterance

        result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = result.scalars().all()
        utterances_data = serialize_utterances(utterances)

        return {"utterances": utterances_data, "total": len(utterances_data)}

    except Exception as exc:
        logger.exception("Failed to get utterances for conversation: %s", conversation_id)
        raise HTTPException(status_code=500, detail=str(exc))

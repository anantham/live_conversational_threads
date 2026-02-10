"""Conversation CRUD and utterance API endpoints."""

import logging
import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from google.cloud import storage
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
                "message": "Loaded from database",
                "no_of_nodes": conversation.total_nodes or 0,
                "created_at": conversation.created_at.isoformat() if conversation.created_at else None,
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

        if nodes:
            graph_data = build_graph_data_from_nodes(nodes, relationships)
        elif utterances:
            graph_data = build_turn_graph_from_utterances(utterances)
            logger.info(
                "Generated %s speaker turns from %s utterances",
                len(graph_data),
                len(utterances),
            )
        else:
            graph_data = []

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

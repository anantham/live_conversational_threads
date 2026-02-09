"""Conversation CRUD and utterance API endpoints."""
import logging
import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, HTTPException, Depends
from google.cloud import storage
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from lct_python_backend.config import GCS_BUCKET_NAME
from lct_python_backend.db_session import get_async_session
from lct_python_backend.schemas import SaveJsonResponseExtended, ConversationResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["conversations"])


@router.get("/conversations/", response_model=List[SaveJsonResponseExtended])
async def list_saved_conversations(db: AsyncSession = Depends(get_async_session)):
    try:
        from sqlalchemy import select
        from lct_python_backend.models import Conversation

        # Query conversations using SQLAlchemy ORM (exclude soft-deleted)
        result = await db.execute(
            select(Conversation)
            .where(Conversation.deleted_at.is_(None))  # Filter out soft-deleted conversations
            .order_by(Conversation.created_at.desc())
        )
        conversations_db = result.scalars().all()

        conversations = []
        for conv in conversations_db:
            conversations.append({
                "file_id": str(conv.id),
                "file_name": conv.conversation_name,
                "message": "Loaded from database",
                "no_of_nodes": conv.total_nodes or 0,
                "created_at": conv.created_at.isoformat() if conv.created_at else None
            })

        print(f"[INFO] Loaded {len(conversations)} conversations from DB")
        return conversations

    except Exception as e:
        print(f"[FATAL] Error fetching from DB: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Database access error: {str(e)}")


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(conversation_id: str, db: AsyncSession = Depends(get_async_session)):
    try:
        print(f"[INFO] Fetching conversation: {conversation_id}")

        from sqlalchemy import select
        from lct_python_backend.models import Conversation, Node, Utterance

        # Fetch conversation
        print(f"[INFO] Querying conversation from database...")
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            print(f"[ERROR] Conversation not found: {conversation_id}")
            raise HTTPException(status_code=404, detail="Conversation not found in database.")

        print(f"[INFO] Found conversation: {conversation.conversation_name}")

        # Fetch all nodes for this conversation
        print(f"[INFO] Querying nodes...")
        nodes_result = await db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        nodes = list(nodes_result.scalars().all())
        print(f"[INFO] Found {len(nodes)} nodes")

        # Fetch all utterances for this conversation
        print(f"[INFO] Querying utterances...")
        utterances_result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = list(utterances_result.scalars().all())
        print(f"[INFO] Found {len(utterances)} utterances")

        # Build graph_data from nodes
        graph_data = []

        if nodes:
            # Use actual analyzed nodes if they exist
            for node in nodes:
                node_data = {
                    "id": str(node.id),
                    "node_name": node.node_name,
                    "summary": node.summary,
                    "claims": [str(cid) for cid in (node.claim_ids or [])],
                    "key_points": node.key_points or [],
                    "predecessor": str(node.predecessor_id) if node.predecessor_id else None,
                    "successor": str(node.successor_id) if node.successor_id else None,
                    "contextual_relation": {},  # TODO: Need to fetch relationships from Relationship table
                    "linked_nodes": [],  # TODO: Need to fetch from Relationship table
                    "is_bookmark": node.is_bookmark,
                    "is_contextual_progress": node.is_contextual_progress,
                    "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
                    "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])]
                }
                graph_data.append(node_data)

        elif utterances:
            # Generate turn-based graph by grouping consecutive utterances by same speaker
            print(f"[INFO] No nodes found - generating turn-based graph from {len(utterances)} utterances")

            # Helper function to create intelligent node labels
            def create_node_label(speaker_name: str, text: str, max_length: int = 60) -> str:
                """Create a concise, meaningful label for a graph node."""
                # Clean up text
                text = text.strip()

                # Try to get first complete sentence
                sentence_endings = ['. ', '? ', '! ', '.\n', '?\n', '!\n']
                first_sentence_end = len(text)
                for ending in sentence_endings:
                    pos = text.find(ending)
                    if pos != -1 and pos < first_sentence_end:
                        first_sentence_end = pos + 1

                # Use first sentence if it's not too long
                if first_sentence_end < max_length:
                    summary = text[:first_sentence_end].strip()
                else:
                    # Otherwise, truncate at word boundary
                    if len(text) > max_length:
                        summary = text[:max_length].rsplit(' ', 1)[0] + "..."
                    else:
                        summary = text

                # Get speaker initial(s)
                speaker_parts = speaker_name.split()
                if len(speaker_parts) >= 2:
                    initials = ''.join([p[0].upper() for p in speaker_parts[:2]])
                else:
                    initials = speaker_name[:2].upper()

                return f"[{initials}] {summary}"

            if utterances:
                current_speaker = None
                current_turn = []
                turn_nodes = []
                turn_number = 0

                for idx, utt in enumerate(utterances):
                    # Check if this is a new speaker turn
                    if utt.speaker_id != current_speaker:
                        # Save previous turn if it exists
                        if current_turn:
                            turn_number += 1
                            combined_text = "\n".join([u.text for u in current_turn])
                            first_utt = current_turn[0]
                            last_utt = current_turn[-1]

                            turn_node = {
                                "id": f"turn_{turn_number}",
                                "node_name": create_node_label(current_speaker, combined_text),
                                "summary": combined_text[:150] + "..." if len(combined_text) > 150 else combined_text,
                                "full_text": combined_text,
                                "speaker_id": current_speaker,
                                "utterance_count": len(current_turn),
                                "sequence_number": first_utt.sequence_number,
                                "timestamp_start": first_utt.timestamp_start,
                                "timestamp_end": last_utt.timestamp_end,
                                "claims": [],
                                "key_points": [],
                                "predecessor": f"turn_{turn_number - 1}" if turn_number > 1 else None,
                                "successor": None,  # Will be set when next turn is created
                                "contextual_relation": {},
                                "linked_nodes": [],
                                "is_bookmark": False,
                                "is_contextual_progress": False,
                                "chunk_id": "default_chunk",
                                "utterance_ids": [str(u.id) for u in current_turn],
                                "is_utterance_node": True
                            }

                            # Set predecessor's successor
                            if turn_nodes:
                                turn_nodes[-1]["successor"] = turn_node["id"]

                            turn_nodes.append(turn_node)

                        # Start new turn
                        current_speaker = utt.speaker_id
                        current_turn = [utt]
                    else:
                        # Same speaker, add to current turn
                        current_turn.append(utt)

                # Add final turn
                if current_turn:
                    turn_number += 1
                    combined_text = "\n".join([u.text for u in current_turn])
                    first_utt = current_turn[0]
                    last_utt = current_turn[-1]

                    turn_node = {
                        "id": f"turn_{turn_number}",
                        "node_name": create_node_label(current_speaker, combined_text),
                        "summary": combined_text[:150] + "..." if len(combined_text) > 150 else combined_text,
                        "full_text": combined_text,
                        "speaker_id": current_speaker,
                        "utterance_count": len(current_turn),
                        "sequence_number": first_utt.sequence_number,
                        "timestamp_start": first_utt.timestamp_start,
                        "timestamp_end": last_utt.timestamp_end,
                        "claims": [],
                        "key_points": [],
                        "predecessor": f"turn_{turn_number - 1}" if turn_number > 1 else None,
                        "successor": None,
                        "contextual_relation": {},
                        "linked_nodes": [],
                        "is_bookmark": False,
                        "is_contextual_progress": False,
                        "chunk_id": "default_chunk",
                        "utterance_ids": [str(u.id) for u in current_turn],
                        "is_utterance_node": True
                    }

                    if turn_nodes:
                        turn_nodes[-1]["successor"] = turn_node["id"]

                    turn_nodes.append(turn_node)

                graph_data = turn_nodes
                print(f"[INFO] Generated {len(graph_data)} speaker turns from {len(utterances)} utterances")

        # Build chunk_dict from utterances
        # Group utterances by chunk_id if available, otherwise create a default chunk
        chunk_dict = {}
        if utterances:
            # For now, create a single chunk with all utterances
            default_chunk_id = "default_chunk"
            chunk_text = "\n".join([f"{utt.speaker_id}: {utt.text}" for utt in utterances])
            chunk_dict[default_chunk_id] = chunk_text
            print(f"[INFO] Created chunk with {len(utterances)} utterances")

        print(f"[INFO] Successfully built response with {len(graph_data)} nodes and {len(chunk_dict)} chunks")

        # Wrap graph_data in an array to match expected nested structure
        # Frontend expects [[node1, node2], [node3, node4]] (array of chunks)
        # We send all nodes as a single chunk: [[node1, node2, node3]]
        if graph_data:
            graph_data_nested = [graph_data]  # Wrap in array
        else:
            graph_data_nested = []  # Empty array for no nodes

        print(f"[INFO] Returning nested graph_data structure with {len(graph_data_nested)} chunks")

        return ConversationResponse(
            graph_data=graph_data_nested,
            chunk_dict=chunk_dict
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"[FATAL] Error loading conversation '{conversation_id}': {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    hard_delete: bool = False,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Delete a conversation (soft or hard delete).

    Args:
        conversation_id: UUID of conversation to delete
        hard_delete: If True, permanently delete from DB and GCS; if False, soft delete (set deleted_at)

    Returns:
        Success message with conversation_id
    """
    try:
        from sqlalchemy import select, update
        from lct_python_backend.models import Conversation
        import uuid as uuid_lib

        # Fetch conversation
        result = await db.execute(
            select(Conversation).where(Conversation.id == uuid_lib.UUID(conversation_id))
        )
        conversation = result.scalar_one_or_none()

        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        if hard_delete:
            # Delete from GCS if path exists
            if conversation.gcs_path:
                try:
                    client = storage.Client()
                    bucket = client.bucket(GCS_BUCKET_NAME)
                    blob = bucket.blob(conversation.gcs_path)
                    if blob.exists():
                        blob.delete()
                        print(f"[INFO] Deleted GCS file: {conversation.gcs_path}")
                    else:
                        print(f"[WARNING] GCS file not found: {conversation.gcs_path}")
                except Exception as gcs_error:
                    print(f"[WARNING] Failed to delete GCS file: {gcs_error}")

            # Hard delete from DB (CASCADE will handle related tables)
            await db.delete(conversation)
            await db.commit()
            message = "Conversation permanently deleted"
            print(f"[INFO] Hard deleted conversation: {conversation_id}")
        else:
            # Soft delete
            await db.execute(
                update(Conversation)
                .where(Conversation.id == uuid_lib.UUID(conversation_id))
                .values(deleted_at=func.now())
            )
            await db.commit()
            message = "Conversation deleted"
            print(f"[INFO] Soft deleted conversation: {conversation_id}")

        return {"message": message, "conversation_id": conversation_id}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to delete conversation: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Deletion failed: {str(e)}")


@router.get("/api/conversations/{conversation_id}/utterances")
async def get_conversation_utterances(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Get all utterances for a conversation

    Returns utterances ordered by sequence number for timeline display.
    """
    try:
        from lct_python_backend.models import Utterance
        from sqlalchemy import select

        result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = result.scalars().all()

        # Serialize utterances
        utterances_data = [
            {
                "id": str(utt.id),
                "conversation_id": str(utt.conversation_id),
                "sequence_number": utt.sequence_number,
                "speaker_id": utt.speaker_id,
                "speaker_name": utt.speaker_name,
                "text": utt.text,
                "timestamp_start": utt.timestamp_start,
                "timestamp_end": utt.timestamp_end,
                "duration_seconds": utt.duration_seconds,
            }
            for utt in utterances
        ]

        return {
            "utterances": utterances_data,
            "total": len(utterances_data)
        }

    except Exception as e:
        print(f"[ERROR] Failed to get utterances: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

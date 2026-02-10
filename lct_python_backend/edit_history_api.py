"""Edit history & training data export API endpoints (Week 10)."""
import logging
from typing import Optional, List
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from lct_python_backend.db import db
from lct_python_backend.services.edit_logger import EditLogger
from lct_python_backend.services.training_data_export import TrainingDataExporter

logger = logging.getLogger(__name__)
router = APIRouter(tags=["edit-history"])


class NodeUpdateRequest(BaseModel):
    """Request model for updating a node"""
    title: Optional[str] = None
    summary: Optional[str] = None
    keywords: Optional[List[str]] = None
    changes: Optional[dict] = None  # Diff object from frontend


@router.put("/api/nodes/{node_id}")
async def update_node(node_id: str, request: NodeUpdateRequest):
    """
    Update a node and log edits for training data

    Args:
        node_id: UUID of node to update
        request: NodeUpdateRequest with title, summary, keywords, changes

    Returns:
        Updated node data
    """
    try:
        async with db.session() as session:
            # Get existing node
            from models import Node
            from sqlalchemy import select
            import uuid as uuid_module

            result = await session.execute(
                select(Node).where(Node.id == uuid_module.UUID(node_id))
            )
            node = result.scalar_one_or_none()

            if not node:
                raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

            # Log edits if changes provided
            if request.changes:
                edit_logger = EditLogger(session)
                await edit_logger.log_node_edit(
                    conversation_id=str(node.conversation_id),
                    node_id=node_id,
                    changes=request.changes,
                    user_id="user",  # TODO: Get from auth
                    user_comment=None
                )

            # Update fields
            if request.title is not None:
                node.node_name = request.title
            if request.summary is not None:
                node.summary = request.summary
            if request.keywords is not None:
                node.key_points = request.keywords

            # Save
            await session.commit()
            await session.refresh(node)

            return {
                "success": True,
                "node": {
                    "id": str(node.id),
                    "title": node.node_name,
                    "summary": node.summary,
                    "keywords": node.key_points or []
                }
            }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to update node: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/edits")
async def get_conversation_edits(
    conversation_id: str,
    limit: Optional[int] = None,
    offset: int = 0,
    target_type: Optional[str] = None,
    unexported_only: bool = False
):
    """
    Get all edits for a conversation

    Args:
        conversation_id: UUID of conversation
        limit: Maximum number of edits to return
        offset: Number of edits to skip
        target_type: Filter by target type
        unexported_only: Only return unexported edits

    Returns:
        List of edit records
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            edits = await edit_logger.get_edits_for_conversation(
                conversation_id,
                limit=limit,
                offset=offset,
                target_type=target_type,
                unexported_only=unexported_only
            )

            return {
                "conversation_id": conversation_id,
                "edits": [
                    {
                        "id": str(edit.id),
                        "target_type": edit.target_type,
                        "target_id": str(edit.target_id),
                        "field_name": edit.field_name,
                        "old_value": edit.old_value,
                        "new_value": edit.new_value,
                        "edit_type": edit.edit_type,
                        "user_id": edit.user_id,
                        "user_comment": edit.user_comment,
                        "user_confidence": edit.user_confidence,
                        "exported_for_training": edit.exported_for_training,
                        "training_dataset_id": edit.training_dataset_id,
                        "created_at": edit.created_at.isoformat() if edit.created_at else None
                    }
                    for edit in edits
                ],
                "count": len(edits)
            }

    except Exception as e:
        print(f"[ERROR] Failed to get edits: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/edits/statistics")
async def get_edit_statistics(conversation_id: str):
    """
    Get edit statistics for a conversation

    Args:
        conversation_id: UUID of conversation

    Returns:
        Statistics about edits
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            stats = await edit_logger.get_edit_statistics(conversation_id)
            return stats

    except Exception as e:
        print(f"[ERROR] Failed to get edit statistics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/conversations/{conversation_id}/training-data")
async def export_training_data(
    conversation_id: str,
    format: str = "jsonl",
    unexported_only: bool = False
):
    """
    Export training data for a conversation

    Args:
        conversation_id: UUID of conversation
        format: Export format ('jsonl', 'csv', 'markdown')
        unexported_only: Only export unexported edits

    Returns:
        Exported data as text/plain
    """
    try:
        async with db.session() as session:
            exporter = TrainingDataExporter(session)
            data = await exporter.export_conversation_edits(
                conversation_id,
                format=format,
                unexported_only=unexported_only
            )

            # Determine content type
            content_type = {
                "jsonl": "application/x-ndjson",
                "csv": "text/csv",
                "markdown": "text/markdown"
            }.get(format, "text/plain")

            # Determine filename
            dataset_id = await exporter.generate_dataset_id(conversation_id)
            extension = format
            filename = f"{dataset_id}.{extension}"

            return Response(
                content=data,
                media_type=content_type,
                headers={
                    "Content-Disposition": f"attachment; filename={filename}"
                }
            )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to export training data: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/edits/{edit_id}/feedback")
async def add_edit_feedback(edit_id: str, feedback: dict):
    """
    Add feedback to an edit

    Args:
        edit_id: UUID of edit
        feedback: Dict with 'text' field

    Returns:
        Success status
    """
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            success = await edit_logger.add_feedback(
                edit_id,
                feedback.get("text", "")
            )

            if not success:
                raise HTTPException(status_code=404, detail="Edit not found")

            return {"success": True, "message": "Feedback added"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to add feedback: {e}")
        raise HTTPException(status_code=500, detail=str(e))

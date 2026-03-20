"""Edit history & training data export API endpoints (ADR-018)."""

import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, update

from lct_python_backend.db import db
from lct_python_backend.models import EditsLog
from lct_python_backend.schemas_edit_history import (
    EditListResponse,
    EditResponse,
    EditStatisticsResponse,
)
from lct_python_backend.services.edit_logger import EditLogger
from lct_python_backend.services.training_data_export import TrainingDataExporter

logger = logging.getLogger(__name__)
router = APIRouter(tags=["edit-history"])


class NodeUpdateRequest(BaseModel):
    title: Optional[str] = None
    summary: Optional[str] = None
    keywords: Optional[List[str]] = None
    changes: Optional[dict] = None


@router.put("/api/nodes/{node_id}")
async def update_node(node_id: str, request: NodeUpdateRequest):
    """Update a node and log edits for training data."""
    try:
        async with db.session() as session:
            from lct_python_backend.models import Node
            import uuid as uuid_module

            result = await session.execute(
                select(Node).where(Node.id == uuid_module.UUID(node_id))
            )
            node = result.scalar_one_or_none()

            if not node:
                raise HTTPException(status_code=404, detail=f"Node {node_id} not found")

            if request.changes:
                edit_logger = EditLogger(session)
                await edit_logger.log_node_edit(
                    conversation_id=str(node.conversation_id),
                    node_id=node_id,
                    changes=request.changes,
                    user_id="default",
                    actor_type="human",
                    user_comment=None,
                )

            if request.title is not None:
                node.node_name = request.title
            if request.summary is not None:
                node.summary = request.summary
            if request.keywords is not None:
                node.key_points = request.keywords

            await session.commit()
            await session.refresh(node)

            return {
                "success": True,
                "node": {
                    "id": str(node.id),
                    "title": node.node_name,
                    "summary": node.summary,
                    "keywords": node.key_points or [],
                },
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to update node: %s", e)
        raise HTTPException(status_code=500, detail="Failed to update node")


@router.get("/api/conversations/{conversation_id}/edits")
async def get_conversation_edits(
    conversation_id: str,
    limit: Optional[int] = None,
    offset: int = 0,
    target_type: Optional[str] = None,
    unexported_only: bool = False,
):
    """Get all edits for a conversation."""
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            edits = await edit_logger.get_edits_for_conversation(
                conversation_id,
                limit=limit,
                offset=offset,
                target_type=target_type,
                unexported_only=unexported_only,
            )
            return EditListResponse(
                conversation_id=conversation_id,
                edits=[EditResponse.from_orm_row(e) for e in edits],
                count=len(edits),
            )

    except Exception as e:
        logger.exception("Failed to get edits: %s", e)
        raise HTTPException(status_code=500, detail="Failed to get edits")


@router.get("/api/conversations/{conversation_id}/edits/statistics")
async def get_edit_statistics(conversation_id: str):
    """Get edit statistics for a conversation."""
    try:
        async with db.session() as session:
            edit_logger = EditLogger(session)
            stats = await edit_logger.get_edit_statistics(conversation_id)
            return EditStatisticsResponse.from_raw_stats(stats)

    except Exception as e:
        logger.exception("Failed to get edit statistics: %s", e)
        raise HTTPException(status_code=500, detail="Failed to get edit statistics")


@router.get("/api/conversations/{conversation_id}/training-data")
async def export_training_data(
    conversation_id: str,
    format: str = "jsonl",
    unexported_only: bool = False,
    actor_type_filter: str = "human",
):
    """Export training data for a conversation.

    After a successful export, included edits are marked as exported
    with a training_dataset_id. Use the reset-export endpoint to undo.
    """
    try:
        async with db.session() as session:
            exporter = TrainingDataExporter(session)
            data = await exporter.export_conversation_edits(
                conversation_id,
                format=format,
                unexported_only=unexported_only,
                actor_type_filter=actor_type_filter if actor_type_filter != "all" else None,
            )

            content_type = {
                "jsonl": "application/x-ndjson",
                "csv": "text/csv",
                "markdown": "text/markdown",
            }.get(format, "text/plain")

            dataset_id = await exporter.generate_dataset_id(conversation_id)
            filename = f"{dataset_id}.{format}"

            # Mark exported edits (ADR-018: mark-on-export)
            await exporter.mark_as_exported(
                conversation_id,
                dataset_id,
                unexported_only=unexported_only,
                actor_type_filter=actor_type_filter if actor_type_filter != "all" else None,
            )

            return Response(
                content=data,
                media_type=content_type,
                headers={"Content-Disposition": f"attachment; filename={filename}"},
            )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to export training data: %s", e)
        raise HTTPException(status_code=500, detail="Failed to export training data")


@router.post("/api/conversations/{conversation_id}/edits/reset-export")
async def reset_export(conversation_id: str):
    """Reset export status for all edits in a conversation.

    Clears exported_for_training and training_dataset_id, allowing
    re-export after download failures or workflow mistakes.
    """
    try:
        async with db.session() as session:
            import uuid as uuid_module

            await session.execute(
                update(EditsLog)
                .where(EditsLog.conversation_id == uuid_module.UUID(conversation_id))
                .values(exported_for_training=False, training_dataset_id=None)
            )
            await session.commit()
            return {"success": True, "message": "Export status reset"}

    except Exception as e:
        logger.exception("Failed to reset export: %s", e)
        raise HTTPException(status_code=500, detail="Failed to reset export status")


@router.post("/api/edits/{edit_id}/feedback")
async def add_edit_feedback(edit_id: str, feedback: dict):
    """Add a post-hoc annotation to an edit.

    Appends to the annotations column with a timestamp prefix.
    user_comment (contemporaneous rationale) is not modified.
    """
    try:
        text = (feedback.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Feedback text is required")

        async with db.session() as session:
            edit_logger = EditLogger(session)
            success = await edit_logger.add_annotation(edit_id, text)

            if not success:
                raise HTTPException(status_code=404, detail="Edit not found")

            return {"success": True, "message": "Annotation added"}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to add feedback: %s", e)
        raise HTTPException(status_code=500, detail="Failed to add feedback")

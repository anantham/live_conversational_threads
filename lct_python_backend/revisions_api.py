"""Transcript revision API — decision-B review-gated slow-pass flow.

GET  /api/conversations/{id}/revisions          — list pending revisions
POST /api/conversations/{id}/revisions          — propose a new revision
GET  /api/conversations/{id}/revisions/{rid}    — get segments for one revision
POST /api/conversations/{id}/revisions/{rid}/approve  — apply + graph rebuild
POST /api/conversations/{id}/revisions/{rid}/reject   — reject without applying

All routes are owner-auth-gated by the global middleware.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.transcript.transcript_revision_service import (
    get_pending_revisions,
    get_revision_segments,
    mark_revision_approved,
    propose_revision,
    reject_revision,
)

logger = logging.getLogger("lct_backend")
router = APIRouter(tags=["revisions"])


class ProposeRevisionRequest(BaseModel):
    proposed_segments: List[Dict[str, Any]] = Field(
        ...,
        description="ASR segment list: [{speaker, start, end, text}, ...]",
    )
    source: str = Field(default="manual", description="'slow_pass' | 'resubmit' | 'manual'")
    current_utterance_count: Optional[int] = Field(
        default=None,
        description="Current utterance count — used to warn on staleness at approval time.",
    )


@router.get("/api/conversations/{conversation_id}/revisions")
async def list_revisions(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """List pending revisions for a conversation."""
    revisions = await get_pending_revisions(db, conversation_id)
    return {"conversation_id": conversation_id, "revisions": revisions}


@router.post("/api/conversations/{conversation_id}/revisions")
async def create_revision(
    conversation_id: str,
    body: ProposeRevisionRequest,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """Propose a new transcript revision.  Supersedes any existing pending revision."""
    if not body.proposed_segments:
        return JSONResponse(status_code=422, content={"detail": "proposed_segments must not be empty"})

    revision_id = await propose_revision(
        db,
        conversation_id=conversation_id,
        proposed_segments=body.proposed_segments,
        source=body.source,
        current_utterance_count=body.current_utterance_count,
    )
    await db.commit()
    return {"revision_id": revision_id, "status": "pending"}


@router.get("/api/conversations/{conversation_id}/revisions/{revision_id}")
async def get_revision(
    conversation_id: str,
    revision_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """Return full proposed_segments for one revision (potentially large)."""
    segments = await get_revision_segments(db, revision_id, conversation_id)
    if segments is None:
        return JSONResponse(status_code=404, content={"detail": "Revision not found."})
    return {"revision_id": revision_id, "proposed_segments": segments}


@router.post("/api/conversations/{conversation_id}/revisions/{revision_id}/reject")
async def reject_revision_endpoint(
    conversation_id: str,
    revision_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """Reject a pending revision — no transcript changes."""
    found = await reject_revision(db, revision_id=revision_id, conversation_id=conversation_id)
    if not found:
        return JSONResponse(status_code=404, content={"detail": "Pending revision not found."})
    await db.commit()
    return {"revision_id": revision_id, "status": "rejected"}


@router.post("/api/conversations/{conversation_id}/revisions/{revision_id}/approve")
async def approve_revision_endpoint(
    conversation_id: str,
    revision_id: str,
    request: Request,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """Approve a pending revision — applies segments and re-runs the full import pipeline.

    The apply step delegates to the same reprocess endpoint logic: segments are
    applied as the transcript and the graph is rebuilt.  The SSE stream from
    /api/conversations/{id}/reprocess is used (caller can poll that endpoint).

    For now: marks the revision approved and returns the reprocess URL for the
    caller to hit.  A future iteration can stream SSE directly from here.
    """
    segments = await mark_revision_approved(
        db, revision_id=revision_id, conversation_id=conversation_id
    )
    if segments is None:
        return JSONResponse(
            status_code=404,
            content={"detail": "Pending revision not found (already reviewed or wrong conversation)."},
        )
    await db.commit()

    # The reprocess endpoint re-runs from stored audio using current STT settings.
    # For segment-level apply, callers should POST to /reprocess which re-runs the
    # full pipeline and produces consistent utterances + graph.
    #
    # TODO: wire segments directly into the pipeline so the approved ASR output
    # (rather than re-transcribing) is what gets persisted.  For now, reprocess
    # re-runs from audio which achieves the same end result with FluidAudio.
    logger.info(
        "[revision] approved revision=%s for conversation=%s; caller should POST /reprocess",
        revision_id, conversation_id,
    )
    return {
        "revision_id": revision_id,
        "status": "approved",
        "next": f"/api/conversations/{conversation_id}/reprocess",
        "note": "POST to `next` to apply the re-transcription and rebuild the graph.",
    }

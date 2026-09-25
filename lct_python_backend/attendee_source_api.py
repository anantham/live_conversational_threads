"""Authenticated, read-only original Attendee transcript pages."""
from __future__ import annotations

import asyncio
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import text

from lct_python_backend import auth_policy
from lct_python_backend.services import attendee_bridge
from lct_python_backend.services.attendee_retained_source import read_retained_source


def require_source_auth(request: Request):
    expected = auth_policy.AUTH_TOKEN or auth_policy.ADMIN_AUTH_TOKEN
    if not expected:
        raise HTTPException(503, "Private retained-source access is not configured")
    if not auth_policy.check_bearer_token(request.headers.get("authorization") if request is not None else None, token=expected):
        raise HTTPException(401, "Invalid or missing authorization token",
                            headers={"WWW-Authenticate": "Bearer"})


async def retained_source_session():
    from lct_python_backend.db_session import get_sessionmaker
    async with get_sessionmaker()() as session:
        try:
            # PostgreSQL enforces read-only even if a future reader accidentally writes.
            await session.execute(text("SET TRANSACTION READ ONLY"))
            yield session
        finally:
            await session.rollback()


router = APIRouter(dependencies=[Depends(require_source_auth)])


@router.get("/meetings/{conversation_id}/retained-source")
async def retained_source(
    conversation_id: UUID, request: Request, response: Response,
    calendar_id: str = Query(min_length=1, max_length=2048),
    event_id: str = Query(min_length=1, max_length=1024),
    limit: int = Query(default=1000, ge=1, le=2000),
    after_sequence: Optional[int] = Query(default=None, ge=0),
    after_event_id: Optional[UUID] = None,
    db=Depends(retained_source_session),
):
    if (after_sequence is None) != (after_event_id is None):
        raise HTTPException(422, "Pagination requires both after_sequence and after_event_id")
    record = await asyncio.to_thread(attendee_bridge.get_durable_by_conversation,
                                     str(conversation_id))
    result = await read_retained_source(
        db, conversation_id=conversation_id,
        calendar_occurrence={"calendar_id": calendar_id, "event_id": event_id},
        durable_record=record, limit=limit, after_sequence=after_sequence or 0,
        after_event_id=after_event_id,
    )
    if result is None:
        raise HTTPException(404, "Retained meeting source not found")
    response.headers["Cache-Control"] = "private, no-store"
    return result

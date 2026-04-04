"""Conversation speaker naming endpoints."""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.speaker_naming_service import (
    list_conversation_speakers,
    rename_conversation_speaker,
)

router = APIRouter(prefix="/api/conversations", tags=["speaker-naming"])


class SpeakerRenameRequest(BaseModel):
    speaker_name: str


@router.get("/{conversation_id}/speakers")
async def get_conversation_speakers(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> List[Dict[str, Any]]:
    try:
        return await list_conversation_speakers(db=db, conversation_id=conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{conversation_id}/speakers/{speaker_id}")
async def patch_conversation_speaker_name(
    conversation_id: str,
    speaker_id: str,
    body: SpeakerRenameRequest,
    db: AsyncSession = Depends(get_async_session),
) -> List[Dict[str, Any]]:
    try:
        return await rename_conversation_speaker(
            db=db,
            conversation_id=conversation_id,
            speaker_id=speaker_id,
            speaker_name=body.speaker_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

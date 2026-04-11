"""Conversation speaker naming endpoints."""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import SpeakerAudioReference
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.speaker_naming_service import (
    list_conversation_speakers,
    rename_conversation_speaker,
)

router = APIRouter(prefix="/api", tags=["speaker-naming"])

router_conversations = APIRouter(prefix="/api/conversations", tags=["speaker-naming"])

RECORDINGS_DIR = Path(os.environ.get("LCT_RECORDINGS_DIR", "/tmp/lct_recordings"))
audio_storage = AudioStorageManager(str(RECORDINGS_DIR))


class SpeakerRenameRequest(BaseModel):
    speaker_name: str


@router_conversations.get("/{conversation_id}/speakers")
async def get_conversation_speakers(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> List[Dict[str, Any]]:
    try:
        return await list_conversation_speakers(db=db, conversation_id=conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router_conversations.patch("/{conversation_id}/speakers/{speaker_id}")
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
            audio_storage=audio_storage,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/speaker-voice-library")
async def get_speaker_voice_library(
    speaker_name: Optional[str] = None,
    db: AsyncSession = Depends(get_async_session),
) -> List[Dict[str, Any]]:
    """Get all stored speaker audio clips."""
    query = select(SpeakerAudioReference).order_by(SpeakerAudioReference.created_at.desc())
    if speaker_name:
        query = query.where(SpeakerAudioReference.speaker_name == speaker_name)
    result = await db.execute(query)
    refs = list(result.scalars().all())
    
    return [
        {
            "id": str(ref.id),
            "speaker_id": ref.speaker_id,
            "speaker_name": ref.speaker_name,
            "duration_seconds": ref.duration_seconds,
            "sample_rate_hz": ref.sample_rate_hz,
            "source_conversation_id": str(ref.source_conversation_id) if ref.source_conversation_id else None,
            "created_at": ref.created_at.isoformat() if ref.created_at else None,
            "audio_base64": base64.b64encode(ref.audio_wav).decode("utf-8") if ref.audio_wav else "",
        }
        for ref in refs
    ]


@router.delete("/speaker-voice-library/{reference_id}")
async def delete_speaker_audio_reference(
    reference_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> Dict[str, str]:
    """Delete a speaker audio reference."""
    result = await db.execute(
        select(SpeakerAudioReference).where(SpeakerAudioReference.id == reference_id)
    )
    ref = result.scalar_one_or_none()
    if not ref:
        raise HTTPException(status_code=404, detail="Reference not found")
    
    await db.delete(ref)
    await db.commit()
    return {"status": "deleted", "id": reference_id}

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


class SpeakerCorrectionRequest(BaseModel):
    """ADR-032 Part H v1 — a windowed speaker correction from the transcript.

    The user clicks a speaker label at a specific utterance and corrects
    it. The correction propagates to utterances within
    ``time_window_seconds`` of that utterance's timestamp that currently
    carry the SAME (wrong) speaker label — so correcting one "B:" near
    minute 12 flips the other mislabeled B's in that 5-minute span, but
    leaves A's and the B's at minute 30 untouched.
    """
    utterance_id: str
    new_speaker: str
    # ± seconds around the corrected utterance. Default ±5 min per ADR-032.
    # Pass 0 (or negative) to mean "whole conversation" (rename everywhere).
    time_window_seconds: int = 300
    source: Optional[str] = "transcript_inline"


@router_conversations.post("/{conversation_id}/speaker-correction")
async def apply_speaker_correction(
    conversation_id: str,
    body: SpeakerCorrectionRequest,
    db: AsyncSession = Depends(get_async_session),
) -> Dict[str, Any]:
    """Apply a windowed speaker rename + log it to speaker_correction_events.

    v1 behaviour (hard relabel within the window). v2 (ADR-033, deferred)
    will add voice-embedding propagation beyond the window.
    """
    import uuid as _uuid
    from lct_python_backend.models import Conversation, Utterance, SpeakerCorrectionEvent

    try:
        conv_uuid = _uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid conversation_id UUID")
    try:
        target_uuid = _uuid.UUID(body.utterance_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid utterance_id UUID")

    new_speaker = (body.new_speaker or "").strip()
    if not new_speaker:
        raise HTTPException(status_code=422, detail="new_speaker is required")

    conv = (
        await db.execute(select(Conversation).where(Conversation.id == conv_uuid))
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    target = (
        await db.execute(
            select(Utterance).where(
                Utterance.id == target_uuid,
                Utterance.conversation_id == conv_uuid,
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Utterance not found in conversation")

    # The "wrong" label we're correcting away from — prefer the display
    # name if one is set, else the raw diarization speaker_id.
    prior_speaker = (target.speaker_name or target.speaker_id or "").strip()
    target_speaker_id = target.speaker_id

    # Build the set of utterances to relabel: same speaker_id as the
    # target, within the time window. window<=0 means whole conversation.
    rows = list(
        (await db.execute(
            select(Utterance)
            .where(
                Utterance.conversation_id == conv_uuid,
                Utterance.speaker_id == target_speaker_id,
            )
            .order_by(Utterance.sequence_number)
        )).scalars().all()
    )

    window = int(body.time_window_seconds or 0)
    target_ts = target.timestamp_start
    relabeled = 0
    for utt in rows:
        if window > 0 and target_ts is not None and utt.timestamp_start is not None:
            if abs(float(utt.timestamp_start) - float(target_ts)) > window:
                continue
        if (utt.speaker_name or "") == new_speaker:
            continue
        utt.speaker_name = new_speaker
        utt.speaker_source = "user_corrected"
        utt.speaker_revision = (utt.speaker_revision or 0) + 1
        relabeled += 1

    # Audit log — also the future training set for ADR-033 voice inference.
    event = SpeakerCorrectionEvent(
        id=_uuid.uuid4(),
        conversation_id=conv_uuid,
        utterance_id=target_uuid,
        prior_speaker=prior_speaker or "(unlabeled)",
        new_speaker=new_speaker,
        time_window_seconds=window if window > 0 else 0,
        source=(body.source or "transcript_inline").strip() or "transcript_inline",
    )
    db.add(event)
    await db.commit()

    return {
        "ok": True,
        "conversation_id": conversation_id,
        "utterance_id": body.utterance_id,
        "prior_speaker": prior_speaker or None,
        "new_speaker": new_speaker,
        "time_window_seconds": window,
        "relabeled_count": relabeled,
        "scope": "whole_conversation" if window <= 0 else f"±{window}s",
    }


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

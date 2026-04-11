"""Speaker voice library - persist audio clips for known speakers across sessions."""

from __future__ import annotations

import base64
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import SpeakerAudioReference, Utterance
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.speaker_naming_service import is_confirmed_speaker_name
from lct_python_backend.services.stt_http_transcriber import pcm16le_to_wav


async def save_speaker_audio_reference(
    db: AsyncSession,
    audio_storage: AudioStorageManager,
    *,
    speaker_id: str,
    speaker_name: str,
    conversation_id: uuid.UUID,
    utterance_id: uuid.UUID,
    timestamp_start: float,
    timestamp_end: float,
    sample_rate_hz: int = 16000,
) -> Optional[SpeakerAudioReference]:
    """Save a high-quality audio clip for a confirmed speaker."""
    if not is_confirmed_speaker_name(speaker_id=speaker_id, speaker_name=speaker_name):
        return None

    slice_bytes = await audio_storage.extract_audio_slice(
        str(conversation_id),
        timestamp_start,
        timestamp_end,
    )
    if not slice_bytes:
        return None

    duration = timestamp_end - timestamp_start
    if duration < 2.0 or duration > 10.0:
        return None

    wav_data = pcm16le_to_wav(slice_bytes, sample_rate_hz)

    ref = SpeakerAudioReference(
        speaker_id=speaker_id,
        speaker_name=speaker_name,
        audio_wav=wav_data,
        sample_rate_hz=sample_rate_hz,
        source_conversation_id=conversation_id,
        source_utterance_id=utterance_id,
        source_timestamp_start=timestamp_start,
        source_timestamp_end=timestamp_end,
        duration_seconds=duration,
    )
    db.add(ref)
    await db.commit()
    return ref


async def get_speaker_audio_references(
    db: AsyncSession,
    *,
    conversation_id: Optional[uuid.UUID] = None,
    speaker_names: Optional[List[str]] = None,
    limit_per_speaker: int = 1,
) -> List[Dict[str, Any]]:
    """Retrieve stored audio references for known speakers in a conversation.
    
    Only returns references for speakers that actually appear in the conversation.
    Limits to 1 clip per speaker (max 4 speakers = 4 clips total, matching OpenAI's limit).
    """
    if not conversation_id and not speaker_names:
        return []

    query = select(SpeakerAudioReference).order_by(
        SpeakerAudioReference.created_at.desc()
    )

    if conversation_id:
        current_speakers_stmt = (
            select(Utterance.speaker_name)
            .where(Utterance.conversation_id == conversation_id)
            .where(Utterance.speaker_name.isnot(None))
            .distinct()
        )
        result = await db.execute(current_speakers_stmt)
        current_speaker_names = [r[0] for r in result.fetchall()]
        
        if current_speaker_names:
            if speaker_names:
                filter_names = [n for n in speaker_names if n in current_speaker_names]
                if filter_names:
                    query = query.where(SpeakerAudioReference.speaker_name.in_(filter_names))
            else:
                query = query.where(SpeakerAudioReference.speaker_name.in_(current_speaker_names))
        else:
            return []
    elif speaker_names:
        query = query.where(SpeakerAudioReference.speaker_name.in_(speaker_names))

    query = query.limit(limit_per_speaker * 4)
    result = await db.execute(query)
    refs = list(result.scalars().all())

    by_speaker: Dict[str, List[SpeakerAudioReference]] = {}
    for ref in refs:
        key = ref.speaker_name
        if key not in by_speaker:
            by_speaker[key] = []
        if len(by_speaker[key]) < limit_per_speaker:
            by_speaker[key].append(ref)

    output = []
    for speaker_name, speaker_refs in by_speaker.items():
        for ref in speaker_refs:
            output.append({
                "name": ref.speaker_name,
                "audio_base64": base64.b64encode(ref.audio_wav).decode("utf-8") if ref.audio_wav else "",
                "sample_rate_hz": ref.sample_rate_hz,
                "duration_seconds": ref.duration_seconds,
            })
            if len(output) >= 4:
                break
        if len(output) >= 4:
            break

    return output


async def capture_best_clips_for_speaker(
    db: AsyncSession,
    audio_storage: AudioStorageManager,
    *,
    conversation_id: uuid.UUID,
    speaker_id: str,
    speaker_name: str,
    sample_rate_hz: int = 16000,
) -> List[SpeakerAudioReference]:
    """After speaker is confirmed, capture the best audio clips from that conversation."""
    if not is_confirmed_speaker_name(speaker_id=speaker_id, speaker_name=speaker_name):
        return []

    result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_id)
        .where(Utterance.speaker_id == speaker_id)
        .where(Utterance.timestamp_start.is_not(None))
        .where(Utterance.timestamp_end.is_not(None))
        .order_by(Utterance.sequence_number)
    )
    utterances = list(result.scalars().all())

    saved_refs = []
    for u in utterances:
        if len(saved_refs) >= 1:
            break
        duration = (u.timestamp_end or 0) - (u.timestamp_start or 0)
        if 2.0 <= duration <= 10.0:
            ref = await save_speaker_audio_reference(
                db=db,
                audio_storage=audio_storage,
                speaker_id=speaker_id,
                speaker_name=speaker_name,
                conversation_id=conversation_id,
                utterance_id=u.id,
                timestamp_start=u.timestamp_start,
                timestamp_end=u.timestamp_end,
                sample_rate_hz=sample_rate_hz,
            )
            if ref:
                saved_refs.append(ref)

    return saved_refs
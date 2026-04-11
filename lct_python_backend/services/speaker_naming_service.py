"""Manual speaker naming helpers for durable participant aliases."""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from lct_python_backend.models import Conversation, Node, Utterance
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.coercion_helpers import coerce_str

_GENERIC_SPEAKER_RE = re.compile(r"^(speaker[\s_:-]*\d+|speaker[\s_:-]*[a-z]\w*|[a-z]|\d+)$", re.IGNORECASE)


def normalize_speaker_name(value: Any) -> str:
    return coerce_str(value)


def is_generic_speaker_label(value: Any) -> bool:
    label = normalize_speaker_name(value)
    if not label:
        return True
    return bool(_GENERIC_SPEAKER_RE.fullmatch(label))


def is_confirmed_speaker_name(*, speaker_id: Any, speaker_name: Any) -> bool:
    normalized_name = normalize_speaker_name(speaker_name)
    normalized_id = normalize_speaker_name(speaker_id)
    if not normalized_name:
        return False
    if normalized_name == normalized_id:
        return False
    return not is_generic_speaker_label(normalized_name)


def build_speaker_rows(utterances: List[Utterance]) -> List[Dict[str, Any]]:
    by_speaker: Dict[str, Dict[str, Any]] = {}
    for utterance in utterances:
        speaker_id = normalize_speaker_name(getattr(utterance, "speaker_id", None)) or "SPEAKER_00"
        speaker_name = normalize_speaker_name(getattr(utterance, "speaker_name", None))
        row = by_speaker.setdefault(
            speaker_id,
            {
                "speaker_id": speaker_id,
                "speaker_name": "",
                "display_name": speaker_id,
                "utterance_count": 0,
                "confirmed": False,
            },
        )
        row["utterance_count"] += 1
        if speaker_name and not row["speaker_name"]:
            row["speaker_name"] = speaker_name
        row["confirmed"] = is_confirmed_speaker_name(
            speaker_id=speaker_id,
            speaker_name=row["speaker_name"],
        )
        row["display_name"] = row["speaker_name"] or speaker_id

    return sorted(by_speaker.values(), key=lambda item: item["speaker_id"])


def _build_conversation_participants(utterances: List[Utterance]) -> List[Dict[str, Any]]:
    rows = build_speaker_rows(utterances)
    return [
        {
            "speaker_id": row["speaker_id"],
            "name": row["speaker_name"] or row["speaker_id"],
            "utterance_count": row["utterance_count"],
            "confirmed": row["confirmed"],
        }
        for row in rows
    ]


async def _resolve_speaker_id_via_nodes(
    db, conversation_uuid: uuid.UUID, requested_speaker_id: str
) -> str | None:
    """Find the real utterance speaker_id when the graph node's speaker_id doesn't match.

    Looks up Node records whose speaker_info references the requested speaker_id,
    then checks the linked utterances for the actual speaker_id stored in the DB.
    """
    node_result = await db.execute(
        select(Node).where(Node.conversation_id == conversation_uuid)
    )
    nodes = list(node_result.scalars().all())

    target_utterance_ids: list[uuid.UUID] = []
    lowered = requested_speaker_id.lower()
    for node in nodes:
        info = node.speaker_info or {}
        primary = (info.get("primary_speaker") or "").lower()
        speakers = [s.lower() for s in (info.get("speakers") or []) if isinstance(s, str)]
        if primary == lowered or lowered in speakers:
            target_utterance_ids.extend(node.utterance_ids or [])

    if not target_utterance_ids:
        return None

    # Look up one of the linked utterances to discover the real speaker_id
    sample_result = await db.execute(
        select(Utterance.speaker_id)
        .where(Utterance.id.in_(target_utterance_ids[:5]))
        .limit(1)
    )
    row = sample_result.first()
    return row[0] if row else None


async def list_conversation_speakers(*, db, conversation_id: str) -> List[Dict[str, Any]]:
    conversation_uuid = uuid.UUID(str(conversation_id))
    result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    utterances = list(result.scalars().all())
    return build_speaker_rows(utterances)


async def rename_conversation_speaker(
    *,
    db,
    conversation_id: str,
    speaker_id: str,
    speaker_name: str,
    audio_storage: Optional[AudioStorageManager] = None,
) -> List[Dict[str, Any]]:
    conversation_uuid = uuid.UUID(str(conversation_id))
    normalized_speaker_id = normalize_speaker_name(speaker_id)
    if not normalized_speaker_id:
        raise ValueError("speaker_id is required.")

    normalized_speaker_name = normalize_speaker_name(speaker_name)

    conversation_result = await db.execute(
        select(Conversation).where(Conversation.id == conversation_uuid)
    )
    conversation = conversation_result.scalar_one_or_none()
    if conversation is None:
        raise LookupError(f"Conversation not found: {conversation_id}")

    utterance_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .where(Utterance.speaker_id == normalized_speaker_id)
        .order_by(Utterance.sequence_number)
    )
    utterances = list(utterance_result.scalars().all())

    if not utterances:
        # Fallback: the graph node's speaker_id (from LLM output) may not match
        # the actual utterance speaker_id (from diarization). Resolve via Node
        # records whose speaker_info references the requested speaker_id.
        resolved_speaker_id = await _resolve_speaker_id_via_nodes(
            db, conversation_uuid, normalized_speaker_id
        )
        if resolved_speaker_id:
            utterance_result = await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conversation_uuid)
                .where(Utterance.speaker_id == resolved_speaker_id)
                .order_by(Utterance.sequence_number)
            )
            utterances = list(utterance_result.scalars().all())

    if not utterances:
        raise LookupError(
            f"Speaker {normalized_speaker_id} not found in conversation {conversation_id}"
        )

    for utterance in utterances:
        current_name = normalize_speaker_name(getattr(utterance, "speaker_name", None))
        if current_name == normalized_speaker_name:
            continue
        utterance.speaker_name = normalized_speaker_name or None

    all_utterances_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    all_utterances = list(all_utterances_result.scalars().all())
    conversation.participants = _build_conversation_participants(all_utterances)
    conversation.participant_count = len(conversation.participants or [])
    await db.commit()

    if audio_storage and is_confirmed_speaker_name(speaker_id=normalized_speaker_id, speaker_name=normalized_speaker_name):
        from lct_python_backend.services.speaker_voice_library import capture_best_clips_for_speaker
        await capture_best_clips_for_speaker(
            db=db,
            audio_storage=audio_storage,
            conversation_id=conversation_uuid,
            speaker_id=normalized_speaker_id,
            speaker_name=normalized_speaker_name,
        )

    refreshed_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    refreshed_utterances = list(refreshed_result.scalars().all())
    return build_speaker_rows(refreshed_utterances)

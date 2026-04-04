"""Manual speaker naming helpers for durable participant aliases."""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List

from sqlalchemy import select

from lct_python_backend.models import Conversation, Utterance
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

    refreshed_result = await db.execute(
        select(Utterance)
        .where(Utterance.conversation_id == conversation_uuid)
        .order_by(Utterance.sequence_number)
    )
    refreshed_utterances = list(refreshed_result.scalars().all())
    return build_speaker_rows(refreshed_utterances)

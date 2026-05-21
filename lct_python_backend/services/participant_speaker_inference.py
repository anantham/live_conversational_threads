"""Auto-assign a participant's name when a live conversation is single-speaker.

The participant picker records who is in the room on ``Conversation.participants``.
Diarization labels each utterance with a ``speaker_id`` cluster. When the
conversation has exactly one *substantive* speaker — one cluster once spurious
"crumb" clusters are discarded (a cough, an echo, a brief overlap that
diarization mis-split into its own ``SPEAKER_NN``) — and exactly one named
participant was picked, the cluster->person mapping is unambiguous: that
participant IS the speaker. This pass sets ``speaker_name`` on every un-named
utterance so the user need not rename anything.

Multi-speaker conversations are deliberately left alone: with two or more real
speakers, matching diarization clusters to picked contacts is a permutation
with no signal to resolve it without voice-clip matching (the ``known_speakers``
path). Auto-assign is the cold-start fallback for the one case that needs no
audio comparison.

Used by the live STT post-flush in ``stt_ws_session``. Idempotent — recomputes
from scratch each run — and non-fatal (the caller wraps it).
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from typing import Any, Dict, List, Optional

from sqlalchemy import select

logger = logging.getLogger("lct_backend")

# A diarization cluster contributing less than this share of total talk-weight
# is treated as a spurious crumb (over-segmentation noise) and ignored when
# deciding whether the conversation is single-speaker. Conservative on purpose:
# a real second participant who actually took part will almost always clear 5%,
# so anything below it is far more likely diarization noise than a person.
CRUMB_TALK_SHARE = 0.05

# The provenance stamped on auto-named utterances. Ranks above raw diarization
# cluster labels but below an explicit human correction (see _PROTECTED_SOURCES).
INFERRED_SPEAKER_SOURCE = "participant_inferred"

# speaker_source values this pass must never overwrite: an explicit human
# decision outranks an inference. (A user-corrected utterance also carries a
# speaker_name, so the speaker_name guard below already covers it — this is
# belt-and-suspenders and documents the precedence.)
_PROTECTED_SOURCES = frozenset({"user_corrected"})


async def infer_participant_speaker(conversation_id: Any, *, db=None) -> Dict[str, Any]:
    """Auto-name utterances for a single-speaker live conversation.

    Args:
        conversation_id: the conversation UUID (str or ``uuid.UUID``).
        db: optional ``AsyncSession``. When omitted, opens its own session —
            the live runtime runs this outside FastAPI's DI.

    Returns:
        A summary dict: ``assigned`` (utterances named), ``speaker_id`` (the
        sole substantive speaker), ``participant`` (the name applied), and
        ``skipped_reason`` when nothing was done.
    """
    if db is None:
        from lct_python_backend.db_session import get_async_session_context

        async with get_async_session_context() as own_db:
            return await _infer(conversation_id, own_db)
    return await _infer(conversation_id, db)


def _named_participants(raw_participants: Any) -> List[str]:
    """Distinct, non-empty ``display_name`` values from ``Conversation.participants``.

    Contact vs ad-hoc guest is irrelevant — any single named participant is
    enough, because the name is all the inference needs. Case-insensitive dedup
    so a picker that lists the same person twice still counts as one.
    """
    names: List[str] = []
    seen: set = set()
    for entry in raw_participants or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("display_name") or "").strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def _sole_substantive_speaker(utterances: List[Any]) -> Optional[str]:
    """Return the single substantive diarization ``speaker_id``, else ``None``.

    ``None`` means the conversation has zero or 2+ real speakers. A speaker is
    "substantive" if it clears ``CRUMB_TALK_SHARE`` of total talk-weight.
    Talk-weight is summed ``duration_seconds`` when every speech utterance has
    a positive duration; otherwise utterance count (always available — live
    nodes often lack timestamps, so duration cannot be relied on alone).
    """
    speech = [u for u in utterances if str(getattr(u, "speaker_id", "") or "").strip()]
    if not speech:
        return None

    use_duration = all((getattr(u, "duration_seconds", None) or 0) > 0 for u in speech)
    weights: Dict[str, float] = defaultdict(float)
    for u in speech:
        sid = u.speaker_id.strip()
        weights[sid] += float(u.duration_seconds) if use_duration else 1.0

    if len(weights) == 1:
        return next(iter(weights))

    total = sum(weights.values())
    if total <= 0:
        return None
    substantive = [sid for sid, w in weights.items() if w / total >= CRUMB_TALK_SHARE]
    return substantive[0] if len(substantive) == 1 else None


async def _infer(conversation_id: Any, db) -> Dict[str, Any]:
    from lct_python_backend.models import Conversation, Utterance

    summary: Dict[str, Any] = {
        "conversation_id": str(conversation_id),
        "assigned": 0,
        "speaker_id": None,
        "participant": None,
        "skipped_reason": None,
    }

    try:
        conv_uuid = uuid.UUID(str(conversation_id))
    except (TypeError, ValueError):
        logger.warning("[speaker-infer] invalid conversation_id: %r", conversation_id)
        summary["skipped_reason"] = "invalid_uuid"
        return summary
    summary["conversation_id"] = str(conv_uuid)

    conversation = (
        await db.execute(select(Conversation).where(Conversation.id == conv_uuid))
    ).scalar_one_or_none()
    if conversation is None:
        summary["skipped_reason"] = "conversation_not_found"
        return summary

    participant_names = _named_participants(conversation.participants)
    if len(participant_names) != 1:
        summary["skipped_reason"] = (
            "no_named_participant" if not participant_names else "multiple_participants"
        )
        return summary
    target_name = participant_names[0]

    utterances = list(
        (
            await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conv_uuid)
                .order_by(Utterance.sequence_number)
            )
        ).scalars().all()
    )
    if not utterances:
        summary["skipped_reason"] = "no_utterances"
        return summary

    sole_speaker = _sole_substantive_speaker(utterances)
    if sole_speaker is None:
        summary["skipped_reason"] = "not_single_speaker"
        return summary

    # One substantive speaker + one participant -> that participant is the
    # speaker. Name every un-named utterance, crumb-cluster utterances included:
    # they are mis-split fragments of the same person.
    assigned = 0
    for utt in utterances:
        if str(utt.speaker_name or "").strip():
            continue
        if str(utt.speaker_source or "").strip() in _PROTECTED_SOURCES:
            continue
        utt.speaker_name = target_name
        utt.speaker_source = INFERRED_SPEAKER_SOURCE
        assigned += 1

    if assigned:
        await db.commit()

    summary["assigned"] = assigned
    summary["speaker_id"] = sole_speaker
    summary["participant"] = target_name
    logger.info(
        "[speaker-infer] conversation=%s sole_speaker=%s participant=%s assigned=%d",
        summary["conversation_id"],
        sole_speaker,
        target_name,
        assigned,
    )
    return summary

"""Immutable speaker-segment evidence persistence plus utterance speaker materialization."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select

from lct_python_backend.models import SpeakerSegment, Utterance

logger = logging.getLogger("lct_backend")

SPEAKER_CONFIDENCE_THRESHOLD = 0.6


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_speaker_label(value: Any) -> str:
    label = _clean_text(value)
    return label or "SPEAKER_00"


def build_speaker_segment_rows(
    segments: Sequence[Dict[str, Any]],
    *,
    window_timestamps: Optional[Dict[str, Any]] = None,
    source_text: str = "",
    provider: str = "",
    model: str = "",
    transport: str = "",
    source_utterance_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Convert provider diarization output into persisted evidence rows."""
    normalized_rows: List[Dict[str, Any]] = []
    window_start = _safe_float((window_timestamps or {}).get("start"))
    window_end = _safe_float((window_timestamps or {}).get("end"))

    for index, segment in enumerate(segments or []):
        if not isinstance(segment, dict):
            continue
        speaker_id = normalize_speaker_label(segment.get("speaker") or f"SPEAKER_{index:02d}")
        relative_start = _safe_float(segment.get("start"))
        relative_end = _safe_float(segment.get("end"))
        global_start = (
            window_start + relative_start
            if window_start is not None and relative_start is not None
            else None
        )
        global_end = (
            window_start + relative_end
            if window_start is not None and relative_end is not None
            else None
        )
        if global_start is None and global_end is None and len(segments or []) == 1:
            global_start = window_start
            global_end = window_end

        normalized_rows.append(
            {
                "speaker_id": speaker_id,
                "text": _clean_text(segment.get("text")),
                "timestamp_start": global_start,
                "timestamp_end": global_end,
                "relative_start": relative_start,
                "relative_end": relative_end,
                "window_timestamp_start": window_start,
                "window_timestamp_end": window_end,
                "provider": _clean_text(provider),
                "model": _clean_text(model),
                "transport": _clean_text(transport),
                "source_utterance_id": source_utterance_id,
                "segment_metadata": {
                    "source_text": _clean_text(source_text),
                    "raw_segment": dict(segment),
                },
            }
        )

    return normalized_rows


def _segment_overlap_seconds(
    utterance: Utterance,
    segment_row: Dict[str, Any],
) -> float:
    utterance_start = _safe_float(getattr(utterance, "timestamp_start", None))
    utterance_end = _safe_float(getattr(utterance, "timestamp_end", None))
    segment_start = _safe_float(segment_row.get("timestamp_start"))
    segment_end = _safe_float(segment_row.get("timestamp_end"))
    if None in {utterance_start, utterance_end, segment_start, segment_end}:
        return 0.0
    return max(0.0, min(utterance_end, segment_end) - max(utterance_start, segment_start))


def assign_speakers_to_utterances(
    utterances: Sequence[Utterance],
    segment_rows: Sequence[Dict[str, Any]],
    *,
    source_utterance_id: Optional[str] = None,
    confidence_threshold: float = SPEAKER_CONFIDENCE_THRESHOLD,
) -> Dict[str, Any]:
    """Deterministically assign speakers by timestamp overlap.

    Ambiguous windows stay unresolved so later phases can use a bounded aligner
    instead of forcing incorrect speaker labels into the read model.
    """
    assignments: List[Dict[str, Any]] = []
    ambiguous_utterance_ids: List[str] = []

    unique_speakers = {
        normalize_speaker_label(row.get("speaker_id"))
        for row in segment_rows or []
        if _clean_text(row.get("speaker_id"))
    }

    for utterance in utterances or []:
        overlap_by_speaker: Dict[str, float] = {}
        for row in segment_rows or []:
            overlap = _segment_overlap_seconds(utterance, row)
            if overlap <= 0.0:
                continue
            speaker_id = normalize_speaker_label(row.get("speaker_id"))
            overlap_by_speaker[speaker_id] = overlap_by_speaker.get(speaker_id, 0.0) + overlap

        if overlap_by_speaker:
            total_overlap = sum(overlap_by_speaker.values())
            speaker_id, winning_overlap = max(
                overlap_by_speaker.items(),
                key=lambda item: item[1],
            )
            confidence = winning_overlap / total_overlap if total_overlap > 0.0 else 0.0
            if len(overlap_by_speaker) == 1 or confidence >= confidence_threshold:
                assignments.append(
                    {
                        "utterance_id": str(utterance.id),
                        "speaker_id": speaker_id,
                        "speaker_confidence": round(confidence, 4),
                        "speaker_source": "diarization",
                    }
                )
            else:
                ambiguous_utterance_ids.append(str(utterance.id))
            continue

        if source_utterance_id and str(utterance.id) == str(source_utterance_id) and len(unique_speakers) == 1:
            assignments.append(
                {
                    "utterance_id": str(utterance.id),
                    "speaker_id": next(iter(unique_speakers)),
                    "speaker_confidence": 1.0,
                    "speaker_source": "diarization_window",
                }
            )

    return {
        "assignments": assignments,
        "ambiguous_utterance_ids": ambiguous_utterance_ids,
    }


async def persist_speaker_refinement(
    *,
    conversation_id: str,
    segments: Sequence[Dict[str, Any]],
    source_text: str = "",
    source_utterance_id: Optional[str] = None,
    window_timestamps: Optional[Dict[str, Any]] = None,
    provider: str = "",
    model: str = "",
    transport: str = "",
) -> Dict[str, Any]:
    """Persist immutable speaker evidence and materialize utterance speaker truth."""
    if not conversation_id or not segments:
        return {
            "persisted_segments": 0,
            "updated_utterances": 0,
            "ambiguous_utterances": 0,
            "window_start": _safe_float((window_timestamps or {}).get("start")),
            "window_end": _safe_float((window_timestamps or {}).get("end")),
        }

    conversation_uuid = uuid.UUID(str(conversation_id))
    source_utterance_uuid = (
        uuid.UUID(str(source_utterance_id))
        if source_utterance_id
        else None
    )

    segment_rows = build_speaker_segment_rows(
        segments,
        window_timestamps=window_timestamps,
        source_text=source_text,
        provider=provider,
        model=model,
        transport=transport,
        source_utterance_id=source_utterance_id,
    )
    if not segment_rows:
        return {
            "persisted_segments": 0,
            "updated_utterances": 0,
            "ambiguous_utterances": 0,
            "window_start": _safe_float((window_timestamps or {}).get("start")),
            "window_end": _safe_float((window_timestamps or {}).get("end")),
        }

    from lct_python_backend.db_session import get_async_session_context

    async with get_async_session_context() as db:
        utterance_result = await db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == conversation_uuid)
            .order_by(Utterance.sequence_number)
        )
        utterances = list(utterance_result.scalars().all())

        persisted_rows = [
            SpeakerSegment(
                conversation_id=conversation_uuid,
                source_utterance_id=source_utterance_uuid,
                provider=row["provider"] or "unknown",
                model=row["model"] or None,
                transport=row["transport"] or None,
                speaker_id=row["speaker_id"],
                text=row["text"] or None,
                timestamp_start=row["timestamp_start"],
                timestamp_end=row["timestamp_end"],
                relative_start=row["relative_start"],
                relative_end=row["relative_end"],
                window_timestamp_start=row["window_timestamp_start"],
                window_timestamp_end=row["window_timestamp_end"],
                segment_metadata=row["segment_metadata"],
            )
            for row in segment_rows
        ]
        for record in persisted_rows:
            db.add(record)

        assignment_result = assign_speakers_to_utterances(
            utterances,
            segment_rows,
            source_utterance_id=source_utterance_id,
        )

        utterance_by_id = {str(utterance.id): utterance for utterance in utterances}
        updated_count = 0
        for assignment in assignment_result["assignments"]:
            utterance = utterance_by_id.get(str(assignment["utterance_id"]))
            if not utterance:
                continue
            next_speaker_id = normalize_speaker_label(assignment["speaker_id"])
            next_source = _clean_text(assignment["speaker_source"]) or "diarization"
            next_confidence = _safe_float(assignment["speaker_confidence"])
            if (
                utterance.speaker_id == next_speaker_id
                and _clean_text(getattr(utterance, "speaker_source", "")) == next_source
                and (_safe_float(getattr(utterance, "speaker_confidence", None)) == next_confidence)
            ):
                continue
            utterance.speaker_id = next_speaker_id
            utterance.speaker_source = next_source
            utterance.speaker_confidence = next_confidence
            utterance.speaker_revision = int(getattr(utterance, "speaker_revision", 0) or 0) + 1
            updated_count += 1

        await db.commit()

    result = {
        "persisted_segments": len(persisted_rows),
        "updated_utterances": updated_count,
        "ambiguous_utterances": len(assignment_result["ambiguous_utterance_ids"]),
        "window_start": _safe_float((window_timestamps or {}).get("start")),
        "window_end": _safe_float((window_timestamps or {}).get("end")),
    }
    logger.info(
        "[SPEAKER MATERIALIZE] conversation=%s source_utterance=%s provider=%s model=%s persisted_segments=%s updated_utterances=%s ambiguous_utterances=%s window_start=%s window_end=%s",
        conversation_id,
        source_utterance_id or "-",
        provider or "-",
        model or "-",
        result["persisted_segments"],
        result["updated_utterances"],
        result["ambiguous_utterances"],
        result["window_start"],
        result["window_end"],
    )
    return result

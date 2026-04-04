"""Helpers for turning transcript text / segments into canonical utterance rows."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence

from lct_python_backend.services.coercion_helpers import coerce_float, coerce_str

_SPEAKER_PREFIX_RE = re.compile(
    r"^\s*(?P<speaker>[A-Za-z][A-Za-z0-9_ \-]{0,40})\s*:\s*(?P<text>.+?)\s*$"
)


def _parse_prefixed_line(raw_line: str) -> tuple[str, str]:
    line = coerce_str(raw_line)
    match = _SPEAKER_PREFIX_RE.match(line)
    if not match:
        return "", line
    speaker_id = coerce_str(match.group("speaker"))
    text = coerce_str(match.group("text"))
    return speaker_id, text


def _utterance_row(
    *,
    text: str,
    speaker_id: str,
    sequence_number: int,
    timestamp_start: Optional[float],
    timestamp_end: Optional[float],
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    duration_seconds = None
    if timestamp_start is not None and timestamp_end is not None and timestamp_end >= timestamp_start:
        duration_seconds = round(timestamp_end - timestamp_start, 4)
    return {
        "text": coerce_str(text),
        "speaker_id": coerce_str(speaker_id) or "SPEAKER_00",
        "sequence_number": int(sequence_number),
        "timestamp_start": timestamp_start,
        "timestamp_end": timestamp_end,
        "duration_seconds": duration_seconds,
        "platform_metadata": metadata or {},
    }


def build_line_utterances(
    transcript_text: str,
    *,
    default_speaker_id: str = "SPEAKER_00",
    window_start_s: Optional[float] = None,
    window_end_s: Optional[float] = None,
    start_sequence: int = 1,
    source_label: str = "transcript_line",
) -> List[Dict[str, Any]]:
    """Split a linear transcript into coarse utterances.

    When timestamps are only available for a window, each emitted utterance keeps
    the window bounds as coarse temporal provenance instead of inventing finer
    timings.
    """
    utterances: List[Dict[str, Any]] = []
    next_sequence = max(1, int(start_sequence))
    for line_index, raw_line in enumerate(str(transcript_text or "").splitlines(), start=1):
        speaker_id, text = _parse_prefixed_line(raw_line)
        if not text:
            continue
        utterances.append(
            _utterance_row(
                text=text,
                speaker_id=speaker_id or default_speaker_id,
                sequence_number=next_sequence,
                timestamp_start=window_start_s,
                timestamp_end=window_end_s,
                metadata={
                    "source": source_label,
                    "line_index": line_index,
                    "speaker_prefixed": bool(speaker_id),
                },
            )
        )
        next_sequence += 1
    return utterances


def offset_segments(
    segments: Sequence[Dict[str, Any]],
    *,
    offset_seconds: float = 0.0,
) -> List[Dict[str, Any]]:
    """Return segment copies with start/end moved into conversation-global time."""
    adjusted_segments: List[Dict[str, Any]] = []
    offset = float(offset_seconds or 0.0)
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        updated = dict(segment)
        start = coerce_float(segment.get("start"))
        end = coerce_float(segment.get("end"))
        if start is not None:
            updated["start"] = round(start + offset, 4)
        if end is not None:
            updated["end"] = round(end + offset, 4)
        adjusted_segments.append(updated)
    return adjusted_segments


def build_segment_utterances(
    *,
    diarized_segments: Optional[Sequence[Dict[str, Any]]] = None,
    asr_segments: Optional[Sequence[Dict[str, Any]]] = None,
    transcript_text: str = "",
    default_speaker_id: str = "SPEAKER_00",
    start_sequence: int = 1,
    window_start_s: Optional[float] = None,
    window_end_s: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Build canonical utterances from the richest transcript evidence available."""
    utterances: List[Dict[str, Any]] = []
    next_sequence = max(1, int(start_sequence))

    if diarized_segments:
        for segment in diarized_segments:
            if not isinstance(segment, dict):
                continue
            text = coerce_str(segment.get("text"))
            if not text:
                continue
            utterances.append(
                _utterance_row(
                    text=text,
                    speaker_id=coerce_str(segment.get("speaker")) or default_speaker_id,
                    sequence_number=next_sequence,
                    timestamp_start=coerce_float(segment.get("start")),
                    timestamp_end=coerce_float(segment.get("end")),
                    metadata={"source": "diarized_segment"},
                )
            )
            next_sequence += 1
        if utterances:
            return utterances

    if asr_segments:
        for segment in asr_segments:
            if not isinstance(segment, dict):
                continue
            text = coerce_str(segment.get("text"))
            if not text:
                continue
            utterances.append(
                _utterance_row(
                    text=text,
                    speaker_id=default_speaker_id,
                    sequence_number=next_sequence,
                    timestamp_start=coerce_float(segment.get("start")),
                    timestamp_end=coerce_float(segment.get("end")),
                    metadata={"source": "asr_segment"},
                )
            )
            next_sequence += 1
        if utterances:
            return utterances

    return build_line_utterances(
        transcript_text,
        default_speaker_id=default_speaker_id,
        window_start_s=window_start_s,
        window_end_s=window_end_s,
        start_sequence=start_sequence,
        source_label="fallback_line",
    )

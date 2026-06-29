"""STT provider response parsers extracted from ``stt_http_transcriber``.

Each provider (WhisperX, OpenAI, OpenRouter) emits a different JSON shape.
These pure functions normalize them down to a transcript string and an
optional diarized segments list. No I/O, no global state.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("lct_backend")


def extract_transcript_text(payload: Any) -> str:
    """Best-effort transcript extraction across nested response shapes."""
    if isinstance(payload, str):
        return payload.strip()

    if not isinstance(payload, dict):
        return ""

    direct_keys = (
        "text",
        "transcript",
        "result",
        "output_text",
        "prediction",
    )
    for key in direct_keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    data_block = payload.get("data")
    if isinstance(data_block, dict):
        nested = extract_transcript_text(data_block)
        if nested:
            return nested

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            nested = extract_transcript_text(first)
            if nested:
                return nested

    return ""


def _diarized_from_entries(entries: List[Any]) -> List[Dict[str, Any]]:
    """Build {speaker, text, start, end[, embedding]} from a list of segment dicts.

    Skips entries lacking a speaker or text. Carries the ECAPA ``embedding``
    (192-dim vector) through when present so downstream speaker-identity matching
    (ADR-022) can use it instead of the anonymous SPEAKER_NN label.
    """
    segments: List[Dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        speaker = entry.get("speaker")
        text = entry.get("text")
        if not speaker or not text:
            continue
        segment: Dict[str, Any] = {
            "speaker": str(speaker),
            "text": str(text).strip(),
            "start": entry.get("start"),
            "end": entry.get("end"),
        }
        embedding = entry.get("embedding")
        if isinstance(embedding, list) and embedding:
            segment["embedding"] = embedding
        segments.append(segment)
    return segments


def extract_diarized_segments(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """Return {speaker, start, end, text[, embedding]} segments, or None.

    Handles two local-server shapes:

    * **legacy WhisperX backend** — a top-level ``speakers`` list whose entries
      are themselves the diarized utterances ({speaker, text, start, end});
    * **mlx-whisper local STT server** — ``speakers`` is just a list of speaker
      *labels* and the tagged utterances live under ``segments`` (each with a
      ``speaker`` and, when ``include_embeddings`` was requested, a 192-dim ECAPA
      ``embedding``).

    Returns None when no usable diarized segments are present; callers fall back
    to the undiarized transcript.
    """
    if not isinstance(payload, dict):
        return None

    speakers = payload.get("speakers")

    # Explicit diarization error from the server -> no segments.
    if (
        isinstance(speakers, list)
        and len(speakers) == 1
        and isinstance(speakers[0], dict)
        and "error" in speakers[0]
    ):
        logger.debug("[DIARIZE] Server returned diarization error: %s", speakers[0]["error"])
        return None

    # Legacy shape: `speakers` entries ARE the diarized utterances.
    if isinstance(speakers, list) and any(isinstance(entry, dict) for entry in speakers):
        segments = _diarized_from_entries(speakers)
        if segments:
            return segments

    # mlx-whisper shape: utterances are under `segments`, tagged with `speaker`
    # (+ optional per-segment `embedding`); `speakers` here is only labels.
    raw_segments = payload.get("segments")
    if isinstance(raw_segments, list):
        segments = _diarized_from_entries(raw_segments)
        if segments:
            return segments

    return None


def extract_openai_diarized_segments(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """Return diarized segments from OpenAI's ``segments`` array shape."""
    if not isinstance(payload, dict):
        return None
    segments = payload.get("segments")
    if not isinstance(segments, list) or not segments:
        return None

    normalized_segments: List[Dict[str, Any]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        speaker = segment.get("speaker")
        text = str(segment.get("text") or "").strip()
        if not speaker or not text:
            continue
        normalized_segments.append(
            {
                "speaker": str(speaker),
                "text": text,
                "start": segment.get("start"),
                "end": segment.get("end"),
            }
        )
    return normalized_segments or None


def text_from_segments(segments: Optional[List[Dict[str, Any]]]) -> str:
    """Join segment texts into a single transcript string."""
    if not segments:
        return ""
    parts = [str(segment.get("text") or "").strip() for segment in segments if isinstance(segment, dict)]
    return " ".join(part for part in parts if part).strip()


def extract_openrouter_transcript_text(payload: Any) -> str:
    """Return the assistant message text from an OpenRouter chat-completion payload."""
    if not isinstance(payload, dict):
        return ""

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""

    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        text_parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                text_value = str(item.get("text") or "").strip()
                if text_value:
                    text_parts.append(text_value)
        return " ".join(text_parts).strip()
    return ""

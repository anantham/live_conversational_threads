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


def extract_diarized_segments(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """Return WhisperX-style {speaker, start, end, text} segments, or None.

    Used by the local WhisperX backend which emits a top-level ``speakers``
    list. Returns None when diarization data is absent or invalid; callers
    fall back to the undiarized transcript.
    """
    if not isinstance(payload, dict):
        return None

    speakers = payload.get("speakers")
    if not isinstance(speakers, list) or not speakers:
        return None

    if len(speakers) == 1 and isinstance(speakers[0], dict) and "error" in speakers[0]:
        logger.debug("[DIARIZE] Server returned diarization error: %s", speakers[0]["error"])
        return None

    segments: List[Dict[str, Any]] = []
    for entry in speakers:
        if not isinstance(entry, dict):
            continue
        speaker = entry.get("speaker")
        text = entry.get("text")
        if not speaker or not text:
            continue
        segments.append({
            "speaker": str(speaker),
            "text": str(text).strip(),
            "start": entry.get("start"),
            "end": entry.get("end"),
        })

    return segments if segments else None


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

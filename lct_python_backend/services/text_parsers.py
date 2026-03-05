"""Text format detection and parsing for bulk upload workflows.

Handles: plain text, VTT, SRT, Google Meet transcripts, and file-kind detection.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.transcription_utils import (
    AUDIO_EXTENSIONS,
    GOOGLE_MEET_EXTENSIONS,
    SRT_EXTENSIONS,
    TEXT_EXTENSIONS,
    VTT_EXTENSIONS,
    _coerce_str,
)


def looks_like_google_meet_text(text: str) -> bool:
    candidate = _coerce_str(text)
    if not candidate:
        return False
    if "transcription ended" in candidate.lower():
        return True
    # Typical line formats:
    # 00:10:47
    # Speaker Name ~: utterance
    if re.search(r"^\s*\d{1,2}:\d{2}:\d{2}\s*$", candidate, flags=re.MULTILINE):
        return True
    if re.search(r"^[^\n:]{2,80}\s*~?\s*:\s+.+$", candidate, flags=re.MULTILINE):
        return True
    return False


def detect_file_kind(
    filename: Optional[str],
    *,
    content_type: Optional[str] = None,
    text_preview: Optional[str] = None,
) -> str:
    """Detect input kind for upload processing."""
    ext = Path(filename or "").suffix.lower()
    content_type_lc = _coerce_str(content_type).lower()
    preview = _coerce_str(text_preview)

    if ext in AUDIO_EXTENSIONS or content_type_lc.startswith("audio/"):
        return "audio"
    if ext in VTT_EXTENSIONS:
        return "vtt"
    if ext in SRT_EXTENSIONS:
        return "srt"
    if ext in GOOGLE_MEET_EXTENSIONS:
        return "google_meet"
    if ext in TEXT_EXTENSIONS:
        if looks_like_google_meet_text(preview):
            return "google_meet"
        return "text"

    if "subrip" in content_type_lc:
        return "srt"
    if "vtt" in content_type_lc:
        return "vtt"
    if "text/plain" in content_type_lc:
        if looks_like_google_meet_text(preview):
            return "google_meet"
        return "text"

    return "unknown"


def _decode_text_bytes(file_bytes: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            return file_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return file_bytes.decode("utf-8", errors="replace")


def parse_plain_text(text: str) -> str:
    cleaned = _coerce_str(text).replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.split("\n") if line.strip()]
    return "\n".join(lines)


def _strip_markup(value: str) -> str:
    # Remove simple WEBVTT markup tags (<c.foo>, <v Speaker>, etc).
    return re.sub(r"<[^>]+>", "", value).strip()


def parse_vtt_text(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    utterances: List[str] = []
    cue_lines: List[str] = []
    in_note = False

    def flush_cue() -> None:
        if not cue_lines:
            return
        utterance = " ".join(_strip_markup(line) for line in cue_lines if _strip_markup(line))
        if utterance:
            utterances.append(utterance)
        cue_lines.clear()

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            flush_cue()
            in_note = False
            continue
        if line.startswith("WEBVTT"):
            continue
        if line.upper().startswith("NOTE"):
            in_note = True
            continue
        if in_note:
            continue
        if "-->" in line:
            flush_cue()
            continue
        if re.fullmatch(r"\d+", line):
            # Optional cue id / numeric index.
            continue
        cue_lines.append(line)

    flush_cue()
    return "\n".join(utterances)


def parse_srt_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks = [block.strip() for block in normalized.split("\n\n") if block.strip()]
    utterances: List[str] = []

    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        cursor = 0
        if re.fullmatch(r"\d+", lines[0]):
            cursor = 1
        if cursor < len(lines) and "-->" in lines[cursor]:
            cursor += 1
        body = [_strip_markup(line) for line in lines[cursor:] if _strip_markup(line)]
        if body:
            utterances.append(" ".join(body))

    return "\n".join(utterances)


def parse_google_meet_text(text: str) -> str:
    parser = GoogleMeetParser()
    transcript = parser.parse_text(text)
    lines = [f"{utterance.speaker}: {utterance.text}".strip() for utterance in transcript.utterances]
    return "\n".join(line for line in lines if line and not line.endswith(":"))


def parse_google_meet_file(file_path: Path) -> str:
    parser = GoogleMeetParser()
    transcript = parser.parse_file(str(file_path))
    lines = [f"{utterance.speaker}: {utterance.text}".strip() for utterance in transcript.utterances]
    return "\n".join(line for line in lines if line and not line.endswith(":"))


def chunk_transcript_lines(transcript_text: str, *, max_chars: int = 280) -> List[str]:
    """Chunk transcript into sentence-like pieces for processor ingestion."""
    lines = [line.strip() for line in transcript_text.split("\n") if line.strip()]
    if not lines:
        return []

    chunks: List[str] = []
    buffer = ""
    for line in lines:
        if not buffer:
            buffer = line
            continue
        candidate = f"{buffer} {line}"
        if len(candidate) <= max_chars:
            buffer = candidate
        else:
            chunks.append(buffer)
            buffer = line
    if buffer:
        chunks.append(buffer)
    return chunks

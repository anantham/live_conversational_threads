"""File transcription and parsing helpers for bulk upload workflows."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

import httpx
from pydub import AudioSegment

from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.stt_http_transcriber import extract_diarized_segments, extract_transcript_text

logger = logging.getLogger("lct_backend")

# Chunked audio transcription defaults
DEFAULT_CHUNK_DURATION_S = int(os.getenv("STT_CHUNK_DURATION_S", "60"))
DEFAULT_CHUNK_OVERLAP_S = int(os.getenv("STT_CHUNK_OVERLAP_S", "2"))

# Type alias for progress callbacks: (chunk_index, total_chunks, chunk_transcript) -> None
ProgressCallback = Callable[[int, int, str], Awaitable[None]]

AUDIO_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
    ".flac",
    ".aac",
    ".webm",
    ".mp4",
}
TEXT_EXTENSIONS = {".txt", ".text", ".md", ".log"}
VTT_EXTENSIONS = {".vtt"}
SRT_EXTENSIONS = {".srt"}
GOOGLE_MEET_EXTENSIONS = {".pdf"}


@dataclass
class FileTranscriptResult:
    """Normalized transcript extraction result."""

    transcript_text: str
    source_type: str
    metadata: Dict[str, Any]


def _coerce_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


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


async def transcribe_audio_file(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file via HTTP STT provider."""

    target_url = _coerce_str(http_url)
    if not target_url:
        raise ValueError("STT HTTP URL is required for audio transcription.")

    payload_bytes = file_path.read_bytes()
    if not payload_bytes:
        raise ValueError("Uploaded audio file is empty.")

    guessed_content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    form_data: Dict[str, str] = {}
    if _coerce_str(model):
        form_data["model"] = _coerce_str(model)
    if _coerce_str(language):
        form_data["language"] = _coerce_str(language)

    files = {
        "file": (file_path.name, payload_bytes, guessed_content_type),
    }
    t = max(5.0, float(timeout_seconds or 120.0))
    timeout = httpx.Timeout(connect=10.0, read=t, write=t, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
        response = await client.post(target_url, data=form_data, files=files)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body_preview = response.text[:300]
            raise RuntimeError(
                f"STT provider request failed ({exc.response.status_code}): {body_preview}"
            ) from exc

    content_type = _coerce_str(response.headers.get("content-type")).lower()
    parsed_payload: Any
    if "application/json" in content_type:
        parsed_payload = response.json()
    else:
        raw_text = response.text.strip()
        try:
            parsed_payload = json.loads(raw_text)
        except json.JSONDecodeError:
            parsed_payload = {"text": raw_text}

    # Prefer diarized speaker segments when available; fall back to plain text
    segments = extract_diarized_segments(parsed_payload)
    if segments:
        transcript = "\n".join(
            f"{seg['speaker']}: {seg['text']}" for seg in segments
        ).strip()
    else:
        transcript = extract_transcript_text(parsed_payload).strip()
    if not transcript:
        raise RuntimeError("STT provider returned empty transcript.")
    return transcript


def _split_audio_to_chunks(
    file_path: Path,
    chunk_duration_s: int = DEFAULT_CHUNK_DURATION_S,
    overlap_s: int = DEFAULT_CHUNK_OVERLAP_S,
) -> List[Tuple[Path, int, int]]:
    """Split an audio file into overlapping WAV chunks on disk.

    Returns a list of (chunk_path, start_ms, end_ms) tuples.  Caller is
    responsible for cleaning up the temp files.
    """
    audio = AudioSegment.from_file(str(file_path))
    duration_ms = len(audio)
    chunk_ms = chunk_duration_s * 1000
    overlap_ms = overlap_s * 1000
    step_ms = max(1000, chunk_ms - overlap_ms)

    chunks: List[Tuple[Path, int, int]] = []
    start = 0
    while start < duration_ms:
        end = min(start + chunk_ms, duration_ms)
        segment = audio[start:end]

        tmp = tempfile.NamedTemporaryFile(
            suffix=".wav", prefix="stt_chunk_", delete=False,
        )
        segment.export(tmp.name, format="wav")
        tmp.close()
        chunks.append((Path(tmp.name), start, end))

        if end >= duration_ms:
            break
        start += step_ms

    logger.info(
        "[CHUNK] Split %s (%d ms) into %d chunks of ~%d s with %d s overlap",
        file_path.name, duration_ms, len(chunks), chunk_duration_s, overlap_s,
    )
    return chunks


async def transcribe_audio_chunked(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    chunk_duration_s: int = DEFAULT_CHUNK_DURATION_S,
    overlap_s: int = DEFAULT_CHUNK_OVERLAP_S,
    on_chunk_progress: Optional[ProgressCallback] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file by splitting into chunks and sending each to STT.

    Falls back to single-shot transcription for short files (< 2 chunks).
    """
    chunks = _split_audio_to_chunks(file_path, chunk_duration_s, overlap_s)

    if len(chunks) <= 1:
        # Short file — no need to chunk, clean up and send directly
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)
        return await transcribe_audio_file(
            file_path, http_url=http_url, model=model,
            language=language, timeout_seconds=timeout_seconds,
            transport=transport,
        )

    transcripts: List[str] = []
    total = len(chunks)
    try:
        for idx, (chunk_path, start_ms, end_ms) in enumerate(chunks):
            logger.info(
                "[CHUNK] Transcribing chunk %d/%d (%d–%d ms) via %s",
                idx + 1, total, start_ms, end_ms, http_url,
            )
            text = await transcribe_audio_file(
                chunk_path, http_url=http_url, model=model,
                language=language, timeout_seconds=timeout_seconds,
                transport=transport,
            )
            transcripts.append(text)
            if on_chunk_progress:
                await on_chunk_progress(idx + 1, total, text)
    finally:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)

    return "\n".join(transcripts)


async def transcribe_uploaded_file(
    *,
    temp_path: Path,
    filename: str,
    content_type: Optional[str],
    stt_settings: Optional[Dict[str, Any]] = None,
    provider_override: Optional[str] = None,
    source_type_override: Optional[str] = None,
    on_chunk_progress: Optional[ProgressCallback] = None,
) -> FileTranscriptResult:
    """Resolve transcript text from uploaded audio/text/video-caption files."""

    raw_bytes = temp_path.read_bytes()
    preview = _decode_text_bytes(raw_bytes[:8000]) if raw_bytes else ""

    # If the caller explicitly set source_type (not "auto"), use it directly
    if source_type_override and source_type_override.strip():
        file_kind = source_type_override.strip()
    else:
        file_kind = detect_file_kind(filename, content_type=content_type, text_preview=preview)
    metadata: Dict[str, Any] = {"file_kind": file_kind}

    if file_kind == "audio":
        settings = stt_settings or {}
        provider = _coerce_str(provider_override or settings.get("provider") or "whisper").lower()
        provider_http_urls = settings.get("provider_http_urls")
        provider_url_map = provider_http_urls if isinstance(provider_http_urls, dict) else {}
        http_url = _coerce_str(provider_url_map.get(provider) or settings.get("http_url"))
        timeout = float(settings.get("http_timeout_seconds", 120.0) or 120.0)
        transcript_text = await transcribe_audio_chunked(
            temp_path,
            http_url=http_url,
            model=_coerce_str(settings.get("http_model")),
            language=_coerce_str(settings.get("http_language")),
            timeout_seconds=timeout,
            on_chunk_progress=on_chunk_progress,
        )
        metadata.update({"provider": provider, "http_url": http_url})
        return FileTranscriptResult(
            transcript_text=parse_plain_text(transcript_text),
            source_type="audio",
            metadata=metadata,
        )

    if file_kind == "vtt":
        transcript_text = parse_vtt_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(transcript_text=transcript_text, source_type="vtt", metadata=metadata)

    if file_kind == "srt":
        transcript_text = parse_srt_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(transcript_text=transcript_text, source_type="srt", metadata=metadata)

    if file_kind == "google_meet":
        if temp_path.suffix.lower() == ".pdf":
            transcript_text = parse_google_meet_file(temp_path)
            metadata["file_kind"] = "google_meet_pdf"
        else:
            transcript_text = parse_google_meet_text(_decode_text_bytes(raw_bytes))
            metadata["file_kind"] = "google_meet_text"
        return FileTranscriptResult(
            transcript_text=parse_plain_text(transcript_text),
            source_type="google_meet",
            metadata=metadata,
        )

    if file_kind == "text":
        transcript_text = parse_plain_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(transcript_text=transcript_text, source_type="text", metadata=metadata)

    supported: Sequence[str] = (
        sorted(AUDIO_EXTENSIONS)
        + sorted(TEXT_EXTENSIONS)
        + sorted(VTT_EXTENSIONS)
        + sorted(SRT_EXTENSIONS)
        + sorted(GOOGLE_MEET_EXTENSIONS)
    )
    raise ValueError(
        f"Unsupported file type for '{filename}'. Supported extensions: {', '.join(supported)}"
    )

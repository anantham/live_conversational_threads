"""File transcription and parsing helpers for bulk upload workflows."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

import httpx
from pydub import AudioSegment

from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.stt_http_transcriber import extract_diarized_segments, extract_transcript_text

logger = logging.getLogger("lct_backend")

def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[STT CHUNK] Invalid %s=%r, using default=%d",
            name,
            raw,
            default,
        )
        return default
    bounded = max(minimum, min(maximum, value))
    if bounded != value:
        logger.warning(
            "[STT CHUNK] Clamped %s=%d to %d (allowed %d-%d)",
            name,
            value,
            bounded,
            minimum,
            maximum,
        )
    return bounded


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[STT CHUNK] Invalid %s=%r, using default=%.2f",
            name,
            raw,
            default,
        )
        return default


# Conservative chunked audio transcription defaults for GPU stability.
DEFAULT_CHUNK_DURATION_S = _bounded_env_int("STT_CHUNK_DURATION_S", default=30, minimum=20, maximum=30)
DEFAULT_CHUNK_OVERLAP_S = _bounded_env_int("STT_CHUNK_OVERLAP_S", default=1, minimum=0, maximum=3)
DEFAULT_CHUNK_MAX_RETRIES = _bounded_env_int("STT_CHUNK_MAX_RETRIES", default=2, minimum=0, maximum=6)
DEFAULT_CHUNK_RETRY_BACKOFF_S = max(0.0, _env_float("STT_CHUNK_RETRY_BACKOFF_S", default=1.5))
STT_PARAKEET_PYANNOTE_ENABLED = (
    os.getenv("STT_PARAKEET_PYANNOTE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
)
STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT = (
    str(os.getenv("STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT", "verbose_json")).strip().lower() or "verbose_json"
)
STT_PYANNOTE_MODEL = (
    str(os.getenv("STT_PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1")).strip()
    or "pyannote/speaker-diarization-3.1"
)
STT_PYANNOTE_DEVICE = str(os.getenv("STT_PYANNOTE_DEVICE", "cpu")).strip().lower() or "cpu"
STT_PYANNOTE_MIN_SPEAKERS = str(os.getenv("STT_PYANNOTE_MIN_SPEAKERS", "")).strip()
STT_PYANNOTE_MAX_SPEAKERS = str(os.getenv("STT_PYANNOTE_MAX_SPEAKERS", "")).strip()

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


@dataclass
class AudioTranscriptionDetail:
    """Detailed STT result with optional timestamped segments."""

    transcript_text: str
    asr_segments: List[Dict[str, Any]]
    diarized_segments: Optional[List[Dict[str, Any]]]
    raw_payload: Any


def _coerce_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def _coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_optional_int(value: Any) -> Optional[int]:
    raw = _coerce_str(value)
    if not raw:
        return None
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 1 else None


def _extract_asr_segments(payload: Any) -> List[Dict[str, Any]]:
    """Extract ASR timestamp segments from provider payload."""
    if not isinstance(payload, dict):
        return []

    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list):
        raw_segments = payload.get("timestamps")
    if not isinstance(raw_segments, list):
        return []

    segments: List[Dict[str, Any]] = []
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        start = _coerce_float(item.get("start"))
        end = _coerce_float(item.get("end"))
        text = _coerce_str(item.get("text") or item.get("segment") or item.get("word"))
        if start is None or end is None or end <= start or not text:
            continue
        segments.append(
            {
                "start": start,
                "end": end,
                "text": text,
            }
        )
    return segments


def _format_speaker_transcript(segments: Sequence[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for seg in segments:
        speaker = _coerce_str(seg.get("speaker")) or "SPEAKER_00"
        text = _coerce_str(seg.get("text"))
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines).strip()


def _speaker_overlap_seconds(
    asr_start: float,
    asr_end: float,
    speaker_start: float,
    speaker_end: float,
) -> float:
    return max(0.0, min(asr_end, speaker_end) - max(asr_start, speaker_start))


def _align_asr_segments_to_speakers(
    asr_segments: Sequence[Dict[str, Any]],
    speaker_segments: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Assign each ASR segment to the speaker segment with max overlap."""
    if not asr_segments:
        return []

    normalized_speaker_segments: List[Dict[str, Any]] = []
    for seg in speaker_segments:
        if not isinstance(seg, dict):
            continue
        start = _coerce_float(seg.get("start"))
        end = _coerce_float(seg.get("end"))
        speaker = _coerce_str(seg.get("speaker"))
        if start is None or end is None or end <= start or not speaker:
            continue
        normalized_speaker_segments.append(
            {
                "speaker": speaker,
                "start": start,
                "end": end,
            }
        )

    assigned: List[Dict[str, Any]] = []
    for asr in asr_segments:
        asr_start = _coerce_float(asr.get("start"))
        asr_end = _coerce_float(asr.get("end"))
        text = _coerce_str(asr.get("text"))
        if asr_start is None or asr_end is None or asr_end <= asr_start or not text:
            continue

        best_speaker = "SPEAKER_00"
        best_overlap = 0.0
        for diar in normalized_speaker_segments:
            overlap = _speaker_overlap_seconds(
                asr_start,
                asr_end,
                diar["start"],
                diar["end"],
            )
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = diar["speaker"]

        assigned.append(
            {
                "speaker": best_speaker,
                "start": asr_start,
                "end": asr_end,
                "text": text,
            }
        )

    # Merge adjacent segments from same speaker to keep transcript compact.
    merged: List[Dict[str, Any]] = []
    for seg in assigned:
        if (
            merged
            and merged[-1]["speaker"] == seg["speaker"]
            and float(seg["start"]) - float(merged[-1]["end"]) <= 0.35
        ):
            merged[-1]["text"] = f"{merged[-1]['text']} {seg['text']}".strip()
            merged[-1]["end"] = max(float(merged[-1]["end"]), float(seg["end"]))
            continue
        merged.append(dict(seg))
    return merged


_PYANNOTE_PIPELINE: Any = None
_PYANNOTE_PIPELINE_DEVICE: str = ""
_PYANNOTE_PIPELINE_MODEL: str = ""


def _resolve_pyannote_device(torch_module: Any) -> str:
    requested = STT_PYANNOTE_DEVICE
    if requested in {"", "auto"}:
        if getattr(torch_module.backends, "mps", None) and torch_module.backends.mps.is_available():
            return "mps"
        if torch_module.cuda.is_available():
            return "cuda"
        return "cpu"
    return requested


def _load_pyannote_pipeline():
    """Load and cache pyannote pipeline once per process."""
    global _PYANNOTE_PIPELINE, _PYANNOTE_PIPELINE_DEVICE, _PYANNOTE_PIPELINE_MODEL

    hf_token = _coerce_str(os.getenv("STT_PYANNOTE_HF_TOKEN") or os.getenv("HF_TOKEN"))
    if not hf_token:
        raise RuntimeError("Missing HF token for pyannote (set STT_PYANNOTE_HF_TOKEN or HF_TOKEN).")

    if (
        _PYANNOTE_PIPELINE is not None
        and _PYANNOTE_PIPELINE_DEVICE == STT_PYANNOTE_DEVICE
        and _PYANNOTE_PIPELINE_MODEL == STT_PYANNOTE_MODEL
    ):
        return _PYANNOTE_PIPELINE

    import torch
    from pyannote.audio import Pipeline

    try:
        pipeline = Pipeline.from_pretrained(
            STT_PYANNOTE_MODEL,
            use_auth_token=hf_token,
        )
    except TypeError as exc:
        message = str(exc)
        if "use_auth_token" in message:
            raise RuntimeError(
                "pyannote/huggingface_hub version mismatch: install huggingface_hub<1.0 "
                "for pyannote.audio 3.x compatibility."
            ) from exc
        raise
    resolved_device = _resolve_pyannote_device(torch)
    if resolved_device != "cpu":
        try:
            pipeline.to(torch.device(resolved_device))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[PYANNOTE] Failed to move pipeline to %s: %s. Falling back to CPU.", resolved_device, exc)
            resolved_device = "cpu"

    _PYANNOTE_PIPELINE = pipeline
    _PYANNOTE_PIPELINE_DEVICE = STT_PYANNOTE_DEVICE
    _PYANNOTE_PIPELINE_MODEL = STT_PYANNOTE_MODEL
    logger.info(
        "[PYANNOTE] Loaded model=%s requested_device=%s resolved_device=%s",
        STT_PYANNOTE_MODEL,
        STT_PYANNOTE_DEVICE,
        resolved_device,
    )
    return _PYANNOTE_PIPELINE


def _run_pyannote_diarization(audio_path: Path) -> List[Dict[str, Any]]:
    pipeline = _load_pyannote_pipeline()
    min_speakers = _coerce_optional_int(STT_PYANNOTE_MIN_SPEAKERS)
    max_speakers = _coerce_optional_int(STT_PYANNOTE_MAX_SPEAKERS)

    kwargs: Dict[str, Any] = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    try:
        diarization = pipeline(str(audio_path), **kwargs)
    except Exception as exc:  # noqa: BLE001
        message = str(exc) or type(exc).__name__
        if "Expected size" in message and "tensor" in message:
            raise RuntimeError(
                "pyannote diarization failed on this compressed source; convert to 16kHz mono WAV and retry."
            ) from exc
        raise
    speaker_segments: List[Dict[str, Any]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = float(turn.start)
        end = float(turn.end)
        if end <= start:
            continue
        speaker_segments.append(
            {
                "speaker": _coerce_str(speaker) or "SPEAKER_00",
                "start": start,
                "end": end,
            }
        )
    speaker_segments.sort(key=lambda seg: (float(seg["start"]), float(seg["end"])))
    return speaker_segments


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


async def transcribe_audio_file_detailed(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    response_format: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> AudioTranscriptionDetail:
    """Transcribe an audio file via HTTP STT provider and keep optional segments."""

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
    if _coerce_str(response_format):
        form_data["response_format"] = _coerce_str(response_format)
    # Providers that support timestamps should include them in structured responses.
    form_data.setdefault("include_timestamps", "true")

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
    diarized_segments = extract_diarized_segments(parsed_payload)
    asr_segments = _extract_asr_segments(parsed_payload)
    if diarized_segments:
        transcript = _format_speaker_transcript(diarized_segments)
    else:
        transcript = extract_transcript_text(parsed_payload).strip()
        if not transcript and asr_segments:
            transcript = "\n".join(seg["text"] for seg in asr_segments if _coerce_str(seg.get("text"))).strip()
    if not transcript:
        raise RuntimeError("STT provider returned empty transcript.")
    return AudioTranscriptionDetail(
        transcript_text=transcript,
        asr_segments=asr_segments,
        diarized_segments=diarized_segments,
        raw_payload=parsed_payload,
    )


async def transcribe_audio_file(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    response_format: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file via HTTP STT provider."""
    detail = await transcribe_audio_file_detailed(
        file_path,
        http_url=http_url,
        model=model,
        language=language,
        timeout_seconds=timeout_seconds,
        response_format=response_format,
        transport=transport,
    )
    return detail.transcript_text


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


def _is_retryable_stt_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.RequestError):
        return True

    if isinstance(exc, RuntimeError):
        message = str(exc).lower()
        if not message:
            return False
        if "stt provider request failed (" in message:
            status_match = re.search(r"stt provider request failed \((\d{3})\)", message)
            if status_match:
                code = int(status_match.group(1))
                return code in {429, 500, 502, 503, 504}
        retryable_markers = (
            "timed out",
            "timeout",
            "connection reset",
            "readerror",
            "temporarily unavailable",
            "cuda",
            "unknown error",
        )
        return any(marker in message for marker in retryable_markers)

    return False


async def transcribe_audio_chunked(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    chunk_duration_s: int = DEFAULT_CHUNK_DURATION_S,
    overlap_s: int = DEFAULT_CHUNK_OVERLAP_S,
    chunk_max_retries: int = DEFAULT_CHUNK_MAX_RETRIES,
    chunk_retry_backoff_s: float = DEFAULT_CHUNK_RETRY_BACKOFF_S,
    on_chunk_progress: Optional[ProgressCallback] = None,
    response_format: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file by splitting into chunks and sending each to STT.

    Falls back to single-shot transcription for short files (< 2 chunks).
    """
    max_retries = max(0, int(chunk_max_retries))
    backoff_base_s = max(0.0, float(chunk_retry_backoff_s))
    chunks = _split_audio_to_chunks(file_path, chunk_duration_s, overlap_s)

    if len(chunks) <= 1:
        # Short file — no need to chunk, clean up and send directly
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)
        return await transcribe_audio_file(
            file_path, http_url=http_url, model=model,
            language=language, timeout_seconds=timeout_seconds,
            response_format=response_format,
            transport=transport,
        )

    transcripts: List[str] = []
    total = len(chunks)
    try:
        # Keep chunk transcription sequential to avoid GPU contention.
        for idx, (chunk_path, start_ms, end_ms) in enumerate(chunks):
            logger.info(
                "[CHUNK] Transcribing chunk %d/%d (%d–%d ms) via %s",
                idx + 1, total, start_ms, end_ms, http_url,
            )
            attempts_allowed = max_retries + 1
            text = ""
            for attempt in range(1, attempts_allowed + 1):
                try:
                    text = await transcribe_audio_file(
                        chunk_path, http_url=http_url, model=model,
                        language=language, timeout_seconds=timeout_seconds,
                        response_format=response_format,
                        transport=transport,
                    )
                    if attempt > 1:
                        logger.info(
                            "[CHUNK] Chunk %d/%d recovered on attempt %d/%d",
                            idx + 1,
                            total,
                            attempt,
                            attempts_allowed,
                        )
                    break
                except Exception as exc:  # noqa: BLE001
                    retryable = _is_retryable_stt_error(exc)
                    if attempt >= attempts_allowed or not retryable:
                        raise
                    backoff_s = backoff_base_s * (2 ** (attempt - 1))
                    logger.warning(
                        "[CHUNK] Chunk %d/%d attempt %d/%d failed (%s: %s), retrying in %.2fs",
                        idx + 1,
                        total,
                        attempt,
                        attempts_allowed,
                        type(exc).__name__,
                        str(exc) or type(exc).__name__,
                        backoff_s,
                    )
                    if backoff_s > 0:
                        await asyncio.sleep(backoff_s)
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
        timings_ms: Dict[str, int] = {}
        response_format = _coerce_str(settings.get("response_format"))
        transcript_text = ""
        source_diarized_segments: Optional[List[Dict[str, Any]]] = None

        if provider == "parakeet" and STT_PARAKEET_PYANNOTE_ENABLED:
            stt_started_at = time.perf_counter()
            detail = await transcribe_audio_file_detailed(
                temp_path,
                http_url=http_url,
                model=_coerce_str(settings.get("http_model")),
                language=_coerce_str(settings.get("http_language")),
                timeout_seconds=timeout,
                response_format=response_format or STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT,
            )
            timings_ms["stt_ms"] = _elapsed_ms(stt_started_at)
            transcript_text = detail.transcript_text
            source_diarized_segments = detail.diarized_segments

            if detail.diarized_segments:
                metadata["diarization_source"] = "stt_provider"
                transcript_text = _format_speaker_transcript(detail.diarized_segments)
                metadata["speaker_count"] = len(
                    {seg.get("speaker") for seg in detail.diarized_segments if _coerce_str(seg.get("speaker"))}
                )
            elif detail.asr_segments:
                diarization_started_at = time.perf_counter()
                try:
                    speaker_segments = await asyncio.to_thread(_run_pyannote_diarization, temp_path)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[STT+PYANNOTE] Separate diarization failed: %s", exc)
                    metadata["diarization_error"] = str(exc) or type(exc).__name__
                else:
                    timings_ms["diarization_ms"] = _elapsed_ms(diarization_started_at)
                    align_started_at = time.perf_counter()
                    aligned_segments = _align_asr_segments_to_speakers(detail.asr_segments, speaker_segments)
                    timings_ms["alignment_ms"] = _elapsed_ms(align_started_at)
                    if aligned_segments:
                        transcript_text = _format_speaker_transcript(aligned_segments)
                        metadata["diarization_source"] = "pyannote_sidecar"
                        metadata["speaker_count"] = len(
                            {seg.get("speaker") for seg in aligned_segments if _coerce_str(seg.get("speaker"))}
                        )
                    metadata["pyannote_segment_count"] = len(speaker_segments)
                metadata["asr_segment_count"] = len(detail.asr_segments)
            else:
                metadata["diarization_skipped"] = "no_asr_timestamps_from_stt"
        else:
            stt_started_at = time.perf_counter()
            transcript_text = await transcribe_audio_chunked(
                temp_path,
                http_url=http_url,
                model=_coerce_str(settings.get("http_model")),
                language=_coerce_str(settings.get("http_language")),
                timeout_seconds=timeout,
                on_chunk_progress=on_chunk_progress,
                response_format=response_format,
            )
            timings_ms["stt_ms"] = _elapsed_ms(stt_started_at)

        if source_diarized_segments is not None:
            metadata["stt_diarized_segment_count"] = len(source_diarized_segments)
        if timings_ms:
            metadata["timings_ms"] = timings_ms
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

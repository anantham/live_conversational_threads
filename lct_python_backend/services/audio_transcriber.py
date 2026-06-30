"""Core audio transcription: HTTP STT calls, chunked splitting, segmented pipeline."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import tempfile
import time
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from pydub import AudioSegment
from pydub.silence import detect_silence

from lct_python_backend.services.stt.stt_http_transcriber import (
    extract_diarized_segments,
    extract_transcript_text,
)
from lct_python_backend.services.coercion_helpers import coerce_float, coerce_str
from lct_python_backend.services.retry_policy import retry_async_with_backoff
from lct_python_backend.services.transcript.transcription_utils import (
    DEFAULT_CHUNK_DURATION_S,
    DEFAULT_CHUNK_MAX_RETRIES,
    DEFAULT_CHUNK_OVERLAP_S,
    DEFAULT_CHUNK_RETRY_BACKOFF_S,
    DEFAULT_MAX_SEGMENT_MS,
    DEFAULT_MIN_SEGMENT_MS,
    DEFAULT_MIN_SILENCE_MS,
    DEFAULT_SILENCE_THRESH_DB,
    AudioTranscriptionDetail,
    ProgressCallback,
    SegmentResult,
    SegmentStartedCallback,
    _elapsed_ms,
    _last_stt_backend,
)
from lct_python_backend.services.speaker_alignment import _format_speaker_transcript

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Payload parsing
# ---------------------------------------------------------------------------

def _extract_asr_segments(payload: Any) -> List[Dict[str, Any]]:
    """Extract ASR timestamp segments from a provider payload dict."""
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
        start = coerce_float(item.get("start"))
        end = coerce_float(item.get("end"))
        text = coerce_str(item.get("text") or item.get("segment") or item.get("word"))
        if start is None or end is None or end <= start or not text:
            continue
        segments.append({"start": start, "end": end, "text": text})
    return segments


# ---------------------------------------------------------------------------
# Single-file HTTP transcription
# ---------------------------------------------------------------------------

async def transcribe_audio_file_detailed(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    response_format: str = "",
    initial_prompt: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> AudioTranscriptionDetail:
    """Transcribe an audio file via HTTP STT provider and return full detail."""
    target_url = coerce_str(http_url)
    if not target_url:
        raise ValueError("STT HTTP URL is required for audio transcription.")

    payload_bytes = file_path.read_bytes()
    if not payload_bytes:
        raise ValueError("Uploaded audio file is empty.")

    guessed_content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    form_data: Dict[str, str] = {}
    if coerce_str(model):
        form_data["model"] = coerce_str(model)
    if coerce_str(language):
        form_data["language"] = coerce_str(language)
    if coerce_str(response_format):
        form_data["response_format"] = coerce_str(response_format)
    if coerce_str(initial_prompt):
        form_data["initial_prompt"] = coerce_str(initial_prompt)
    form_data.setdefault("include_timestamps", "true")

    files = {"file": (file_path.name, payload_bytes, guessed_content_type)}
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

    content_type = coerce_str(response.headers.get("content-type")).lower()
    parsed_payload: Any
    if "application/json" in content_type:
        parsed_payload = response.json()
    else:
        raw_text = response.text.strip()
        try:
            parsed_payload = json.loads(raw_text)
        except json.JSONDecodeError:
            parsed_payload = {"text": raw_text}

    diarized_segments = extract_diarized_segments(parsed_payload)
    asr_segments = _extract_asr_segments(parsed_payload)
    if diarized_segments:
        transcript = _format_speaker_transcript(diarized_segments)
    else:
        transcript = extract_transcript_text(parsed_payload).strip()
        if not transcript and asr_segments:
            transcript = "\n".join(
                seg["text"] for seg in asr_segments if coerce_str(seg.get("text"))
            ).strip()
    if not transcript:
        raise RuntimeError("STT provider returned empty transcript.")

    backend = parsed_payload.get("_backend", "") if isinstance(parsed_payload, dict) else ""
    if not backend:
        if "modal" in target_url.lower():
            backend = "modal_whisperx"
        elif "127.0.0.1" in target_url or "localhost" in target_url:
            backend = "local_whisperx"
    _last_stt_backend.set(backend)
    return AudioTranscriptionDetail(
        transcript_text=transcript,
        asr_segments=asr_segments,
        diarized_segments=diarized_segments,
        raw_payload=parsed_payload,
        backend=backend,
    )


async def transcribe_audio_file(
    file_path: Path,
    *,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = 120.0,
    response_format: str = "",
    initial_prompt: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file via HTTP STT provider; return transcript text only."""
    detail = await transcribe_audio_file_detailed(
        file_path,
        http_url=http_url,
        model=model,
        language=language,
        timeout_seconds=timeout_seconds,
        response_format=response_format,
        initial_prompt=initial_prompt,
        transport=transport,
    )
    return detail.transcript_text


# ---------------------------------------------------------------------------
# Audio chunking
# ---------------------------------------------------------------------------

def _split_audio_to_chunks(
    file_path: Path,
    chunk_duration_s: int = DEFAULT_CHUNK_DURATION_S,
    overlap_s: int = DEFAULT_CHUNK_OVERLAP_S,
) -> List[tuple[Path, int, int]]:
    """Split an audio file into overlapping WAV chunks on disk.

    Returns a list of (chunk_path, start_ms, end_ms) tuples.
    Caller is responsible for cleaning up the temp files.
    """
    audio = AudioSegment.from_file(str(file_path))
    duration_ms = len(audio)
    chunk_ms = chunk_duration_s * 1000
    overlap_ms = overlap_s * 1000
    step_ms = max(1000, chunk_ms - overlap_ms)

    chunks: List[tuple[Path, int, int]] = []
    start = 0
    while start < duration_ms:
        end = min(start + chunk_ms, duration_ms)
        segment = audio[start:end]

        tmp = tempfile.NamedTemporaryFile(suffix=".wav", prefix="stt_chunk_", delete=False)
        segment.export(tmp.name, format="wav")
        tmp.close()
        chunks.append((Path(tmp.name), start, end))

        if end >= duration_ms:
            break
        start += step_ms

    logger.info(
        "[CHUNK] Split %s (%d ms) into %d chunks of ~%d s with %d s overlap",
        file_path.name,
        duration_ms,
        len(chunks),
        chunk_duration_s,
        overlap_s,
    )
    return chunks


# ---------------------------------------------------------------------------
# Segment boundary detection
# ---------------------------------------------------------------------------

def detect_segment_boundaries(
    audio_path: Path,
    *,
    min_segment_ms: int = DEFAULT_MIN_SEGMENT_MS,
    max_segment_ms: int = DEFAULT_MAX_SEGMENT_MS,
    silence_thresh_db: int = DEFAULT_SILENCE_THRESH_DB,
    min_silence_ms: int = DEFAULT_MIN_SILENCE_MS,
) -> List[int]:
    """Detect natural break points in audio based on silences.

    Instead of fixed-duration segments, finds natural conversation pauses
    (2-3 second silences) to create segment boundaries. This ensures we never
    cut off during high-energy continuous speech.

    Returns:
        List of millisecond timestamps marking segment boundaries (starts with 0).
    """
    audio = AudioSegment.from_file(str(audio_path))
    duration_ms = len(audio)

    if duration_ms <= min_segment_ms:
        logger.info(
            "[SEGMENT] Audio too short for segmentation (%d ms <= %d ms min), single segment",
            duration_ms,
            min_segment_ms,
        )
        return [0, duration_ms]

    silences = detect_silence(audio, min_silence_len=min_silence_ms, silence_thresh=silence_thresh_db)
    logger.info(
        "[SEGMENT] Found %d silence regions (>=%d ms, <%d dB) in %d ms audio",
        len(silences),
        min_silence_ms,
        silence_thresh_db,
        duration_ms,
    )

    boundaries = [0]
    last_boundary = 0

    for silence_start, silence_end in silences:
        time_since_last = silence_start - last_boundary
        if time_since_last < min_segment_ms:
            continue
        boundary = (silence_start + silence_end) // 2
        boundaries.append(boundary)
        last_boundary = boundary
        logger.debug(
            "[SEGMENT] Boundary at %d ms (silence %d-%d ms, %.1f min since last)",
            boundary,
            silence_start,
            silence_end,
            time_since_last / 60000,
        )

    # Force boundaries at max_segment intervals when no natural break was found
    forced_boundaries: List[int] = [0]
    for next_boundary in boundaries[1:] + [duration_ms]:
        while next_boundary - forced_boundaries[-1] > max_segment_ms:
            forced_point = forced_boundaries[-1] + max_segment_ms
            best_silence_midpoint = forced_point
            for silence_start, silence_end in silences:
                midpoint = (silence_start + silence_end) // 2
                if forced_point - 30000 <= midpoint <= forced_point + 30000:
                    best_silence_midpoint = midpoint
                    break
            forced_boundaries.append(best_silence_midpoint)
            logger.info("[SEGMENT] Forced boundary at %d ms (max segment reached)", best_silence_midpoint)
        if next_boundary not in forced_boundaries:
            forced_boundaries.append(next_boundary)

    if forced_boundaries[-1] != duration_ms:
        remaining = duration_ms - forced_boundaries[-1]
        if remaining < min_segment_ms // 2:
            forced_boundaries[-1] = duration_ms
        else:
            forced_boundaries.append(duration_ms)

    segment_count = len(forced_boundaries) - 1
    avg_segment_ms = duration_ms / segment_count if segment_count > 0 else duration_ms
    logger.info(
        "[SEGMENT] Created %d segments from %d ms audio (avg %.1f min each)",
        segment_count,
        duration_ms,
        avg_segment_ms / 60000,
    )
    return forced_boundaries


def extract_audio_segment(audio_path: Path, start_ms: int, end_ms: int) -> Path:
    """Extract a segment of audio to a temporary WAV file.

    Returns the path to the temp file. Caller is responsible for cleanup.
    """
    audio = AudioSegment.from_file(str(audio_path))
    segment = audio[start_ms:end_ms]

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", prefix="stt_segment_", delete=False)
    segment.export(tmp.name, format="wav")
    tmp.close()

    logger.debug(
        "[SEGMENT] Extracted %d-%d ms (%d ms) to %s",
        start_ms,
        end_ms,
        end_ms - start_ms,
        tmp.name,
    )
    return Path(tmp.name)


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

def _is_empty_transcript_error(exc: Exception) -> bool:
    return isinstance(exc, RuntimeError) and "empty transcript" in str(exc).lower()


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
            "timed out", "timeout", "connection reset", "readerror",
            "temporarily unavailable", "cuda", "unknown error",
            # DNS / socket-layer transients — observed mid-import (e.g. Q.m4a
            # aborted at chunk 65/163 with [Errno 11001] getaddrinfo failed).
            "getaddrinfo", "gaierror", "name or service not known",
            "name resolution", "temporary failure in name resolution",
            "winerror 10054", "winerror 10060", "winerror 10061",
            "connection failed", "network error",
        )
        return any(marker in message for marker in retryable_markers)
    return False


# ---------------------------------------------------------------------------
# Chunked transcription
# ---------------------------------------------------------------------------

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
    initial_prompt: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> str:
    """Transcribe an audio file by splitting into chunks and sending each to STT.

    Falls back to single-shot transcription for short files (< 2 chunks).
    """
    max_retries = max(0, int(chunk_max_retries))
    backoff_base_s = max(0.0, float(chunk_retry_backoff_s))
    chunks = _split_audio_to_chunks(file_path, chunk_duration_s, overlap_s)

    if len(chunks) <= 1:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)
        return await transcribe_audio_file(
            file_path,
            http_url=http_url,
            model=model,
            language=language,
            timeout_seconds=timeout_seconds,
            response_format=response_format,
            initial_prompt=initial_prompt,
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
            attempts_allowed = max_retries + 1
            text = ""

            def _log_retry(attempt: int, exc: BaseException, delay: float, _i=idx, _max=attempts_allowed) -> None:
                logger.warning(
                    "[CHUNK] Chunk %d/%d attempt %d/%d failed (%s: %s), retrying in %.2fs",
                    _i + 1, total, attempt, _max,
                    type(exc).__name__, str(exc) or type(exc).__name__, delay,
                )

            try:
                text = await retry_async_with_backoff(
                    lambda cp=chunk_path: transcribe_audio_file(
                        cp,
                        http_url=http_url,
                        model=model,
                        language=language,
                        timeout_seconds=timeout_seconds,
                        response_format=response_format,
                        initial_prompt=initial_prompt,
                        transport=transport,
                    ),
                    max_attempts=attempts_allowed,
                    base_delay_s=backoff_base_s,
                    backoff_factor=2.0,
                    is_retryable=_is_retryable_stt_error,
                    on_retry=_log_retry,
                )
            except Exception as exc:
                if _is_empty_transcript_error(exc):
                    logger.warning(
                        "[CHUNK] Chunk %d/%d returned empty — skipping silent chunk",
                        idx + 1, total,
                    )
                    text = ""
                else:
                    raise
            transcripts.append(text)
            if on_chunk_progress:
                await on_chunk_progress(idx + 1, total, text)
    finally:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)

    return "\n".join(transcripts)


# ---------------------------------------------------------------------------
# Segmented (interleaved) transcription
# ---------------------------------------------------------------------------

async def transcribe_audio_segmented(
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
    min_segment_ms: int = DEFAULT_MIN_SEGMENT_MS,
    max_segment_ms: int = DEFAULT_MAX_SEGMENT_MS,
    silence_thresh_db: int = DEFAULT_SILENCE_THRESH_DB,
    min_silence_ms: int = DEFAULT_MIN_SILENCE_MS,
    on_segment_started: Optional[SegmentStartedCallback] = None,
    on_chunk_progress: Optional[ProgressCallback] = None,
    response_format: str = "",
    initial_prompt: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
    resume_from_segment: int = 0,
    resumed_segment_texts: Optional[list[str]] = None,
) -> AsyncGenerator[SegmentResult, None]:
    """Yield transcripts per natural segment instead of waiting for full file.

    Enables interleaved processing: each segment flows through the full pipeline
    (STT → LLM → nodes) before the next segment starts. Users see results
    progressively rather than waiting for the entire file.
    """
    boundaries = detect_segment_boundaries(
        file_path,
        min_segment_ms=min_segment_ms,
        max_segment_ms=max_segment_ms,
        silence_thresh_db=silence_thresh_db,
        min_silence_ms=min_silence_ms,
    )
    segment_count = len(boundaries) - 1

    if segment_count == 0:
        logger.warning("[SEGMENT] No segments detected for %s", file_path.name)
        return

    logger.info(
        "[SEGMENT] Starting segmented transcription: %d segments from %s",
        segment_count,
        file_path.name,
    )

    _resumed_texts = resumed_segment_texts or []

    for i in range(segment_count):
        start_ms, end_ms = boundaries[i], boundaries[i + 1]
        segment_index = i + 1

        # Skip segments already completed in a previous run (checkpoint resume)
        if segment_index <= resume_from_segment and segment_index <= len(_resumed_texts):
            cached_text = _resumed_texts[segment_index - 1] if _resumed_texts else ""
            logger.info(
                "[SEGMENT %d/%d] Skipped (checkpoint resume), cached %d chars",
                segment_index, segment_count, len(cached_text),
            )
            yield SegmentResult(
                segment_index=segment_index,
                segment_total=segment_count,
                start_ms=start_ms,
                end_ms=end_ms,
                transcript_text=cached_text,
                elapsed_ms=0,
                metadata={"stt_backend": "", "duration_ms": end_ms - start_ms, "resumed": True},
            )
            continue

        logger.info(
            "[SEGMENT %d/%d] Processing %d-%d ms (%.1f min)",
            segment_index, segment_count, start_ms, end_ms, (end_ms - start_ms) / 60000,
        )

        if on_segment_started:
            await on_segment_started(segment_index, segment_count, start_ms, end_ms)

        segment_audio_path = extract_audio_segment(file_path, start_ms, end_ms)
        segment_started_at = time.perf_counter()

        try:
            transcript_text = await transcribe_audio_chunked(
                segment_audio_path,
                http_url=http_url,
                model=model,
                language=language,
                timeout_seconds=timeout_seconds,
                chunk_duration_s=chunk_duration_s,
                overlap_s=overlap_s,
                chunk_max_retries=chunk_max_retries,
                chunk_retry_backoff_s=chunk_retry_backoff_s,
                on_chunk_progress=on_chunk_progress,
                response_format=response_format,
                initial_prompt=initial_prompt,
                transport=transport,
            )

            elapsed = _elapsed_ms(segment_started_at)
            stt_backend = _last_stt_backend.get("")

            logger.info(
                "[SEGMENT %d/%d] Completed in %d ms, %d chars",
                segment_index, segment_count, elapsed, len(transcript_text),
            )

            yield SegmentResult(
                segment_index=segment_index,
                segment_total=segment_count,
                start_ms=start_ms,
                end_ms=end_ms,
                transcript_text=transcript_text,
                elapsed_ms=elapsed,
                metadata={"stt_backend": stt_backend, "duration_ms": end_ms - start_ms},
            )
        finally:
            segment_audio_path.unlink(missing_ok=True)

    logger.info("[SEGMENT] Completed all %d segments for %s", segment_count, file_path.name)

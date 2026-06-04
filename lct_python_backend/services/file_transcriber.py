"""File transcription orchestrator for bulk upload workflows.

This module is the public façade.  All external callers import from here;
the actual implementation lives in the domain-specific submodules:

    transcription_utils  — constants, dataclasses, coercion helpers
    text_parsers         — file-kind detection, VTT/SRT/text/Google Meet parsing
    speaker_alignment    — pyannote diarization + ASR-to-speaker alignment
    provider_selection   — STT provider candidate resolution
    audio_transcriber    — HTTP STT calls, chunked + segmented transcription
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from lct_python_backend.services.audio_transcriber import (
    _extract_asr_segments,
    _is_empty_transcript_error,
    _is_retryable_stt_error,
    _split_audio_to_chunks,
    detect_segment_boundaries,
    extract_audio_segment,
    transcribe_audio_chunked,
    transcribe_audio_file,
    transcribe_audio_file_detailed,
    transcribe_audio_segmented,
)
from lct_python_backend.services.provider_selection import (
    _is_local_http_url,
    _resolve_audio_provider_candidates,
    resolve_import_audio_candidates,
)
from lct_python_backend.services.speaker_alignment import (
    _align_asr_segments_to_speakers,
    _format_speaker_transcript,
    _load_pyannote_pipeline,
    _run_pyannote_diarization,
)
from lct_python_backend.services.transcript_linearization import (
    build_line_utterances,
    build_segment_utterances,
    offset_segments,
)
from lct_python_backend.services.stt_http_transcriber import transcribe_wav_stt_candidate
from lct_python_backend.services.text_parsers import (
    _decode_text_bytes,
    _strip_markup,
    chunk_transcript_lines,
    detect_file_kind,
    looks_like_google_meet_text,
    parse_google_meet_file,
    parse_google_meet_text,
    parse_plain_text,
    parse_srt_text,
    parse_vtt_text,
)
from lct_python_backend.services.coercion_helpers import (
    coerce_float,
    coerce_int,
    coerce_str,
    to_bool,
)
from lct_python_backend.services.transcription_utils import (
    AUDIO_EXTENSIONS,
    DEFAULT_CHUNK_DURATION_S,
    LOCAL_STT_CHUNK_DURATION_S,
    DEFAULT_CHUNK_MAX_RETRIES,
    DEFAULT_CHUNK_OVERLAP_S,
    DEFAULT_CHUNK_RETRY_BACKOFF_S,
    DEFAULT_MAX_SEGMENT_MS,
    DEFAULT_MIN_SEGMENT_MS,
    DEFAULT_MIN_SILENCE_MS,
    DEFAULT_SILENCE_THRESH_DB,
    GOOGLE_MEET_EXTENSIONS,
    SRT_EXTENSIONS,
    STT_PARAKEET_PYANNOTE_ENABLED,
    STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT,
    STT_PROVIDER_ORDER,
    STT_PYANNOTE_DEVICE,
    STT_PYANNOTE_MAX_SPEAKERS,
    STT_PYANNOTE_MIN_SPEAKERS,
    STT_PYANNOTE_MODEL,
    STT_UPLOAD_LOCAL_FIRST,
    STT_UPLOAD_REMOTE_FALLBACK,
    TEXT_EXTENSIONS,
    VTT_EXTENSIONS,
    AudioTranscriptionDetail,
    FileTranscriptResult,
    ProgressCallback,
    ProviderFallbackCallback,
    SegmentResult,
    SegmentStartedCallback,
    _coerce_optional_int,
    _elapsed_ms,
    _last_stt_backend,
)

# Re-export __all__ so `from file_transcriber import *` still works
__all__ = [
    # transcription_utils
    "AUDIO_EXTENSIONS",
    "TEXT_EXTENSIONS",
    "VTT_EXTENSIONS",
    "SRT_EXTENSIONS",
    "GOOGLE_MEET_EXTENSIONS",
    "STT_PARAKEET_PYANNOTE_ENABLED",
    "STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT",
    "STT_PYANNOTE_MODEL",
    "STT_PYANNOTE_DEVICE",
    "STT_PYANNOTE_MIN_SPEAKERS",
    "STT_PYANNOTE_MAX_SPEAKERS",
    "STT_UPLOAD_LOCAL_FIRST",
    "STT_UPLOAD_REMOTE_FALLBACK",
    "STT_PROVIDER_ORDER",
    "DEFAULT_CHUNK_DURATION_S",
    "DEFAULT_CHUNK_OVERLAP_S",
    "DEFAULT_CHUNK_MAX_RETRIES",
    "DEFAULT_CHUNK_RETRY_BACKOFF_S",
    "DEFAULT_MIN_SEGMENT_MS",
    "DEFAULT_MAX_SEGMENT_MS",
    "DEFAULT_SILENCE_THRESH_DB",
    "DEFAULT_MIN_SILENCE_MS",
    "AudioTranscriptionDetail",
    "FileTranscriptResult",
    "SegmentResult",
    "ProgressCallback",
    "ProviderFallbackCallback",
    "SegmentStartedCallback",
    "_last_stt_backend",
    "coerce_str",
    "_elapsed_ms",
    "coerce_float",
    "coerce_int",
    "_coerce_optional_int",
    "to_bool",
    # text_parsers
    "looks_like_google_meet_text",
    "detect_file_kind",
    "_decode_text_bytes",
    "_strip_markup",
    "parse_plain_text",
    "parse_vtt_text",
    "parse_srt_text",
    "parse_google_meet_text",
    "parse_google_meet_file",
    "chunk_transcript_lines",
    # speaker_alignment
    "_format_speaker_transcript",
    "_align_asr_segments_to_speakers",
    "_load_pyannote_pipeline",
    "_run_pyannote_diarization",
    # provider_selection
    "_is_local_http_url",
    "_resolve_audio_provider_candidates",
    "resolve_import_audio_candidates",
    "build_line_utterances",
    "build_segment_utterances",
    # audio_transcriber
    "_extract_asr_segments",
    "_split_audio_to_chunks",
    "_is_empty_transcript_error",
    "_is_retryable_stt_error",
    "detect_segment_boundaries",
    "extract_audio_segment",
    "transcribe_audio_file_detailed",
    "transcribe_audio_file",
    "transcribe_audio_chunked",
    "transcribe_audio_segmented",
    # orchestrator (this module)
    "transcribe_uploaded_file",
]

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


async def _transcribe_cloud_chunk_with_retry(
    candidate: Dict[str, Any],
    *,
    wav_payload: bytes,
    timeout_seconds: float,
    language: str,
    chunk_idx: int,
    total_chunks: int,
    chunk_max_retries: int = DEFAULT_CHUNK_MAX_RETRIES,
    chunk_retry_backoff_s: float = DEFAULT_CHUNK_RETRY_BACKOFF_S,
) -> Dict[str, Any]:
    attempts_allowed = max(0, int(chunk_max_retries)) + 1
    backoff_base_s = max(0.0, float(chunk_retry_backoff_s))
    provider = coerce_str(candidate.get("provider")).lower() or "unknown"
    transport = coerce_str(candidate.get("transport")).lower() or "backend_http"
    last_error: Optional[Exception] = None

    for attempt in range(1, attempts_allowed + 1):
        try:
            chunk_result = await transcribe_wav_stt_candidate(
                candidate,
                wav_payload=wav_payload,
                timeout_seconds=timeout_seconds,
                language=language,
            )
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        else:
            if chunk_result.get("ok"):
                if attempt > 1:
                    logger.info(
                        "[UPLOAD STT] Cloud chunk %d/%d recovered on attempt %d/%d via %s (%s)",
                        chunk_idx,
                        total_chunks,
                        attempt,
                        attempts_allowed,
                        provider,
                        transport,
                    )
                return chunk_result
            last_error = RuntimeError(
                coerce_str(chunk_result.get("error")) or f"{provider} transcription failed."
            )

        retryable = isinstance(last_error, Exception) and _is_retryable_stt_error(last_error)
        if attempt >= attempts_allowed or not retryable:
            raise last_error or RuntimeError(f"{provider} transcription failed.")

        backoff_s = backoff_base_s * (2 ** (attempt - 1))
        logger.warning(
            "[UPLOAD STT] Cloud chunk %d/%d attempt %d/%d failed via %s (%s: %s), retrying in %.2fs",
            chunk_idx,
            total_chunks,
            attempt,
            attempts_allowed,
            provider,
            type(last_error).__name__,
            str(last_error) or type(last_error).__name__,
            backoff_s,
        )
        if backoff_s > 0:
            await asyncio.sleep(backoff_s)

    raise last_error or RuntimeError(f"{provider} transcription failed.")

async def transcribe_uploaded_file(
    *,
    temp_path: Path,
    filename: str,
    content_type: Optional[str],
    stt_settings: Optional[Dict[str, Any]] = None,
    provider_override: Optional[str] = None,
    source_type_override: Optional[str] = None,
    on_chunk_progress: Optional[ProgressCallback] = None,
    enable_parakeet_pyannote: Optional[bool] = None,
    on_provider_fallback: Optional[ProviderFallbackCallback] = None,
    resume_from_chunk: int = 0,
    resumed_chunk_texts: Optional[List[str]] = None,
) -> FileTranscriptResult:
    """Resolve transcript text from uploaded audio/text/video-caption files."""

    raw_bytes = temp_path.read_bytes()
    preview = _decode_text_bytes(raw_bytes[:8000]) if raw_bytes else ""

    if source_type_override and source_type_override.strip():
        file_kind = source_type_override.strip()
    else:
        file_kind = detect_file_kind(filename, content_type=content_type, text_preview=preview)
    metadata: Dict[str, Any] = {"file_kind": file_kind}

    if file_kind == "audio":
        settings = stt_settings or {}
        provider_candidates = resolve_import_audio_candidates(
            settings=settings,
            provider_override=provider_override,
        )
        if not provider_candidates:
            raise ValueError("No STT HTTP URL configured for upload transcription.")
        timeout = float(settings.get("http_timeout_seconds", 120.0) or 120.0)
        response_format = coerce_str(settings.get("response_format"))
        provider_attempts: List[Dict[str, Any]] = []
        transcript_text = ""
        source_diarized_segments: Optional[List[Dict[str, Any]]] = None
        source_asr_segments: Optional[List[Dict[str, Any]]] = None
        source_utterances: List[Dict[str, Any]] = []
        active_provider = ""
        active_http_url = ""
        active_transport = ""
        active_model = ""
        timings_ms: Dict[str, int] = {}
        stt_backend = ""
        fallback_used = False

        pyannote_enabled = (
            STT_PARAKEET_PYANNOTE_ENABLED
            if enable_parakeet_pyannote is None
            else bool(enable_parakeet_pyannote)
        )

        last_error: Optional[Exception] = None
        for attempt_idx, candidate in enumerate(provider_candidates):
            provider = coerce_str(candidate.get("provider")).lower() or "whisper"
            transport = coerce_str(candidate.get("transport")).lower() or "backend_http"
            http_url = coerce_str(candidate.get("http_url"))
            if not http_url:
                continue

            active_provider = provider
            active_http_url = http_url
            active_transport = transport
            active_model = coerce_str(candidate.get("model")) or coerce_str(settings.get("http_model"))
            attempt_record: Dict[str, Any] = {
                "provider": provider,
                "transport": transport,
                "http_url": http_url,
                "reason": coerce_str(candidate.get("reason")),
            }
            attempt_started_at = time.perf_counter()
            try:
                timings_ms = {}
                source_diarized_segments = None
                if transport in {"openai_audio", "openrouter_audio"}:
                    stt_started_at = time.perf_counter()
                    candidate_timeout = max(30.0, timeout)
                    chunks = _split_audio_to_chunks(
                        temp_path,
                        chunk_duration_s=DEFAULT_CHUNK_DURATION_S,
                        overlap_s=DEFAULT_CHUNK_OVERLAP_S,
                    )
                    chunk_texts: List[str] = []
                    all_segments: List[Dict[str, Any]] = []
                    _resumed_texts = resumed_chunk_texts or []
                    try:
                        for chunk_idx, (chunk_path, _start_ms, _end_ms) in enumerate(chunks, start=1):
                            # Skip chunks already transcribed in a previous run
                            if chunk_idx <= resume_from_chunk and chunk_idx <= len(_resumed_texts):
                                cached_text = _resumed_texts[chunk_idx - 1] if _resumed_texts else ""
                                if cached_text:
                                    chunk_texts.append(cached_text)
                                if on_chunk_progress is not None:
                                    # The pipeline already replays cached transcript text from the
                                    # checkpoint. This callback only needs to advance progress.
                                    await on_chunk_progress(chunk_idx, len(chunks), "")
                                chunk_path.unlink(missing_ok=True)
                                continue

                            wav_payload = chunk_path.read_bytes()
                            chunk_result = await _transcribe_cloud_chunk_with_retry(
                                candidate,
                                wav_payload=wav_payload,
                                language=coerce_str(settings.get("http_language")),
                                timeout_seconds=candidate_timeout,
                                chunk_idx=chunk_idx,
                                total_chunks=len(chunks),
                            )
                            chunk_segments = (
                                chunk_result.get("segments")
                                if isinstance(chunk_result.get("segments"), list)
                                else []
                            )
                            if chunk_segments:
                                all_segments.extend(
                                    offset_segments(
                                        chunk_segments,
                                        offset_seconds=max(0.0, float(_start_ms) / 1000.0),
                                    )
                                )
                            chunk_text = ""
                            if chunk_segments and bool(candidate.get("request_diarization", False)):
                                chunk_text = _format_speaker_transcript(
                                    offset_segments(
                                        chunk_segments,
                                        offset_seconds=max(0.0, float(_start_ms) / 1000.0),
                                    )
                                )
                            else:
                                chunk_text = coerce_str(chunk_result.get("text"))
                            if chunk_text:
                                chunk_texts.append(chunk_text)
                            if on_chunk_progress is not None:
                                await on_chunk_progress(chunk_idx, len(chunks), chunk_text)
                    finally:
                        for chunk_path, _, _ in chunks:
                            chunk_path.unlink(missing_ok=True)

                    transcript_text = "\n".join(part for part in chunk_texts if part).strip()
                    source_diarized_segments = all_segments or None
                    source_asr_segments = None
                    timings_ms["stt_ms"] = _elapsed_ms(stt_started_at)
                    if source_diarized_segments:
                        metadata["diarization_source"] = "stt_provider"
                        metadata["speaker_count"] = len(
                            {
                                coerce_str(seg.get("speaker"))
                                for seg in source_diarized_segments
                                if coerce_str(seg.get("speaker"))
                            }
                        )
                    stt_backend = transport
                elif provider == "parakeet" and pyannote_enabled:
                    stt_started_at = time.perf_counter()
                    detail = await transcribe_audio_file_detailed(
                        temp_path,
                        http_url=http_url,
                        model=coerce_str(settings.get("http_model")),
                        language=coerce_str(settings.get("http_language")),
                        timeout_seconds=timeout,
                        response_format=response_format or STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT,
                    )
                    stt_backend = detail.backend
                    timings_ms["stt_ms"] = _elapsed_ms(stt_started_at)
                    transcript_text = detail.transcript_text
                    source_diarized_segments = detail.diarized_segments
                    source_asr_segments = detail.asr_segments

                    if detail.diarized_segments:
                        metadata["diarization_source"] = "stt_provider"
                        transcript_text = _format_speaker_transcript(detail.diarized_segments)
                        metadata["speaker_count"] = len(
                            {
                                seg.get("speaker")
                                for seg in detail.diarized_segments
                                if coerce_str(seg.get("speaker"))
                            }
                        )
                    elif detail.asr_segments:
                        diarization_started_at = time.perf_counter()
                        try:
                            speaker_segments = await asyncio.to_thread(
                                _run_pyannote_diarization, temp_path
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("[STT+PYANNOTE] Separate diarization failed: %s", exc)
                            metadata["diarization_error"] = str(exc) or type(exc).__name__
                        else:
                            timings_ms["diarization_ms"] = _elapsed_ms(diarization_started_at)
                            align_started_at = time.perf_counter()
                            aligned_segments = _align_asr_segments_to_speakers(
                                detail.asr_segments, speaker_segments
                            )
                            timings_ms["alignment_ms"] = _elapsed_ms(align_started_at)
                            if aligned_segments:
                                transcript_text = _format_speaker_transcript(aligned_segments)
                                metadata["diarization_source"] = "pyannote_sidecar"
                                metadata["speaker_count"] = len(
                                    {
                                        seg.get("speaker")
                                        for seg in aligned_segments
                                        if coerce_str(seg.get("speaker"))
                                    }
                                )
                            metadata["pyannote_segment_count"] = len(speaker_segments)
                        metadata["asr_segment_count"] = len(detail.asr_segments)
                    else:
                        metadata["diarization_skipped"] = "no_asr_timestamps_from_stt"
                else:
                    stt_started_at = time.perf_counter()
                    # Local backend_http (IndrasNet WhisperX): no upload cap +
                    # resident model, so use a LARGE chunk (~10min) instead of
                    # the 30s cloud default — one coordinator call + one
                    # diarization pass per big chunk, not per 30s. This is the
                    # ~8x fix from docs/STT_ORCHESTRATION_OVERHEAD_RCA.md.
                    # A 10-min chunk + WhisperX cold-start (~80-115s) needs a
                    # generous timeout; floor it well above the 120s cloud
                    # default (backend allows up to 900s).
                    local_timeout = max(timeout, float(
                        os.getenv("LOCAL_STT_TIMEOUT_SECONDS", "900")
                    ))
                    transcript_text = await transcribe_audio_chunked(
                        temp_path,
                        http_url=http_url,
                        model=coerce_str(settings.get("http_model")),
                        language=coerce_str(settings.get("http_language")),
                        timeout_seconds=local_timeout,
                        chunk_duration_s=LOCAL_STT_CHUNK_DURATION_S,
                        on_chunk_progress=on_chunk_progress,
                        response_format=response_format,
                    )
                    timings_ms["stt_ms"] = _elapsed_ms(stt_started_at)
                    stt_backend = _last_stt_backend.get("")
                    source_diarized_segments = None
                    source_asr_segments = None
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                attempt_record["status"] = "failed"
                attempt_record["error"] = str(exc) or type(exc).__name__
                attempt_record["duration_ms"] = _elapsed_ms(attempt_started_at)
                provider_attempts.append(attempt_record)
                if attempt_idx + 1 < len(provider_candidates):
                    next_provider = (
                        coerce_str(
                            provider_candidates[attempt_idx + 1].get("provider")
                        ).lower()
                        or "whisper"
                    )
                    logger.warning(
                        "[STT FALLBACK] provider=%s failed (%s: %s), switching to provider=%s",
                        provider,
                        type(exc).__name__,
                        str(exc) or type(exc).__name__,
                        next_provider,
                    )
                    fallback_used = True
                    if on_provider_fallback is not None:
                        try:
                            await on_provider_fallback(
                                provider, next_provider, str(exc) or type(exc).__name__
                            )
                        except Exception as callback_exc:  # noqa: BLE001
                            logger.warning("[STT FALLBACK] callback failed: %s", callback_exc)
                    continue
                break

            attempt_record["status"] = "success"
            attempt_record["duration_ms"] = _elapsed_ms(attempt_started_at)
            provider_attempts.append(attempt_record)
            source_utterances = build_segment_utterances(
                diarized_segments=source_diarized_segments,
                asr_segments=source_asr_segments,
                transcript_text=transcript_text,
                default_speaker_id="SPEAKER_00",
            )
            break

        if not transcript_text:
            if last_error is not None:
                raise last_error
            raise RuntimeError("STT provider returned empty transcript.")

        if source_diarized_segments is not None:
            metadata["stt_diarized_segment_count"] = len(source_diarized_segments)
        if source_asr_segments is not None:
            metadata["asr_segment_count"] = len(source_asr_segments)
        if timings_ms:
            metadata["timings_ms"] = timings_ms
        metadata["provider_attempts"] = provider_attempts
        metadata["provider_attempt_count"] = len(provider_attempts)
        metadata["provider_fallback_used"] = fallback_used
        if fallback_used:
            failed_attempts = [item for item in provider_attempts if item.get("status") == "failed"]
            if failed_attempts:
                metadata["provider_fallback_from"] = failed_attempts[-1].get("provider")
            metadata["provider_fallback_to"] = active_provider
        metadata.update(
            {
                "provider": active_provider,
                "http_url": active_http_url,
                "transport": active_transport,
                "model": active_model,
            }
        )
        if stt_backend:
            metadata["stt_backend"] = stt_backend
        return FileTranscriptResult(
            transcript_text=parse_plain_text(transcript_text),
            source_type="audio",
            metadata=metadata,
            utterances=source_utterances,
            speaker_segments=list(source_diarized_segments or []),
        )

    if file_kind == "vtt":
        transcript_text = parse_vtt_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(
            transcript_text=transcript_text,
            source_type="vtt",
            metadata=metadata,
            utterances=build_line_utterances(transcript_text),
        )

    if file_kind == "srt":
        transcript_text = parse_srt_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(
            transcript_text=transcript_text,
            source_type="srt",
            metadata=metadata,
            utterances=build_line_utterances(transcript_text),
        )

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
            utterances=build_line_utterances(parse_plain_text(transcript_text)),
        )

    if file_kind == "text":
        transcript_text = parse_plain_text(_decode_text_bytes(raw_bytes))
        return FileTranscriptResult(
            transcript_text=transcript_text,
            source_type="text",
            metadata=metadata,
            utterances=build_line_utterances(transcript_text),
        )

    supported = (
        sorted(AUDIO_EXTENSIONS)
        + sorted(TEXT_EXTENSIONS)
        + sorted(VTT_EXTENSIONS)
        + sorted(SRT_EXTENSIONS)
        + sorted(GOOGLE_MEET_EXTENSIONS)
    )
    raise ValueError(
        f"Unsupported file type for '{filename}'. Supported extensions: {', '.join(supported)}"
    )

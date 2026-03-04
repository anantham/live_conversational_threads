"""Core worker pipeline for /api/import/process-file SSE processing."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_persistence import persist_import_graph
from lct_python_backend.services.import_bulk_telemetry import (
    attach_bottleneck_stage,
    calculate_segmented_progress,
    elapsed_ms,
    estimate_analysis_eta_ms,
    estimate_segment_eta_ms,
    estimate_transcription_eta_ms,
)

# Environment-tunable threshold for enabling interleaved segmentation (in bytes)
# Files larger than this will use segmented processing for progressive feedback
# Default: 10MB (roughly 10+ minutes of audio)
SEGMENT_PROCESSING_THRESHOLD_BYTES = int(
    os.getenv("SEGMENT_PROCESSING_THRESHOLD_BYTES", str(10 * 1024 * 1024))
)
# Set to "true" to enable segmented processing for all audio files
SEGMENT_PROCESSING_FORCE_ENABLED = (
    os.getenv("SEGMENT_PROCESSING_FORCE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
)


_AUDIO_SUFFIXES = {
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
    ".flac",
    ".aac",
    ".webm",
    ".mp4",
}


def _get_audio_duration_ms(file_path: Path) -> Optional[float]:
    """Get audio file duration in milliseconds using ffprobe.

    Returns None if unable to determine duration.
    """
    import subprocess
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            duration_seconds = float(result.stdout.strip())
            return duration_seconds * 1000
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass
    return None


def _format_duration_for_display(ms: Optional[float]) -> str:
    """Format milliseconds as human-readable duration string."""
    if ms is None or not isinstance(ms, (int, float)) or ms <= 0:
        return ""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


async def run_bulk_processing_worker(
    *,
    request: Request,
    file: UploadFile,
    source_type: str,
    conversation_id: Optional[str],
    speaker_id: Optional[str],
    provider: Optional[str],
    db: AsyncSession,
    temp_path: str,
    content_size: int,
    emit: Callable[[str, dict[str, Any]], Awaitable[None]],
    load_stt_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_config: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_providers: Optional[Callable[[AsyncSession], Awaitable[dict[str, Any]]]] = None,
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
    transcribe_audio_segmented: Optional[Callable[..., AsyncGenerator[Any, None]]] = None,
    chunk_transcript_lines: Callable[[str], list[str]],
    transcript_processor_cls: Callable[..., Any],
    is_async_import_diarization_enabled: Callable[[], bool],
    enqueue_import_diarization_job: Callable[..., Awaitable[dict[str, Any]]],
    copy_temp_upload_for_async_job: Callable[..., Path],
    cleanup_temp_file: Callable[[Optional[str]], None],
    build_diarization_job_urls: Callable[[str], dict[str, str]],
    logger: logging.Logger,
) -> None:
    """Execute bulk upload pipeline and emit SSE payloads."""
    filename = file.filename or "upload.bin"
    suffix = Path(filename).suffix.lower() or ".bin"
    resolved_conversation_id = conversation_id or str(uuid.uuid4())
    resolved_speaker_id = speaker_id or "speaker_1"
    pipeline_started_at = time.perf_counter()
    transcription_started_at: Optional[float] = None
    graph_started_at: Optional[float] = None
    active_stage = "uploading"

    logger.info(
        "[PROCESS FILE] Starting pipeline for %s (%d bytes, source_type=%s, provider=%s)",
        filename,
        content_size,
        source_type,
        provider or "auto",
    )

    telemetry: dict[str, Any] = {
        "file_name": filename,
        "file_size_bytes": content_size,
    }

    async def send_update(existing_json, chunk_dict):
        await emit("graph", {"type": "existing_json", "data": existing_json})
        await emit("graph", {"type": "chunk_dict", "data": chunk_dict})

    async def send_status(level: str, message: str, context: dict[str, Any]):
        context = context or {}
        stage = str(context.get("stage") or "").strip()
        progress_map = {
            "accumulate": 0.65,
            "generate_lct_json": 0.85,
        }
        await emit(
            "status",
            {
                "level": level,
                "stage": stage or "analyzing",
                "message": message,
                "progress": progress_map.get(stage, 0.55),
                "context": context,
                "stt_backend": telemetry.get("stt_backend", ""),
                "llm_backend": telemetry.get("llm_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                    "stt_backend": telemetry.get("stt_backend", ""),
                    "llm_backend": telemetry.get("llm_backend", ""),
                },
            },
        )

    try:
        await emit(
            "status",
            {
                "stage": "uploading",
                "progress": 0.05,
                "message": f"File received ({content_size} bytes)",
                "file_name": filename,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                },
            },
        )

        stt_settings = await load_stt_settings(db)

        # Determine STT backend from settings for early UI indicator
        stt_http_url = str(stt_settings.get("http_url", "")).strip()
        if "modal" in stt_http_url.lower():
            stt_backend = "modal_whisperx"
        elif "127.0.0.1" in stt_http_url or "localhost" in stt_http_url:
            stt_backend = "local_whisperx"
        else:
            stt_backend = "whisperx"  # Generic fallback
        telemetry["stt_backend"] = stt_backend

        # Emit progress before the (potentially slow) transcription call.
        resolved_source_type = source_type if source_type != "auto" else None
        is_likely_audio = (
            resolved_source_type == "audio"
            or (resolved_source_type is None and suffix in _AUDIO_SUFFIXES)
        )
        active_stage = "transcribing" if is_likely_audio else "parsing"
        telemetry["is_likely_audio"] = is_likely_audio
        telemetry["source_type_override"] = resolved_source_type or "auto"

        # Detect audio duration for better progress feedback
        audio_duration_ms: Optional[float] = None
        if is_likely_audio:
            audio_duration_ms = _get_audio_duration_ms(Path(temp_path))
            telemetry["audio_duration_ms"] = audio_duration_ms

        # Build transcription message with duration if available
        duration_str = _format_duration_for_display(audio_duration_ms)
        if is_likely_audio and duration_str:
            transcribe_msg = f"Transcribing {duration_str} of audio..."
        elif is_likely_audio:
            transcribe_msg = "Transcribing audio..."
        else:
            transcribe_msg = "Extracting transcript text..."

        await emit(
            "status",
            {
                "stage": "transcribing" if is_likely_audio else "parsing",
                "progress": 0.10,
                "message": transcribe_msg,
                "stt_backend": stt_backend if is_likely_audio else "",
                "audio_duration_ms": audio_duration_ms,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                    "stt_backend": stt_backend if is_likely_audio else "",
                    "audio_duration_ms": audio_duration_ms,
                },
            },
        )
        transcription_started_at = time.perf_counter()

        async def on_chunk_progress(chunk_idx: int, total: int, chunk_text: str):
            frac = chunk_idx / total
            progress = 0.10 + frac * 0.25
            telemetry["stt_chunks_completed"] = chunk_idx
            telemetry["stt_chunks_total"] = total
            transcription_elapsed_ms = (
                elapsed_ms(transcription_started_at)
                if transcription_started_at is not None
                else None
            )
            transcription_eta_ms, transcription_estimated_total_ms = estimate_transcription_eta_ms(
                transcription_elapsed_ms=transcription_elapsed_ms,
                chunk_idx=chunk_idx,
                total_chunks=total,
            )
            await emit(
                "status",
                {
                    "stage": "transcribing",
                    "progress": round(progress, 3),
                    "message": f"Transcribing audio chunk {chunk_idx}/{total}...",
                    "stt_backend": telemetry.get("stt_backend", ""),
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "transcription_elapsed_ms": transcription_elapsed_ms,
                        "transcription_eta_ms": transcription_eta_ms,
                        "transcription_estimated_total_ms": transcription_estimated_total_ms,
                        "stt_chunks_completed": chunk_idx,
                        "stt_chunks_total": total,
                        "stt_backend": telemetry.get("stt_backend", ""),
                    },
                },
            )
            normalized_chunk_text = str(chunk_text or "").strip()
            if normalized_chunk_text:
                await emit(
                    "transcript",
                    {
                        "phase": "transcribing",
                        "chunk_id": f"stt-chunk-{chunk_idx}",
                        "index": chunk_idx,
                        "total": total,
                        "text": normalized_chunk_text,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "transcription_elapsed_ms": transcription_elapsed_ms,
                            "transcription_eta_ms": transcription_eta_ms,
                            "stt_chunks_completed": chunk_idx,
                            "stt_chunks_total": total,
                        },
                    },
                )

        async def on_provider_fallback(
            from_provider: str,
            to_provider: str,
            error_message: str,
        ) -> None:
            fallback_record = {
                "from_provider": str(from_provider or "").strip().lower() or "unknown",
                "to_provider": str(to_provider or "").strip().lower() or "unknown",
                "error": str(error_message or "").strip() or "unknown_error",
            }
            fallback_events = telemetry.setdefault("stt_provider_fallbacks", [])
            if isinstance(fallback_events, list):
                fallback_events.append(fallback_record)
            await emit(
                "status",
                {
                    "stage": "transcribing",
                    "progress": 0.2,
                    "notice_type": "stt_provider_fallback",
                    "message": (
                        f"Local STT provider {fallback_record['from_provider']} failed. "
                        f"Falling back to {fallback_record['to_provider']}."
                    ),
                    "fallback": fallback_record,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "transcription_elapsed_ms": (
                            elapsed_ms(transcription_started_at)
                            if transcription_started_at is not None
                            else None
                        ),
                    },
                },
            )

        # Determine if we should use interleaved segmented processing
        # This is beneficial for large audio files (> threshold) as it provides
        # progressive feedback: users see nodes appearing as each segment completes
        use_segmented_processing = (
            is_likely_audio
            and transcribe_audio_segmented is not None
            and (
                SEGMENT_PROCESSING_FORCE_ENABLED
                or content_size > SEGMENT_PROCESSING_THRESHOLD_BYTES
            )
        )
        telemetry["segmented_processing"] = use_segmented_processing

        if use_segmented_processing:
            logger.info(
                "[PROCESS FILE] Using interleaved segmented processing for %s (%d bytes, threshold=%d)",
                filename,
                content_size,
                SEGMENT_PROCESSING_THRESHOLD_BYTES,
            )
        else:
            logger.info(
                "[PROCESS FILE] Using sequential processing for %s (%d bytes, is_audio=%s, segmented_fn=%s)",
                filename,
                content_size,
                is_likely_audio,
                transcribe_audio_segmented is not None,
            )

        llm_config = await load_llm_config(db)
        # Load LLM providers for fallback support
        llm_providers = None
        if load_llm_providers:
            llm_providers_config = await load_llm_providers(db)
            llm_providers = llm_providers_config.get("providers")

        # Determine LLM backend for UI indicators (will be updated by processor)
        llm_base_url = str(llm_config.get("base_url", "")).strip()
        llm_model = str(llm_config.get("chat_model", "")).strip()
        is_modal_llm = "modal.run" in llm_base_url
        llm_backend = f"modal_{llm_model}" if is_modal_llm else f"local_{llm_model}"
        telemetry["llm_backend"] = llm_backend

        processor = transcript_processor_cls(
            send_update=send_update,
            send_status=send_status,
            llm_config=llm_config,
            providers=llm_providers,
        )
        graph_started_at = time.perf_counter()

        # Track final source type (set by either path)
        final_source_type = "audio" if is_likely_audio else "text"
        final_source_metadata: dict[str, Any] = {}

        if use_segmented_processing:
            # ────────────────────────────────────────────────────────────────
            # INTERLEAVED SEGMENTED PROCESSING
            # Process each natural audio segment through the full pipeline
            # so users see nodes appearing progressively
            # ────────────────────────────────────────────────────────────────
            active_stage = "segmented_transcribing"
            total_transcript_chars = 0
            total_nodes_generated = 0

            # Get STT URL from settings
            stt_http_url = str(stt_settings.get("http_url", "")).strip()
            if not stt_http_url:
                logger.error("[PROCESS FILE] No STT HTTP URL configured for segmented transcription")
                raise ValueError("No STT HTTP URL configured for segmented transcription.")

            logger.info(
                "[PROCESS FILE] Starting segmented transcription using STT URL: %s",
                stt_http_url,
            )

            segment_idx = 0
            async for segment in transcribe_audio_segmented(
                file_path=Path(temp_path),
                http_url=stt_http_url,
                model=str(stt_settings.get("http_model", "")).strip(),
                language=str(stt_settings.get("http_language", "")).strip(),
                timeout_seconds=float(stt_settings.get("http_timeout_seconds", 120.0) or 120.0),
            ):
                segment_idx += 1
                if await request.is_disconnected():
                    logger.info(
                        "[PROCESS FILE] Client disconnected during segment %d/%d",
                        segment.segment_index,
                        segment.segment_total,
                    )
                    return

                # Emit segment_started event
                await emit(
                    "segment_started",
                    {
                        "index": segment.segment_index,
                        "total": segment.segment_total,
                        "start_ms": segment.start_ms,
                        "end_ms": segment.end_ms,
                        "duration_ms": segment.end_ms - segment.start_ms,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )

                # Calculate overall progress for this segment's transcription phase
                stt_progress = calculate_segmented_progress(
                    segment.segment_index,
                    segment.segment_total,
                    "transcribing",
                    1.0,  # Segment transcription complete
                )

                # Calculate segment ETA
                segment_eta_ms, segment_estimated_total_ms = estimate_segment_eta_ms(
                    total_elapsed_ms=elapsed_ms(pipeline_started_at),
                    segments_completed=segment.segment_index,
                    segments_total=segment.segment_total,
                )

                await emit(
                    "status",
                    {
                        "stage": "transcribing",
                        "progress": round(stt_progress, 3),
                        "message": f"Transcribed segment {segment.segment_index}/{segment.segment_total}",
                        "segment_index": segment.segment_index,
                        "segment_total": segment.segment_total,
                        "stt_backend": segment.metadata.get("stt_backend", ""),
                        "llm_backend": llm_backend,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "segment_elapsed_ms": segment.elapsed_ms,
                            "segment_index": segment.segment_index,
                            "segment_total": segment.segment_total,
                            # Compatibility keys for frontend ETA calculation
                            "stt_chunks_completed": segment.segment_index,
                            "stt_chunks_total": segment.segment_total,
                            "transcription_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "transcription_eta_ms": segment_eta_ms,
                        },
                    },
                )

                # Store STT backend
                if segment.metadata.get("stt_backend"):
                    telemetry["stt_backend"] = segment.metadata.get("stt_backend")

                # Emit transcript text for this segment
                await emit(
                    "transcript",
                    {
                        "phase": "transcribing",
                        "segment_index": segment.segment_index,
                        "segment_total": segment.segment_total,
                        "text": segment.transcript_text,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )

                # Now analyze this segment's transcript
                active_stage = "analyzing"
                segment_chunks = chunk_transcript_lines(segment.transcript_text)
                total_transcript_chars += len(segment.transcript_text)

                for chunk_idx, chunk in enumerate(segment_chunks, start=1):
                    if await request.is_disconnected():
                        return

                    # Calculate progress for analysis phase of this segment
                    analysis_stage_progress = chunk_idx / max(1, len(segment_chunks))
                    overall_progress = calculate_segmented_progress(
                        segment.segment_index,
                        segment.segment_total,
                        "analyzing",
                        analysis_stage_progress,
                    )

                    await emit(
                        "status",
                        {
                            "stage": "analyzing",
                            "progress": round(overall_progress, 3),
                            "message": f"Analyzing segment {segment.segment_index}/{segment.segment_total} chunk {chunk_idx}/{len(segment_chunks)}...",
                            "segment_index": segment.segment_index,
                            "segment_total": segment.segment_total,
                            "stt_backend": telemetry.get("stt_backend", ""),
                            "llm_backend": llm_backend,
                            "telemetry": {
                                "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                                "segment_index": segment.segment_index,
                                "segment_total": segment.segment_total,
                            },
                        },
                    )

                    await processor.handle_final_text(chunk)

                # Flush segment to emit nodes from this segment
                nodes_after_segment = await processor.flush_segment()
                nodes_this_segment = nodes_after_segment - total_nodes_generated
                total_nodes_generated = nodes_after_segment

                # Emit segment_complete event
                await emit(
                    "segment_complete",
                    {
                        "index": segment.segment_index,
                        "total": segment.segment_total,
                        "nodes_generated": nodes_this_segment,
                        "total_nodes": total_nodes_generated,
                        "elapsed_ms": segment.elapsed_ms,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )

                logger.info(
                    "[PROCESS FILE] Segment %d/%d complete: %d nodes (+%d this segment)",
                    segment.segment_index,
                    segment.segment_total,
                    total_nodes_generated,
                    nodes_this_segment,
                )

            # Final flush after all segments
            await processor.flush()
            telemetry["segment_count"] = segment_idx
            telemetry["transcript_chars"] = total_transcript_chars
            final_source_type = "audio"

        else:
            # ────────────────────────────────────────────────────────────────
            # SEQUENTIAL PROCESSING (existing flow)
            # Transcribe entire file, then analyze all at once
            # ────────────────────────────────────────────────────────────────
            transcript_result = await transcribe_uploaded_file(
                temp_path=Path(temp_path),
                filename=filename,
                content_type=file.content_type,
                stt_settings=stt_settings,
                provider_override=provider,
                source_type_override=resolved_source_type,
                on_chunk_progress=on_chunk_progress if is_likely_audio else None,
                on_provider_fallback=on_provider_fallback if is_likely_audio else None,
            )
            source_timings = transcript_result.metadata.get("timings_ms", {})
            if isinstance(source_timings, dict):
                telemetry["stt_provider_ms"] = source_timings.get("stt_ms")
                telemetry["diarization_ms"] = source_timings.get("diarization_ms")
                telemetry["alignment_ms"] = source_timings.get("alignment_ms")
            if transcript_result.metadata.get("provider_fallback_used"):
                telemetry["stt_provider_fallback_used"] = True
                telemetry["stt_provider_fallback_from"] = transcript_result.metadata.get("provider_fallback_from")
                telemetry["stt_provider_fallback_to"] = transcript_result.metadata.get("provider_fallback_to")
            # Store stt_backend for later use in send_status
            if transcript_result.metadata.get("stt_backend"):
                telemetry["stt_backend"] = transcript_result.metadata.get("stt_backend")
            if transcription_started_at is not None:
                telemetry["transcription_ms"] = elapsed_ms(transcription_started_at)
            status_message = f"Got {transcript_result.source_type} transcript."
            if transcript_result.source_type == "audio" and transcript_result.metadata.get("provider_fallback_used"):
                fallback_from = transcript_result.metadata.get("provider_fallback_from") or "local"
                fallback_to = transcript_result.metadata.get("provider") or "fallback provider"
                status_message = f"Got audio transcript via fallback ({fallback_from} -> {fallback_to})."
            await emit(
                "status",
                {
                    "stage": "transcribed",
                    "progress": 0.35,
                    "message": status_message,
                    "source_type": transcript_result.source_type,
                    "metadata": transcript_result.metadata,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "transcription_ms": telemetry.get("transcription_ms"),
                        "stt_provider_ms": telemetry.get("stt_provider_ms"),
                        "diarization_ms": telemetry.get("diarization_ms"),
                        "alignment_ms": telemetry.get("alignment_ms"),
                        "stt_backend": transcript_result.metadata.get("stt_backend"),
                    },
                },
            )
            active_stage = "chunking"

            transcript_text = transcript_result.transcript_text.strip()
            if not transcript_text:
                raise ValueError("No transcript text could be extracted from file.")

            chunking_started_at = time.perf_counter()
            transcript_chunks = chunk_transcript_lines(transcript_text)
            if not transcript_chunks:
                raise ValueError("Transcript parser produced no usable chunks.")
            telemetry["chunking_ms"] = elapsed_ms(chunking_started_at)
            telemetry["transcript_chars"] = len(transcript_text)
            telemetry["transcript_chunk_count"] = len(transcript_chunks)

            active_stage = "analyzing"
            await emit(
                "status",
                {
                    "stage": "analyzing",
                    "progress": 0.55,
                    "message": f"Generating graph from {len(transcript_chunks)} transcript chunks...",
                    "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                    "llm_backend": llm_backend,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "chunking_ms": telemetry.get("chunking_ms"),
                        "transcript_chunk_count": len(transcript_chunks),
                        "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                        "llm_backend": llm_backend,
                    },
                },
            )

            for index, chunk in enumerate(transcript_chunks, start=1):
                if await request.is_disconnected():
                    logger.info(
                        "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                        index,
                        len(transcript_chunks),
                    )
                    return

                # Calculate ETA for analysis stage
                analysis_elapsed_ms = (
                    elapsed_ms(graph_started_at) if graph_started_at is not None else None
                )
                analysis_eta_ms, analysis_estimated_total_ms = estimate_analysis_eta_ms(
                    analysis_elapsed_ms=analysis_elapsed_ms,
                    chunk_idx=index - 1,  # Use completed chunks for ETA
                    total_chunks=len(transcript_chunks),
                )

                # Calculate progress within analysis phase (0.55 to 0.95)
                analysis_progress = 0.55 + (index / len(transcript_chunks)) * 0.40

                await emit(
                    "status",
                    {
                        "stage": "analyzing",
                        "progress": round(analysis_progress, 3),
                        "message": f"Analyzing chunk {index}/{len(transcript_chunks)}...",
                        "stt_backend": telemetry.get("stt_backend", ""),
                        "llm_backend": telemetry.get("llm_backend", ""),
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "analysis_elapsed_ms": analysis_elapsed_ms,
                            "analysis_eta_ms": analysis_eta_ms,
                            "analysis_estimated_total_ms": analysis_estimated_total_ms,
                            "analysis_chunks_completed": index - 1,
                            "analysis_chunks_total": len(transcript_chunks),
                            "stt_backend": telemetry.get("stt_backend", ""),
                            "llm_backend": telemetry.get("llm_backend", ""),
                        },
                    },
                )

                await emit(
                    "transcript",
                    {
                        "phase": "analyzing",
                        "chunk_id": f"segment-{index}",
                        "index": index,
                        "total": len(transcript_chunks),
                        "text": chunk,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "graph_elapsed_ms": analysis_elapsed_ms,
                            "analysis_eta_ms": analysis_eta_ms,
                        },
                    },
                )

                logger.info(
                    "[PROCESS FILE] Processing chunk %d/%d (eta: %s ms)",
                    index,
                    len(transcript_chunks),
                    analysis_eta_ms,
                )
                await processor.handle_final_text(chunk)

            await processor.flush()

            # Persist graph to DB (enables canvas export and other DB-backed features)
            try:
                persisted_count = await persist_import_graph(
                    db=db,
                    conversation_id=resolved_conversation_id,
                    existing_json=processor.existing_json,
                )
                logger.info("[PROCESS FILE] Persisted %d nodes to DB for %s", persisted_count, resolved_conversation_id)
                telemetry["graph_persisted_nodes"] = persisted_count
            except Exception as persist_exc:  # noqa: BLE001
                logger.warning("[PROCESS FILE] Graph persistence failed (non-fatal): %s", persist_exc)
                telemetry["graph_persist_error"] = str(persist_exc) or type(persist_exc).__name__

            final_source_type = transcript_result.source_type
            final_source_metadata = transcript_result.metadata

        telemetry["graph_generation_ms"] = (
            elapsed_ms(graph_started_at)
            if graph_started_at is not None
            else None
        )
        telemetry["total_processing_ms"] = elapsed_ms(pipeline_started_at)
        telemetry["source_type"] = final_source_type
        telemetry["source_metadata"] = final_source_metadata
        telemetry["node_count"] = len(processor.existing_json)
        telemetry["chunk_count"] = len(processor.chunk_dict)
        attach_bottleneck_stage(telemetry)

        logger.info(
            "[PROCESS FILE TELEMETRY] %s",
            json.dumps(telemetry, ensure_ascii=False, sort_keys=True),
        )

        diarization_job_payload = None
        if (
            final_source_type == "audio"
            and is_async_import_diarization_enabled()
        ):
            async_audio_copy: Optional[Path] = None
            try:
                async_audio_copy = copy_temp_upload_for_async_job(Path(temp_path), suffix=suffix)
                job_snapshot = await enqueue_import_diarization_job(
                    audio_path=async_audio_copy,
                    filename=filename,
                    content_type=file.content_type,
                    source_type_override=resolved_source_type,
                    provider_override=provider,
                    conversation_id=resolved_conversation_id,
                    speaker_id=resolved_speaker_id,
                    stt_settings=stt_settings,
                    llm_config=llm_config,
                    source_metadata=final_source_metadata,
                )
                job_id = str(job_snapshot["job_id"])
                telemetry["async_diarization_job_id"] = job_id
                diarization_job_payload = {
                    "id": job_id,
                    "status": job_snapshot.get("status"),
                    **build_diarization_job_urls(job_id),
                }
                await emit(
                    "status",
                    {
                        "stage": "queued",
                        "progress": 0.98,
                        "message": "Queued background diarization job.",
                        "diarization_job": diarization_job_payload,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001
                if async_audio_copy is not None:
                    cleanup_temp_file(str(async_audio_copy))
                enqueue_error = str(exc) or type(exc).__name__
                telemetry["async_diarization_enqueue_error"] = enqueue_error
                logger.warning(
                    "Failed to enqueue async diarization job for %s: %s",
                    filename,
                    enqueue_error,
                )

        await emit(
            "done",
            {
                "conversation_id": resolved_conversation_id,
                "speaker_id": resolved_speaker_id,
                "node_count": len(processor.existing_json),
                "chunk_count": len(processor.chunk_dict),
                "source_type": final_source_type,
                "telemetry": telemetry,
                "diarization_job": diarization_job_payload,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Bulk file processing failed for %s", filename)
        err_msg = str(exc) or f"{type(exc).__name__}"
        error_telemetry = {
            **telemetry,
            "active_stage": active_stage,
            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
        }
        await emit(
            "error",
            {
                "message": err_msg,
                "file_name": filename,
                "telemetry": error_telemetry,
            },
        )

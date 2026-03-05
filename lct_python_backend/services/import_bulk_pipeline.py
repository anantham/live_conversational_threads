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

from lct_python_backend.services.import_bulk_segmented import run_segmented_path
from lct_python_backend.services.import_bulk_sequential import run_sequential_path
from lct_python_backend.services.import_bulk_telemetry import (
    attach_bottleneck_stage,
    elapsed_ms,
)
from lct_python_backend.services.import_persistence import persist_import_graph
from lct_python_backend.services.import_pipeline_context import PipelineContext

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

    ctx = PipelineContext(emit=emit, logger=logger, filename=filename, content_size=content_size)

    logger.info(
        "[PROCESS FILE] Starting pipeline for %s (%d bytes, source_type=%s, provider=%s)",
        filename,
        content_size,
        source_type,
        provider or "auto",
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
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
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
        ctx.telemetry["stt_backend"] = stt_backend

        # Emit progress before the (potentially slow) transcription call.
        resolved_source_type = source_type if source_type != "auto" else None
        is_likely_audio = (
            resolved_source_type == "audio"
            or (resolved_source_type is None and suffix in _AUDIO_SUFFIXES)
        )
        ctx.active_stage = "transcribing" if is_likely_audio else "parsing"
        ctx.telemetry["is_likely_audio"] = is_likely_audio
        ctx.telemetry["source_type_override"] = resolved_source_type or "auto"

        # Detect audio duration for better progress feedback
        audio_duration_ms: Optional[float] = None
        if is_likely_audio:
            audio_duration_ms = _get_audio_duration_ms(Path(temp_path))
            ctx.telemetry["audio_duration_ms"] = audio_duration_ms

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
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                    "stt_backend": stt_backend if is_likely_audio else "",
                    "audio_duration_ms": audio_duration_ms,
                },
            },
        )
        ctx.transcription_started_at = time.perf_counter()

        # Determine if we should use interleaved segmented processing
        use_segmented_processing = (
            is_likely_audio
            and transcribe_audio_segmented is not None
            and (
                SEGMENT_PROCESSING_FORCE_ENABLED
                or content_size > SEGMENT_PROCESSING_THRESHOLD_BYTES
            )
        )
        ctx.telemetry["segmented_processing"] = use_segmented_processing

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
        llm_providers = None
        if load_llm_providers:
            llm_providers_config = await load_llm_providers(db)
            llm_providers = llm_providers_config.get("providers")

        # Determine LLM backend for UI indicators
        llm_base_url = str(llm_config.get("base_url", "")).strip()
        llm_model = str(llm_config.get("chat_model", "")).strip()
        is_modal_llm = "modal.run" in llm_base_url
        llm_backend = f"modal_{llm_model}" if is_modal_llm else f"local_{llm_model}"
        ctx.telemetry["llm_backend"] = llm_backend

        processor = transcript_processor_cls(
            send_update=ctx.emit_graph_update,
            send_status=ctx.emit_status,
            llm_config=llm_config,
            providers=llm_providers,
        )
        ctx.graph_started_at = time.perf_counter()

        # Track final source type (set by either path)
        final_source_type = "audio" if is_likely_audio else "text"
        final_source_metadata: dict[str, Any] = {}

        if use_segmented_processing:
            segment_count, transcript_chars = await run_segmented_path(
                ctx=ctx,
                processor=processor,
                request=request,
                stt_settings=stt_settings,
                transcribe_audio_segmented=transcribe_audio_segmented,
                chunk_transcript_lines=chunk_transcript_lines,
                llm_backend=llm_backend,
                temp_path=temp_path,
            )
            ctx.telemetry["segment_count"] = segment_count
            ctx.telemetry["transcript_chars"] = transcript_chars
            final_source_type = "audio"
        else:
            final_source_type, final_source_metadata = await run_sequential_path(
                ctx=ctx,
                processor=processor,
                request=request,
                transcribe_uploaded_file=transcribe_uploaded_file,
                stt_settings=stt_settings,
                provider=provider,
                resolved_source_type=resolved_source_type,
                filename=filename,
                content_type=file.content_type,
                chunk_transcript_lines=chunk_transcript_lines,
                llm_backend=llm_backend,
                is_likely_audio=is_likely_audio,
                temp_path=temp_path,
            )

        # Persist graph to DB (enables canvas export and other DB-backed features)
        try:
            persisted_count = await persist_import_graph(
                db=db,
                conversation_id=resolved_conversation_id,
                existing_json=processor.existing_json,
                conversation_name=Path(filename).stem or "Imported conversation",
                source_type=final_source_type,
                source_metadata=(
                    final_source_metadata if isinstance(final_source_metadata, dict) else {}
                ),
            )
            logger.info("[PROCESS FILE] Persisted %d nodes to DB for %s", persisted_count, resolved_conversation_id)
            ctx.telemetry["graph_persisted_nodes"] = persisted_count
        except Exception as persist_exc:  # noqa: BLE001
            logger.warning("[PROCESS FILE] Graph persistence failed (non-fatal): %s", persist_exc)
            ctx.telemetry["graph_persist_error"] = str(persist_exc) or type(persist_exc).__name__

        ctx.telemetry["graph_generation_ms"] = (
            elapsed_ms(ctx.graph_started_at)
            if ctx.graph_started_at is not None
            else None
        )
        ctx.telemetry["total_processing_ms"] = elapsed_ms(ctx.pipeline_started_at)
        ctx.telemetry["source_type"] = final_source_type
        ctx.telemetry["source_metadata"] = final_source_metadata
        ctx.telemetry["node_count"] = len(processor.existing_json)
        ctx.telemetry["chunk_count"] = len(processor.chunk_dict)
        attach_bottleneck_stage(ctx.telemetry)

        logger.info(
            "[PROCESS FILE TELEMETRY] %s",
            json.dumps(ctx.telemetry, ensure_ascii=False, sort_keys=True),
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
                ctx.telemetry["async_diarization_job_id"] = job_id
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
                            "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001
                if async_audio_copy is not None:
                    cleanup_temp_file(str(async_audio_copy))
                enqueue_error = str(exc) or type(exc).__name__
                ctx.telemetry["async_diarization_enqueue_error"] = enqueue_error
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
                "telemetry": ctx.telemetry,
                "diarization_job": diarization_job_payload,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Bulk file processing failed for %s", filename)
        err_msg = str(exc) or f"{type(exc).__name__}"
        error_telemetry = {
            **ctx.telemetry,
            "active_stage": ctx.active_stage,
            "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
        }
        await emit(
            "error",
            {
                "message": err_msg,
                "file_name": filename,
                "telemetry": error_telemetry,
            },
        )

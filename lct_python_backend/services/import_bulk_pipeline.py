"""Core worker pipeline for /api/import/process-file SSE processing."""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_telemetry import (
    attach_bottleneck_stage,
    elapsed_ms,
    estimate_transcription_eta_ms,
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
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
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
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
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

        # Emit progress before the (potentially slow) transcription call.
        resolved_source_type = source_type if source_type != "auto" else None
        is_likely_audio = (
            resolved_source_type == "audio"
            or (resolved_source_type is None and suffix in _AUDIO_SUFFIXES)
        )
        active_stage = "transcribing" if is_likely_audio else "parsing"
        telemetry["is_likely_audio"] = is_likely_audio
        telemetry["source_type_override"] = resolved_source_type or "auto"
        await emit(
            "status",
            {
                "stage": "transcribing" if is_likely_audio else "parsing",
                "progress": 0.10,
                "message": (
                    "Transcribing audio..."
                    if is_likely_audio
                    else "Extracting transcript text..."
                ),
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
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
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "transcription_elapsed_ms": transcription_elapsed_ms,
                        "transcription_eta_ms": transcription_eta_ms,
                        "transcription_estimated_total_ms": transcription_estimated_total_ms,
                        "stt_chunks_completed": chunk_idx,
                        "stt_chunks_total": total,
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
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                    "chunking_ms": telemetry.get("chunking_ms"),
                    "transcript_chunk_count": len(transcript_chunks),
                },
            },
        )

        llm_config = await load_llm_config(db)
        processor = transcript_processor_cls(
            send_update=send_update,
            send_status=send_status,
            llm_config=llm_config,
        )
        graph_started_at = time.perf_counter()

        for index, chunk in enumerate(transcript_chunks, start=1):
            if await request.is_disconnected():
                logger.info(
                    "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                    index,
                    len(transcript_chunks),
                )
                return

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
                        "graph_elapsed_ms": (
                            elapsed_ms(graph_started_at)
                            if graph_started_at is not None
                            else None
                        ),
                    },
                },
            )
            await processor.handle_final_text(chunk)

        await processor.flush()
        telemetry["graph_generation_ms"] = (
            elapsed_ms(graph_started_at)
            if graph_started_at is not None
            else None
        )
        telemetry["total_processing_ms"] = elapsed_ms(pipeline_started_at)
        telemetry["source_type"] = transcript_result.source_type
        telemetry["source_metadata"] = transcript_result.metadata
        telemetry["node_count"] = len(processor.existing_json)
        telemetry["chunk_count"] = len(processor.chunk_dict)
        attach_bottleneck_stage(telemetry)

        logger.info(
            "[PROCESS FILE TELEMETRY] %s",
            json.dumps(telemetry, ensure_ascii=False, sort_keys=True),
        )

        diarization_job_payload = None
        if (
            transcript_result.source_type == "audio"
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
                    source_metadata=transcript_result.metadata,
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
                "source_type": transcript_result.source_type,
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

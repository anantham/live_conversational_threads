"""Per-run pipeline context for the bulk file import worker.

Extracts all mutable per-run state and nested closures from
``import_bulk_pipeline.run_bulk_processing_worker`` into a single class,
eliminating the closure-over-shared-state pattern that made the original
function untestable in parts.

The two processing paths (segmented / sequential) become distinct, independently
readable methods: ``_run_segmented`` and ``_run_sequential``.

Public API: ``BulkPipelineContext`` (constructed and called by ``run_bulk_processing_worker``).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_telemetry import (
    attach_bottleneck_stage,
    calculate_segmented_progress,
    elapsed_ms,
    estimate_analysis_eta_ms,
    estimate_segment_eta_ms,
    estimate_transcription_eta_ms,
)
from lct_python_backend.services.import_persistence import persist_import_graph

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

SEGMENT_PROCESSING_THRESHOLD_BYTES = int(
    os.getenv("SEGMENT_PROCESSING_THRESHOLD_BYTES", str(10 * 1024 * 1024))
)
SEGMENT_PROCESSING_FORCE_ENABLED = (
    os.getenv("SEGMENT_PROCESSING_FORCE_ENABLED", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)

_AUDIO_SUFFIXES = {
    ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4",
}


# ---------------------------------------------------------------------------
# Module-level utilities (stateless)
# ---------------------------------------------------------------------------

def get_audio_duration_ms(file_path: Path) -> Optional[float]:
    """Return audio duration in milliseconds via ffprobe, or None on failure."""
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
            return float(result.stdout.strip()) * 1000
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass
    return None


def format_duration_for_display(ms: Optional[float]) -> str:
    """Format milliseconds as human-readable string (e.g. '3m 12s')."""
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


# ---------------------------------------------------------------------------
# BulkPipelineContext
# ---------------------------------------------------------------------------

class BulkPipelineContext:
    """Holds all mutable per-run state and orchestrates the import pipeline.

    Replaces the closure-heavy ``run_bulk_processing_worker`` function with a
    class whose methods replace the nested closures.  The public entry point is
    ``run()``.

    Args:
        All keyword-only arguments mirror the signature of the original
        ``run_bulk_processing_worker`` function so callers need no changes.
    """

    def __init__(
        self,
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
        # Injected dependencies
        self._request = request
        self._file = file
        self._source_type = source_type
        self._provider = provider
        self._db = db
        self._temp_path = temp_path
        self._content_size = content_size
        self._emit = emit
        self._load_stt_settings = load_stt_settings
        self._load_llm_config = load_llm_config
        self._load_llm_providers = load_llm_providers
        self._transcribe_uploaded_file = transcribe_uploaded_file
        self._transcribe_audio_segmented = transcribe_audio_segmented
        self._chunk_transcript_lines = chunk_transcript_lines
        self._transcript_processor_cls = transcript_processor_cls
        self._is_async_import_diarization_enabled = is_async_import_diarization_enabled
        self._enqueue_import_diarization_job = enqueue_import_diarization_job
        self._copy_temp_upload_for_async_job = copy_temp_upload_for_async_job
        self._cleanup_temp_file = cleanup_temp_file
        self._build_diarization_job_urls = build_diarization_job_urls
        self._logger = logger

        # Per-run mutable state
        self.filename: str = file.filename or "upload.bin"
        self.suffix: str = Path(self.filename).suffix.lower() or ".bin"
        self.resolved_conversation_id: str = conversation_id or str(uuid.uuid4())
        self.resolved_speaker_id: str = speaker_id or "speaker_1"
        self.pipeline_started_at: float = time.perf_counter()
        self.transcription_started_at: Optional[float] = None
        self.graph_started_at: Optional[float] = None
        self.active_stage: str = "uploading"
        self.telemetry: dict[str, Any] = {
            "file_name": self.filename,
            "file_size_bytes": content_size,
        }
        self.processor: Any = None  # Set during run() after llm_config is loaded

    # ------------------------------------------------------------------
    # SSE emission helpers (replace closures)
    # ------------------------------------------------------------------

    async def _send_update(self, existing_json: Any, chunk_dict: Any) -> None:
        await self._emit("graph", {"type": "existing_json", "data": existing_json})
        await self._emit("graph", {"type": "chunk_dict", "data": chunk_dict})

    async def _send_status(self, level: str, message: str, context: dict[str, Any]) -> None:
        context = context or {}
        stage = str(context.get("stage") or "").strip()
        progress_map = {
            "accumulate": 0.65,
            "generate_lct_json": 0.85,
        }
        await self._emit(
            "status",
            {
                "level": level,
                "stage": stage or "analyzing",
                "message": message,
                "progress": progress_map.get(stage, 0.55),
                "context": context,
                "stt_backend": self.telemetry.get("stt_backend", ""),
                "llm_backend": self.telemetry.get("llm_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                    "stt_backend": self.telemetry.get("stt_backend", ""),
                    "llm_backend": self.telemetry.get("llm_backend", ""),
                },
            },
        )

    async def _on_chunk_progress(self, chunk_idx: int, total: int, chunk_text: str) -> None:
        frac = chunk_idx / total
        progress = 0.10 + frac * 0.25
        self.telemetry["stt_chunks_completed"] = chunk_idx
        self.telemetry["stt_chunks_total"] = total
        transcription_elapsed_ms = (
            elapsed_ms(self.transcription_started_at)
            if self.transcription_started_at is not None
            else None
        )
        transcription_eta_ms, transcription_estimated_total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=transcription_elapsed_ms,
            chunk_idx=chunk_idx,
            total_chunks=total,
        )
        await self._emit(
            "status",
            {
                "stage": "transcribing",
                "progress": round(progress, 3),
                "message": f"Transcribing audio chunk {chunk_idx}/{total}...",
                "stt_backend": self.telemetry.get("stt_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                    "transcription_elapsed_ms": transcription_elapsed_ms,
                    "transcription_eta_ms": transcription_eta_ms,
                    "transcription_estimated_total_ms": transcription_estimated_total_ms,
                    "stt_chunks_completed": chunk_idx,
                    "stt_chunks_total": total,
                    "stt_backend": self.telemetry.get("stt_backend", ""),
                },
            },
        )
        normalized_chunk_text = str(chunk_text or "").strip()
        if normalized_chunk_text:
            await self._emit(
                "transcript",
                {
                    "phase": "transcribing",
                    "chunk_id": f"stt-chunk-{chunk_idx}",
                    "index": chunk_idx,
                    "total": total,
                    "text": normalized_chunk_text,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "transcription_elapsed_ms": transcription_elapsed_ms,
                        "transcription_eta_ms": transcription_eta_ms,
                        "stt_chunks_completed": chunk_idx,
                        "stt_chunks_total": total,
                    },
                },
            )

    async def _on_provider_fallback(
        self,
        from_provider: str,
        to_provider: str,
        error_message: str,
    ) -> None:
        fallback_record = {
            "from_provider": str(from_provider or "").strip().lower() or "unknown",
            "to_provider": str(to_provider or "").strip().lower() or "unknown",
            "error": str(error_message or "").strip() or "unknown_error",
        }
        fallback_events = self.telemetry.setdefault("stt_provider_fallbacks", [])
        if isinstance(fallback_events, list):
            fallback_events.append(fallback_record)
        await self._emit(
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
                    "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                    "transcription_elapsed_ms": (
                        elapsed_ms(self.transcription_started_at)
                        if self.transcription_started_at is not None
                        else None
                    ),
                },
            },
        )

    # ------------------------------------------------------------------
    # Segmented processing path
    # ------------------------------------------------------------------

    async def _run_segmented(
        self,
        stt_settings: dict[str, Any],
        llm_backend: str,
    ) -> tuple[str, dict[str, Any]]:
        """Interleaved segmented processing — yields progressive nodes per segment."""
        self.active_stage = "segmented_transcribing"
        total_transcript_chars = 0
        total_nodes_generated = 0

        stt_http_url = str(stt_settings.get("http_url", "")).strip()
        if not stt_http_url:
            self._logger.error("[PROCESS FILE] No STT HTTP URL configured for segmented transcription")
            raise ValueError("No STT HTTP URL configured for segmented transcription.")

        self._logger.info(
            "[PROCESS FILE] Starting segmented transcription using STT URL: %s", stt_http_url
        )

        segment_idx = 0
        assert self._transcribe_audio_segmented is not None  # guarded by caller
        async for segment in self._transcribe_audio_segmented(
            file_path=Path(self._temp_path),
            http_url=stt_http_url,
            model=str(stt_settings.get("http_model", "")).strip(),
            language=str(stt_settings.get("http_language", "")).strip(),
            timeout_seconds=float(stt_settings.get("http_timeout_seconds", 120.0) or 120.0),
        ):
            segment_idx += 1
            if await self._request.is_disconnected():
                self._logger.info(
                    "[PROCESS FILE] Client disconnected during segment %d/%d",
                    segment.segment_index,
                    segment.segment_total,
                )
                return "audio", {}

            await self._emit(
                "segment_started",
                {
                    "index": segment.segment_index,
                    "total": segment.segment_total,
                    "start_ms": segment.start_ms,
                    "end_ms": segment.end_ms,
                    "duration_ms": segment.end_ms - segment.start_ms,
                    "telemetry": {"total_elapsed_ms": elapsed_ms(self.pipeline_started_at)},
                },
            )

            stt_progress = calculate_segmented_progress(
                segment.segment_index, segment.segment_total, "transcribing", 1.0
            )
            segment_eta_ms, _ = estimate_segment_eta_ms(
                total_elapsed_ms=elapsed_ms(self.pipeline_started_at),
                segments_completed=segment.segment_index,
                segments_total=segment.segment_total,
            )

            await self._emit(
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
                        "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "segment_elapsed_ms": segment.elapsed_ms,
                        "segment_index": segment.segment_index,
                        "segment_total": segment.segment_total,
                        "stt_chunks_completed": segment.segment_index,
                        "stt_chunks_total": segment.segment_total,
                        "transcription_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "transcription_eta_ms": segment_eta_ms,
                    },
                },
            )

            if segment.metadata.get("stt_backend"):
                self.telemetry["stt_backend"] = segment.metadata.get("stt_backend")

            await self._emit(
                "transcript",
                {
                    "phase": "transcribing",
                    "segment_index": segment.segment_index,
                    "segment_total": segment.segment_total,
                    "text": segment.transcript_text,
                    "telemetry": {"total_elapsed_ms": elapsed_ms(self.pipeline_started_at)},
                },
            )

            self.active_stage = "analyzing"
            segment_chunks = self._chunk_transcript_lines(segment.transcript_text)
            total_transcript_chars += len(segment.transcript_text)

            for chunk_idx, chunk in enumerate(segment_chunks, start=1):
                if await self._request.is_disconnected():
                    return "audio", {}

                analysis_stage_progress = chunk_idx / max(1, len(segment_chunks))
                overall_progress = calculate_segmented_progress(
                    segment.segment_index,
                    segment.segment_total,
                    "analyzing",
                    analysis_stage_progress,
                )

                await self._emit(
                    "status",
                    {
                        "stage": "analyzing",
                        "progress": round(overall_progress, 3),
                        "message": f"Analyzing segment {segment.segment_index}/{segment.segment_total} chunk {chunk_idx}/{len(segment_chunks)}...",
                        "segment_index": segment.segment_index,
                        "segment_total": segment.segment_total,
                        "stt_backend": self.telemetry.get("stt_backend", ""),
                        "llm_backend": llm_backend,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                            "segment_index": segment.segment_index,
                            "segment_total": segment.segment_total,
                        },
                    },
                )

                await self.processor.handle_final_text(chunk)

            nodes_after_segment = await self.processor.flush_segment()
            nodes_this_segment = nodes_after_segment - total_nodes_generated
            total_nodes_generated = nodes_after_segment

            await self._emit(
                "segment_complete",
                {
                    "index": segment.segment_index,
                    "total": segment.segment_total,
                    "nodes_generated": nodes_this_segment,
                    "total_nodes": total_nodes_generated,
                    "elapsed_ms": segment.elapsed_ms,
                    "telemetry": {"total_elapsed_ms": elapsed_ms(self.pipeline_started_at)},
                },
            )

            self._logger.info(
                "[PROCESS FILE] Segment %d/%d complete: %d nodes (+%d this segment)",
                segment.segment_index,
                segment.segment_total,
                total_nodes_generated,
                nodes_this_segment,
            )

        await self.processor.flush()
        self.telemetry["segment_count"] = segment_idx
        self.telemetry["transcript_chars"] = total_transcript_chars
        return "audio", {}

    # ------------------------------------------------------------------
    # Sequential processing path
    # ------------------------------------------------------------------

    async def _run_sequential(
        self,
        stt_settings: dict[str, Any],
        llm_backend: str,
        is_likely_audio: bool,
        resolved_source_type: Optional[str],
    ) -> tuple[str, dict[str, Any]]:
        """Sequential processing — transcribe all then analyze all."""
        transcript_result = await self._transcribe_uploaded_file(
            temp_path=Path(self._temp_path),
            filename=self.filename,
            content_type=self._file.content_type,
            stt_settings=stt_settings,
            provider_override=self._provider,
            source_type_override=resolved_source_type,
            on_chunk_progress=self._on_chunk_progress if is_likely_audio else None,
            on_provider_fallback=self._on_provider_fallback if is_likely_audio else None,
        )

        source_timings = transcript_result.metadata.get("timings_ms", {})
        if isinstance(source_timings, dict):
            self.telemetry["stt_provider_ms"] = source_timings.get("stt_ms")
            self.telemetry["diarization_ms"] = source_timings.get("diarization_ms")
            self.telemetry["alignment_ms"] = source_timings.get("alignment_ms")
        if transcript_result.metadata.get("provider_fallback_used"):
            self.telemetry["stt_provider_fallback_used"] = True
            self.telemetry["stt_provider_fallback_from"] = transcript_result.metadata.get("provider_fallback_from")
            self.telemetry["stt_provider_fallback_to"] = transcript_result.metadata.get("provider_fallback_to")
        if transcript_result.metadata.get("stt_backend"):
            self.telemetry["stt_backend"] = transcript_result.metadata.get("stt_backend")
        if self.transcription_started_at is not None:
            self.telemetry["transcription_ms"] = elapsed_ms(self.transcription_started_at)

        status_message = f"Got {transcript_result.source_type} transcript."
        if transcript_result.source_type == "audio" and transcript_result.metadata.get("provider_fallback_used"):
            fallback_from = transcript_result.metadata.get("provider_fallback_from") or "local"
            fallback_to = transcript_result.metadata.get("provider") or "fallback provider"
            status_message = f"Got audio transcript via fallback ({fallback_from} -> {fallback_to})."

        await self._emit(
            "status",
            {
                "stage": "transcribed",
                "progress": 0.35,
                "message": status_message,
                "source_type": transcript_result.source_type,
                "metadata": transcript_result.metadata,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                    "transcription_ms": self.telemetry.get("transcription_ms"),
                    "stt_provider_ms": self.telemetry.get("stt_provider_ms"),
                    "diarization_ms": self.telemetry.get("diarization_ms"),
                    "alignment_ms": self.telemetry.get("alignment_ms"),
                    "stt_backend": transcript_result.metadata.get("stt_backend"),
                },
            },
        )
        self.active_stage = "chunking"

        transcript_text = transcript_result.transcript_text.strip()
        if not transcript_text:
            raise ValueError("No transcript text could be extracted from file.")

        chunking_started_at = time.perf_counter()
        transcript_chunks = self._chunk_transcript_lines(transcript_text)
        if not transcript_chunks:
            raise ValueError("Transcript parser produced no usable chunks.")
        self.telemetry["chunking_ms"] = elapsed_ms(chunking_started_at)
        self.telemetry["transcript_chars"] = len(transcript_text)
        self.telemetry["transcript_chunk_count"] = len(transcript_chunks)

        self.active_stage = "analyzing"
        await self._emit(
            "status",
            {
                "stage": "analyzing",
                "progress": 0.55,
                "message": f"Generating graph from {len(transcript_chunks)} transcript chunks...",
                "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                "llm_backend": llm_backend,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                    "chunking_ms": self.telemetry.get("chunking_ms"),
                    "transcript_chunk_count": len(transcript_chunks),
                    "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                    "llm_backend": llm_backend,
                },
            },
        )

        for index, chunk in enumerate(transcript_chunks, start=1):
            if await self._request.is_disconnected():
                self._logger.info(
                    "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                    index,
                    len(transcript_chunks),
                )
                return transcript_result.source_type, transcript_result.metadata

            analysis_elapsed_ms = (
                elapsed_ms(self.graph_started_at) if self.graph_started_at is not None else None
            )
            analysis_eta_ms, analysis_estimated_total_ms = estimate_analysis_eta_ms(
                analysis_elapsed_ms=analysis_elapsed_ms,
                chunk_idx=index - 1,
                total_chunks=len(transcript_chunks),
            )
            analysis_progress = 0.55 + (index / len(transcript_chunks)) * 0.40

            await self._emit(
                "status",
                {
                    "stage": "analyzing",
                    "progress": round(analysis_progress, 3),
                    "message": f"Analyzing chunk {index}/{len(transcript_chunks)}...",
                    "stt_backend": self.telemetry.get("stt_backend", ""),
                    "llm_backend": self.telemetry.get("llm_backend", ""),
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "analysis_elapsed_ms": analysis_elapsed_ms,
                        "analysis_eta_ms": analysis_eta_ms,
                        "analysis_estimated_total_ms": analysis_estimated_total_ms,
                        "analysis_chunks_completed": index - 1,
                        "analysis_chunks_total": len(transcript_chunks),
                        "stt_backend": self.telemetry.get("stt_backend", ""),
                        "llm_backend": self.telemetry.get("llm_backend", ""),
                    },
                },
            )

            await self._emit(
                "transcript",
                {
                    "phase": "analyzing",
                    "chunk_id": f"segment-{index}",
                    "index": index,
                    "total": len(transcript_chunks),
                    "text": chunk,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "graph_elapsed_ms": analysis_elapsed_ms,
                        "analysis_eta_ms": analysis_eta_ms,
                    },
                },
            )

            self._logger.info(
                "[PROCESS FILE] Processing chunk %d/%d (eta: %s ms)",
                index,
                len(transcript_chunks),
                analysis_eta_ms,
            )
            await self.processor.handle_final_text(chunk)

        await self.processor.flush()
        return transcript_result.source_type, transcript_result.metadata

    # ------------------------------------------------------------------
    # Post-processing helpers
    # ------------------------------------------------------------------

    async def _persist_graph(
        self,
        final_source_type: str,
        final_source_metadata: dict[str, Any],
    ) -> None:
        """Persist LLM-generated nodes to DB for canvas export."""
        try:
            persisted_count = await persist_import_graph(
                db=self._db,
                conversation_id=self.resolved_conversation_id,
                existing_json=self.processor.existing_json,
                conversation_name=Path(self.filename).stem or "Imported conversation",
                source_type=final_source_type,
                source_metadata=(
                    final_source_metadata if isinstance(final_source_metadata, dict) else {}
                ),
            )
            self._logger.info(
                "[PROCESS FILE] Persisted %d nodes to DB for %s",
                persisted_count,
                self.resolved_conversation_id,
            )
            self.telemetry["graph_persisted_nodes"] = persisted_count
        except Exception as persist_exc:  # noqa: BLE001
            self._logger.warning(
                "[PROCESS FILE] Graph persistence failed (non-fatal): %s", persist_exc
            )
            self.telemetry["graph_persist_error"] = str(persist_exc) or type(persist_exc).__name__

    async def _enqueue_diarization(
        self,
        final_source_type: str,
        final_source_metadata: dict[str, Any],
        stt_settings: dict[str, Any],
        llm_config: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        """Enqueue async diarization job if enabled. Returns job payload or None."""
        if final_source_type != "audio" or not self._is_async_import_diarization_enabled():
            return None

        async_audio_copy = None
        try:
            async_audio_copy = self._copy_temp_upload_for_async_job(
                Path(self._temp_path), suffix=self.suffix
            )
            job_snapshot = await self._enqueue_import_diarization_job(
                audio_path=async_audio_copy,
                filename=self.filename,
                content_type=self._file.content_type,
                source_type_override=self._source_type if self._source_type != "auto" else None,
                provider_override=self._provider,
                conversation_id=self.resolved_conversation_id,
                speaker_id=self.resolved_speaker_id,
                stt_settings=stt_settings,
                llm_config=llm_config,
                source_metadata=final_source_metadata,
            )
            job_id = str(job_snapshot["job_id"])
            self.telemetry["async_diarization_job_id"] = job_id
            diarization_job_payload = {
                "id": job_id,
                "status": job_snapshot.get("status"),
                **self._build_diarization_job_urls(job_id),
            }
            await self._emit(
                "status",
                {
                    "stage": "queued",
                    "progress": 0.98,
                    "message": "Queued background diarization job.",
                    "diarization_job": diarization_job_payload,
                    "telemetry": {"total_elapsed_ms": elapsed_ms(self.pipeline_started_at)},
                },
            )
            return diarization_job_payload
        except Exception as exc:  # noqa: BLE001
            if async_audio_copy is not None:
                self._cleanup_temp_file(str(async_audio_copy))
            enqueue_error = str(exc) or type(exc).__name__
            self.telemetry["async_diarization_enqueue_error"] = enqueue_error
            self._logger.warning(
                "Failed to enqueue async diarization job for %s: %s",
                self.filename,
                enqueue_error,
            )
            return None

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Execute the full bulk import pipeline and emit SSE payloads."""
        self._logger.info(
            "[PROCESS FILE] Starting pipeline for %s (%d bytes, source_type=%s, provider=%s)",
            self.filename,
            self._content_size,
            self._source_type,
            self._provider or "auto",
        )

        try:
            await self._emit(
                "status",
                {
                    "stage": "uploading",
                    "progress": 0.05,
                    "message": f"File received ({self._content_size} bytes)",
                    "file_name": self.filename,
                    "telemetry": {"total_elapsed_ms": elapsed_ms(self.pipeline_started_at)},
                },
            )

            stt_settings = await self._load_stt_settings(self._db)

            stt_http_url = str(stt_settings.get("http_url", "")).strip()
            if "modal" in stt_http_url.lower():
                stt_backend = "modal_whisperx"
            elif "127.0.0.1" in stt_http_url or "localhost" in stt_http_url:
                stt_backend = "local_whisperx"
            else:
                stt_backend = "whisperx"
            self.telemetry["stt_backend"] = stt_backend

            resolved_source_type = self._source_type if self._source_type != "auto" else None
            is_likely_audio = (
                resolved_source_type == "audio"
                or (resolved_source_type is None and self.suffix in _AUDIO_SUFFIXES)
            )
            self.active_stage = "transcribing" if is_likely_audio else "parsing"
            self.telemetry["is_likely_audio"] = is_likely_audio
            self.telemetry["source_type_override"] = resolved_source_type or "auto"

            audio_duration_ms: Optional[float] = None
            if is_likely_audio:
                audio_duration_ms = get_audio_duration_ms(Path(self._temp_path))
                self.telemetry["audio_duration_ms"] = audio_duration_ms

            duration_str = format_duration_for_display(audio_duration_ms)
            if is_likely_audio and duration_str:
                transcribe_msg = f"Transcribing {duration_str} of audio..."
            elif is_likely_audio:
                transcribe_msg = "Transcribing audio..."
            else:
                transcribe_msg = "Extracting transcript text..."

            await self._emit(
                "status",
                {
                    "stage": "transcribing" if is_likely_audio else "parsing",
                    "progress": 0.10,
                    "message": transcribe_msg,
                    "stt_backend": stt_backend if is_likely_audio else "",
                    "audio_duration_ms": audio_duration_ms,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
                        "stt_backend": stt_backend if is_likely_audio else "",
                        "audio_duration_ms": audio_duration_ms,
                    },
                },
            )
            self.transcription_started_at = time.perf_counter()

            use_segmented_processing = (
                is_likely_audio
                and self._transcribe_audio_segmented is not None
                and (
                    SEGMENT_PROCESSING_FORCE_ENABLED
                    or self._content_size > SEGMENT_PROCESSING_THRESHOLD_BYTES
                )
            )
            self.telemetry["segmented_processing"] = use_segmented_processing

            if use_segmented_processing:
                self._logger.info(
                    "[PROCESS FILE] Using interleaved segmented processing for %s (%d bytes, threshold=%d)",
                    self.filename,
                    self._content_size,
                    SEGMENT_PROCESSING_THRESHOLD_BYTES,
                )
            else:
                self._logger.info(
                    "[PROCESS FILE] Using sequential processing for %s (%d bytes, is_audio=%s, segmented_fn=%s)",
                    self.filename,
                    self._content_size,
                    is_likely_audio,
                    self._transcribe_audio_segmented is not None,
                )

            llm_config = await self._load_llm_config(self._db)
            llm_providers = None
            if self._load_llm_providers:
                llm_providers_config = await self._load_llm_providers(self._db)
                llm_providers = llm_providers_config.get("providers")

            llm_base_url = str(llm_config.get("base_url", "")).strip()
            llm_model = str(llm_config.get("chat_model", "")).strip()
            is_modal_llm = "modal.run" in llm_base_url
            llm_backend = f"modal_{llm_model}" if is_modal_llm else f"local_{llm_model}"
            self.telemetry["llm_backend"] = llm_backend

            self.processor = self._transcript_processor_cls(
                send_update=self._send_update,
                send_status=self._send_status,
                llm_config=llm_config,
                providers=llm_providers,
            )
            self.graph_started_at = time.perf_counter()

            if use_segmented_processing:
                final_source_type, final_source_metadata = await self._run_segmented(
                    stt_settings, llm_backend
                )
            else:
                final_source_type, final_source_metadata = await self._run_sequential(
                    stt_settings, llm_backend, is_likely_audio, resolved_source_type
                )

            await self._persist_graph(final_source_type, final_source_metadata)

            self.telemetry["graph_generation_ms"] = (
                elapsed_ms(self.graph_started_at) if self.graph_started_at is not None else None
            )
            self.telemetry["total_processing_ms"] = elapsed_ms(self.pipeline_started_at)
            self.telemetry["source_type"] = final_source_type
            self.telemetry["source_metadata"] = final_source_metadata
            self.telemetry["node_count"] = len(self.processor.existing_json)
            self.telemetry["chunk_count"] = len(self.processor.chunk_dict)
            attach_bottleneck_stage(self.telemetry)

            self._logger.info(
                "[PROCESS FILE TELEMETRY] %s",
                json.dumps(self.telemetry, ensure_ascii=False, sort_keys=True),
            )

            diarization_job_payload = await self._enqueue_diarization(
                final_source_type, final_source_metadata, stt_settings, llm_config
            )

            await self._emit(
                "done",
                {
                    "conversation_id": self.resolved_conversation_id,
                    "speaker_id": self.resolved_speaker_id,
                    "node_count": len(self.processor.existing_json),
                    "chunk_count": len(self.processor.chunk_dict),
                    "source_type": final_source_type,
                    "telemetry": self.telemetry,
                    "diarization_job": diarization_job_payload,
                },
            )

        except Exception as exc:  # noqa: BLE001
            self._logger.exception("Bulk file processing failed for %s", self.filename)
            err_msg = str(exc) or f"{type(exc).__name__}"
            error_telemetry = {
                **self.telemetry,
                "active_stage": self.active_stage,
                "total_elapsed_ms": elapsed_ms(self.pipeline_started_at),
            }
            await self._emit(
                "error",
                {
                    "message": err_msg,
                    "file_name": self.filename,
                    "telemetry": error_telemetry,
                },
            )

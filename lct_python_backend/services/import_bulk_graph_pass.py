"""Sequential and segmented transcription+graph passes for bulk import.

Extracted from import_bulk_pipeline.py so the worker orchestrator stays thin.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_checkpoint_flow import persist_chunk_checkpoint_safe
from lct_python_backend.services.import_bulk_helpers import (
    SEGMENT_PROCESSING_FORCE_ENABLED,
    SEGMENT_PROCESSING_THRESHOLD_BYTES,
)
from lct_python_backend.services.import_bulk_stage_events import ImportBulkStageEvents
from lct_python_backend.services.import_bulk_telemetry import (
    calculate_segmented_progress,
    elapsed_ms,
    estimate_analysis_eta_ms,
    estimate_segment_eta_ms,
    estimate_transcription_eta_ms,
    record_transcription_timing,
)
from lct_python_backend.services.transcript_linearization import build_line_utterances

PROGRESSIVE_BATCH_CHARS = 400


@dataclass
class GraphPassResult:
    """Outputs from either the segmented or sequential graph pass."""

    final_source_type: str
    final_source_metadata: dict[str, Any] = field(default_factory=dict)
    final_source_utterances: list[dict[str, Any]] = field(default_factory=list)
    final_speaker_segments: list[dict[str, Any]] = field(default_factory=list)
    final_transcript_text: str = ""
    active_stage: str = "analyzing"
    early_exit: bool = False


def should_use_segmented_processing(
    *,
    is_likely_audio: bool,
    content_size: int,
    transcribe_audio_segmented: Optional[Callable[..., AsyncGenerator[Any, None]]],
    primary_import_candidate: Optional[dict[str, Any]],
) -> bool:
    """Return True when interleaved segment-by-segment processing should run."""
    return bool(
        is_likely_audio
        and transcribe_audio_segmented is not None
        and (
            SEGMENT_PROCESSING_FORCE_ENABLED
            or content_size > SEGMENT_PROCESSING_THRESHOLD_BYTES
        )
        and (
            not isinstance(primary_import_candidate, dict)
            or str(primary_import_candidate.get("transport") or "backend_http")
            .strip()
            .lower()
            == "backend_http"
        )
    )


class ProgressiveChunkHandlers:
    """Checkpoint + progressive graph callbacks for sequential STT chunk streaming."""

    def __init__(
        self,
        *,
        stage_events: ImportBulkStageEvents,
        telemetry: dict[str, Any],
        db: AsyncSession,
        file_hash: Optional[str],
        conversation_id: str,
        filename: str,
        content_size: int,
        checkpoint_transcript_parts: list[str],
        progressive_processor_ref: list[Any],
        transcription_started_at: Optional[float],
        log: logging.Logger,
    ) -> None:
        self._stage_events = stage_events
        self._telemetry = telemetry
        self._db = db
        self._file_hash = file_hash
        self._conversation_id = conversation_id
        self._filename = filename
        self._content_size = content_size
        self._checkpoint_transcript_parts = checkpoint_transcript_parts
        self._progressive_processor_ref = progressive_processor_ref
        self._transcription_started_at = transcription_started_at
        self._log = log
        self._buffer: list[str] = []
        self._buffer_chars = 0

    async def flush(self) -> None:
        if not self._progressive_processor_ref or not self._buffer:
            return
        batch_text = "\n".join(self._buffer)
        self._buffer.clear()
        self._buffer_chars = 0
        try:
            await self._progressive_processor_ref[0].handle_final_text(batch_text)
        except Exception as exc:  # noqa: BLE001
            self._log.warning(
                "[PROCESS FILE] Progressive graph gen failed (non-fatal): %s",
                exc,
            )

    async def on_chunk_progress(self, chunk_idx: int, total: int, chunk_text: str) -> None:
        frac = chunk_idx / total
        progress = 0.10 + frac * (0.75 if self._progressive_processor_ref else 0.25)
        self._telemetry["stt_chunks_completed"] = chunk_idx
        self._telemetry["stt_chunks_total"] = total
        transcription_elapsed_ms = (
            elapsed_ms(self._transcription_started_at)
            if self._transcription_started_at is not None
            else None
        )
        transcription_eta_ms, transcription_estimated_total_ms = estimate_transcription_eta_ms(
            transcription_elapsed_ms=transcription_elapsed_ms,
            chunk_idx=chunk_idx,
            total_chunks=total,
        )
        normalized_chunk_text = str(chunk_text or "").strip()
        await self._stage_events.emit_chunk_progress(
            chunk_idx=chunk_idx,
            total=total,
            progress=progress,
            normalized_chunk_text=normalized_chunk_text,
            transcription_elapsed_ms=transcription_elapsed_ms,
            transcription_eta_ms=transcription_eta_ms,
            transcription_estimated_total_ms=transcription_estimated_total_ms,
        )
        if not normalized_chunk_text:
            return

        self._checkpoint_transcript_parts.append(normalized_chunk_text)
        self._telemetry["checkpoint_chunks"] = len(self._checkpoint_transcript_parts)
        self._telemetry["checkpoint_total_chunks"] = total
        self._telemetry["resume_available"] = True

        await persist_chunk_checkpoint_safe(
            self._db,
            file_hash=self._file_hash,
            conversation_id=self._conversation_id,
            chunk_index=chunk_idx,
            total_chunks=total,
            chunk_text=normalized_chunk_text,
            accumulated_transcript="\n".join(self._checkpoint_transcript_parts),
            stt_backend=self._telemetry.get("stt_backend", ""),
            elapsed_ms=transcription_elapsed_ms or 0,
            file_name=self._filename,
            file_size_bytes=self._content_size,
            log=self._log,
        )

        if self._progressive_processor_ref:
            self._buffer.append(normalized_chunk_text)
            self._buffer_chars += len(normalized_chunk_text)
            if self._buffer_chars >= PROGRESSIVE_BATCH_CHARS:
                await self.flush()

    async def on_provider_fallback(
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
        fallback_events = self._telemetry.setdefault("stt_provider_fallbacks", [])
        if isinstance(fallback_events, list):
            fallback_events.append(fallback_record)
        await self._stage_events.emit_provider_fallback(
            fallback_record,
            transcription_elapsed_ms=(
                elapsed_ms(self._transcription_started_at)
                if self._transcription_started_at is not None
                else None
            ),
        )


async def run_segmented_graph_pass(
    *,
    request: Request,
    temp_path: str,
    runtime_stt_settings: dict[str, Any],
    transcribe_audio_segmented: Callable[..., AsyncGenerator[Any, None]],
    resume_from_chunk: int,
    checkpoint_transcript_parts: list[str],
    file_hash: Optional[str],
    conversation_id: str,
    filename: str,
    content_size: int,
    db: AsyncSession,
    stage_events: ImportBulkStageEvents,
    telemetry: dict[str, Any],
    pipeline_started_at: float,
    transcription_started_at: Optional[float],
    audio_duration_ms: Optional[float],
    stt_backend: str,
    processor: Any,
    llm_backend: str,
    chunk_transcript_lines: Callable[[str], list[str]],
    log: logging.Logger,
) -> GraphPassResult:
    """Interleaved segment transcription + per-segment graph analysis."""
    active_stage = "segmented_transcribing"
    total_transcript_chars = 0
    total_nodes_generated = 0
    segmented_transcript_parts: list[str] = list(checkpoint_transcript_parts)

    stt_http_url = str(runtime_stt_settings.get("http_url", "")).strip()
    if not stt_http_url:
        log.error("[PROCESS FILE] No STT HTTP URL configured for segmented transcription")
        raise ValueError("No STT HTTP URL configured for segmented transcription.")

    log.info(
        "[PROCESS FILE] Starting segmented transcription using STT URL: %s",
        stt_http_url,
    )

    segment_idx = 0
    accumulated_utterances: list[dict[str, Any]] = []
    async for segment in transcribe_audio_segmented(
        file_path=Path(temp_path),
        http_url=stt_http_url,
        model=str(runtime_stt_settings.get("http_model", "")).strip(),
        language=str(runtime_stt_settings.get("http_language", "")).strip(),
        timeout_seconds=float(runtime_stt_settings.get("http_timeout_seconds", 120.0) or 120.0),
        resume_from_segment=resume_from_chunk,
        resumed_segment_texts=checkpoint_transcript_parts if resume_from_chunk > 0 else None,
    ):
        segment_idx += 1
        if await request.is_disconnected():
            log.info(
                "[PROCESS FILE] Client disconnected during segment %d/%d",
                segment.segment_index,
                segment.segment_total,
            )
            return GraphPassResult(
                final_source_type="audio",
                active_stage=active_stage,
                early_exit=True,
            )

        await stage_events.emit_segment_started(
            segment_index=segment.segment_index,
            segment_total=segment.segment_total,
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
        )

        stt_progress = calculate_segmented_progress(
            segment.segment_index,
            segment.segment_total,
            "transcribing",
            1.0,
        )
        segment_eta_ms, _segment_estimated_total_ms = estimate_segment_eta_ms(
            total_elapsed_ms=elapsed_ms(pipeline_started_at),
            segments_completed=segment.segment_index,
            segments_total=segment.segment_total,
        )
        await stage_events.emit_segment_transcribed(
            segment_index=segment.segment_index,
            segment_total=segment.segment_total,
            stt_progress=stt_progress,
            segment_elapsed_ms=segment.elapsed_ms,
            segment_eta_ms=segment_eta_ms,
            llm_backend=llm_backend,
            segment_stt_backend=str(segment.metadata.get("stt_backend") or ""),
        )

        if segment.metadata.get("stt_backend"):
            telemetry["stt_backend"] = segment.metadata.get("stt_backend")

        is_resumed_segment = bool(segment.metadata.get("resumed"))
        normalized_segment_text = str(segment.transcript_text or "").strip()
        if normalized_segment_text and not is_resumed_segment:
            segmented_transcript_parts.append(normalized_segment_text)
        await stage_events.emit_segment_transcript(
            segment_index=segment.segment_index,
            segment_total=segment.segment_total,
            transcript_text=segment.transcript_text,
            resumed=is_resumed_segment,
        )

        if not is_resumed_segment:
            await persist_chunk_checkpoint_safe(
                db,
                file_hash=file_hash,
                conversation_id=conversation_id,
                chunk_index=segment.segment_index,
                total_chunks=segment.segment_total,
                chunk_text=normalized_segment_text,
                accumulated_transcript="\n".join(segmented_transcript_parts),
                stt_backend=telemetry.get("stt_backend", ""),
                elapsed_ms=elapsed_ms(pipeline_started_at) or 0,
                file_name=filename,
                file_size_bytes=content_size,
                log=log,
                failure_label="Segment checkpoint save",
            )

        active_stage = "analyzing"
        segment_chunks = chunk_transcript_lines(segment.transcript_text)
        total_transcript_chars += len(segment.transcript_text)
        segment_utterances = build_line_utterances(
            segment.transcript_text,
            default_speaker_id="SPEAKER_00",
            window_start_s=float(segment.start_ms) / 1000.0,
            window_end_s=float(segment.end_ms) / 1000.0,
            start_sequence=len(accumulated_utterances) + 1,
            source_label="segmented_import_window",
        )
        accumulated_utterances.extend(segment_utterances)

        for chunk_idx, chunk in enumerate(segment_chunks, start=1):
            if await request.is_disconnected():
                return GraphPassResult(
                    final_source_type="audio",
                    active_stage=active_stage,
                )

            analysis_stage_progress = chunk_idx / max(1, len(segment_chunks))
            overall_progress = calculate_segmented_progress(
                segment.segment_index,
                segment.segment_total,
                "analyzing",
                analysis_stage_progress,
            )

            await stage_events.emit_segment_analyzing(
                segment_index=segment.segment_index,
                segment_total=segment.segment_total,
                chunk_idx=chunk_idx,
                chunk_total=len(segment_chunks),
                overall_progress=overall_progress,
                llm_backend=llm_backend,
            )

            await processor.handle_final_text(chunk)

        nodes_after_segment = await processor.flush_segment()
        nodes_this_segment = nodes_after_segment - total_nodes_generated
        total_nodes_generated = nodes_after_segment

        await stage_events.emit_segment_complete(
            segment_index=segment.segment_index,
            segment_total=segment.segment_total,
            nodes_generated=nodes_this_segment,
            total_nodes=total_nodes_generated,
            segment_elapsed_ms=segment.elapsed_ms,
        )

        log.info(
            "[PROCESS FILE] Segment %d/%d complete: %d nodes (+%d this segment)",
            segment.segment_index,
            segment.segment_total,
            total_nodes_generated,
            nodes_this_segment,
        )

    await processor.flush()
    telemetry["segment_count"] = segment_idx
    telemetry["transcript_chars"] = total_transcript_chars
    if transcription_started_at is not None and audio_duration_ms and stt_backend:
        record_transcription_timing(
            stt_backend=stt_backend,
            audio_duration_ms=audio_duration_ms,
            transcription_ms=elapsed_ms(transcription_started_at),
        )

    return GraphPassResult(
        final_source_type="audio",
        final_source_utterances=accumulated_utterances,
        final_transcript_text="\n".join(segmented_transcript_parts).strip(),
        active_stage=active_stage,
    )


async def run_sequential_graph_pass(
    *,
    request: Request,
    file: UploadFile,
    temp_path: str,
    filename: str,
    resolved_source_type: Optional[str],
    provider_override: Optional[str],
    runtime_stt_settings: dict[str, Any],
    is_likely_audio: bool,
    resume_from_chunk: int,
    checkpoint_transcript_parts: list[str],
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
    progressive_handlers: ProgressiveChunkHandlers,
    processor: Any,
    llm_backend: str,
    chunk_transcript_lines: Callable[[str], list[str]],
    stage_events: ImportBulkStageEvents,
    emit: Callable[[str, dict[str, Any]], Awaitable[None]],
    telemetry: dict[str, Any],
    pipeline_started_at: float,
    transcription_started_at: Optional[float],
    graph_started_at: Optional[float],
    audio_duration_ms: Optional[float],
) -> GraphPassResult:
    """Transcribe the full upload, then analyze transcript chunks (with optional progressive STT)."""
    transcript_result = await transcribe_uploaded_file(
        temp_path=Path(temp_path),
        filename=filename,
        content_type=file.content_type,
        stt_settings=runtime_stt_settings,
        provider_override=provider_override,
        source_type_override=resolved_source_type,
        on_chunk_progress=progressive_handlers.on_chunk_progress if is_likely_audio else None,
        on_provider_fallback=progressive_handlers.on_provider_fallback if is_likely_audio else None,
        resume_from_chunk=resume_from_chunk,
        resumed_chunk_texts=checkpoint_transcript_parts if resume_from_chunk > 0 else None,
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
    if transcript_result.metadata.get("stt_backend"):
        telemetry["stt_backend"] = transcript_result.metadata.get("stt_backend")
    if transcription_started_at is not None:
        telemetry["transcription_ms"] = elapsed_ms(transcription_started_at)
        if audio_duration_ms and telemetry.get("stt_backend"):
            record_transcription_timing(
                stt_backend=telemetry["stt_backend"],
                audio_duration_ms=audio_duration_ms,
                transcription_ms=telemetry["transcription_ms"],
            )

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
    final_source_utterances = list(getattr(transcript_result, "utterances", []) or [])
    final_speaker_segments = list(getattr(transcript_result, "speaker_segments", []) or [])

    transcript_text = transcript_result.transcript_text.strip()
    if not transcript_text:
        raise ValueError("No transcript text could be extracted from file.")

    await progressive_handlers.flush()
    progressive_nodes = len(processor.existing_json) if hasattr(processor, "existing_json") else 0

    chunking_started_at = time.perf_counter()
    transcript_chunks = chunk_transcript_lines(transcript_text)
    if not transcript_chunks:
        raise ValueError("Transcript parser produced no usable chunks.")
    telemetry["chunking_ms"] = elapsed_ms(chunking_started_at)
    telemetry["transcript_chars"] = len(transcript_text)
    telemetry["transcript_chunk_count"] = len(transcript_chunks)
    telemetry["progressive_nodes"] = progressive_nodes

    if progressive_nodes > 0:
        log = logging.getLogger(__name__)
        log.info(
            "[PROCESS FILE] Progressive generation produced %d nodes during STT. "
            "Flushing final batch (skipping redundant re-analysis).",
            progressive_nodes,
        )
        active_stage = "analyzing"
        await emit(
            "status",
            {
                "stage": "analyzing",
                "progress": 0.90,
                "message": f"Finalizing graph ({progressive_nodes} nodes from progressive analysis)...",
                "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                "llm_backend": llm_backend,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                    "progressive_nodes": progressive_nodes,
                    "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                    "llm_backend": llm_backend,
                },
            },
        )
        await processor.flush()
    else:
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
        if progressive_nodes > 0:
            break

        if await request.is_disconnected():
            log = logging.getLogger(__name__)
            log.info(
                "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                index,
                len(transcript_chunks),
            )
            return GraphPassResult(
                final_source_type=transcript_result.source_type,
                final_source_metadata=transcript_result.metadata,
                final_source_utterances=final_source_utterances,
                final_speaker_segments=final_speaker_segments,
                final_transcript_text=transcript_text,
                active_stage=active_stage,
                early_exit=True,
            )

        analysis_elapsed_ms = (
            elapsed_ms(graph_started_at) if graph_started_at is not None else None
        )
        analysis_eta_ms, analysis_estimated_total_ms = estimate_analysis_eta_ms(
            analysis_elapsed_ms=analysis_elapsed_ms,
            chunk_idx=index - 1,
            total_chunks=len(transcript_chunks),
        )
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

        log = logging.getLogger(__name__)
        log.info(
            "[PROCESS FILE] Processing chunk %d/%d (eta: %s ms)",
            index,
            len(transcript_chunks),
            analysis_eta_ms,
        )
        await processor.handle_final_text(chunk)

    await processor.flush()

    return GraphPassResult(
        final_source_type=transcript_result.source_type,
        final_source_metadata=transcript_result.metadata,
        final_source_utterances=final_source_utterances,
        final_speaker_segments=final_speaker_segments,
        final_transcript_text=transcript_text,
        active_stage=active_stage,
    )
"""Segmented transcription+analysis path for the bulk import pipeline.

Processes each natural audio segment through the full pipeline so users
see nodes appearing progressively rather than waiting for the entire file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncGenerator, Callable

from fastapi import Request

from lct_python_backend.services.import_bulk_telemetry import (
    calculate_segmented_progress,
    elapsed_ms,
    estimate_segment_eta_ms,
)
from lct_python_backend.services.import_pipeline_context import PipelineContext


async def run_segmented_path(
    ctx: PipelineContext,
    processor: Any,
    request: Request,
    stt_settings: dict[str, Any],
    transcribe_audio_segmented: Callable[..., AsyncGenerator[Any, None]],
    chunk_transcript_lines: Callable[[str], list[str]],
    llm_backend: str,
    temp_path: str,
) -> tuple[int, int]:
    """Execute the interleaved segmented transcription+analysis path.

    Returns:
        (segment_count, total_transcript_chars)
    """
    ctx.active_stage = "segmented_transcribing"
    total_transcript_chars = 0
    total_nodes_generated = 0

    stt_http_url = str(stt_settings.get("http_url", "")).strip()
    if not stt_http_url:
        ctx.logger.error("[PROCESS FILE] No STT HTTP URL configured for segmented transcription")
        raise ValueError("No STT HTTP URL configured for segmented transcription.")

    ctx.logger.info(
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
            ctx.logger.info(
                "[PROCESS FILE] Client disconnected during segment %d/%d",
                segment.segment_index,
                segment.segment_total,
            )
            return segment_idx, total_transcript_chars

        await ctx.emit(
            "segment_started",
            {
                "index": segment.segment_index,
                "total": segment.segment_total,
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "duration_ms": segment.end_ms - segment.start_ms,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                },
            },
        )

        stt_progress = calculate_segmented_progress(
            segment.segment_index,
            segment.segment_total,
            "transcribing",
            1.0,
        )
        segment_eta_ms, _segment_estimated_total_ms = estimate_segment_eta_ms(
            total_elapsed_ms=elapsed_ms(ctx.pipeline_started_at),
            segments_completed=segment.segment_index,
            segments_total=segment.segment_total,
        )

        await ctx.emit(
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
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                    "segment_elapsed_ms": segment.elapsed_ms,
                    "segment_index": segment.segment_index,
                    "segment_total": segment.segment_total,
                    # Compatibility keys for frontend ETA calculation
                    "stt_chunks_completed": segment.segment_index,
                    "stt_chunks_total": segment.segment_total,
                    "transcription_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                    "transcription_eta_ms": segment_eta_ms,
                },
            },
        )

        if segment.metadata.get("stt_backend"):
            ctx.telemetry["stt_backend"] = segment.metadata.get("stt_backend")

        await ctx.emit(
            "transcript",
            {
                "phase": "transcribing",
                "segment_index": segment.segment_index,
                "segment_total": segment.segment_total,
                "text": segment.transcript_text,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                },
            },
        )

        ctx.active_stage = "analyzing"
        segment_chunks = chunk_transcript_lines(segment.transcript_text)
        total_transcript_chars += len(segment.transcript_text)

        for chunk_idx, chunk in enumerate(segment_chunks, start=1):
            if await request.is_disconnected():
                return segment_idx, total_transcript_chars

            analysis_stage_progress = chunk_idx / max(1, len(segment_chunks))
            overall_progress = calculate_segmented_progress(
                segment.segment_index,
                segment.segment_total,
                "analyzing",
                analysis_stage_progress,
            )

            await ctx.emit(
                "status",
                {
                    "stage": "analyzing",
                    "progress": round(overall_progress, 3),
                    "message": (
                        f"Analyzing segment {segment.segment_index}/{segment.segment_total}"
                        f" chunk {chunk_idx}/{len(segment_chunks)}..."
                    ),
                    "segment_index": segment.segment_index,
                    "segment_total": segment.segment_total,
                    "stt_backend": ctx.telemetry.get("stt_backend", ""),
                    "llm_backend": llm_backend,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                        "segment_index": segment.segment_index,
                        "segment_total": segment.segment_total,
                    },
                },
            )

            await processor.handle_final_text(chunk)

        nodes_after_segment = await processor.flush_segment()
        nodes_this_segment = nodes_after_segment - total_nodes_generated
        total_nodes_generated = nodes_after_segment

        await ctx.emit(
            "segment_complete",
            {
                "index": segment.segment_index,
                "total": segment.segment_total,
                "nodes_generated": nodes_this_segment,
                "total_nodes": total_nodes_generated,
                "elapsed_ms": segment.elapsed_ms,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                },
            },
        )

        ctx.logger.info(
            "[PROCESS FILE] Segment %d/%d complete: %d nodes (+%d this segment)",
            segment.segment_index,
            segment.segment_total,
            total_nodes_generated,
            nodes_this_segment,
        )

    # Final flush after all segments
    await processor.flush()
    return segment_idx, total_transcript_chars

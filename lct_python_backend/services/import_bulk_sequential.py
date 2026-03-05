"""Sequential (whole-file) transcription+analysis path for the bulk import pipeline.

Transcribes the entire file first, then analyzes all chunks at once.
Used for small files and non-audio content.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import Request

from lct_python_backend.services.import_bulk_telemetry import (
    elapsed_ms,
    estimate_analysis_eta_ms,
)
from lct_python_backend.services.import_pipeline_context import PipelineContext


async def run_sequential_path(
    ctx: PipelineContext,
    processor: Any,
    request: Request,
    transcribe_uploaded_file: Callable[..., Any],
    stt_settings: dict[str, Any],
    provider: Optional[str],
    resolved_source_type: Optional[str],
    filename: str,
    content_type: Optional[str],
    chunk_transcript_lines: Callable[[str], list[str]],
    llm_backend: str,
    is_likely_audio: bool,
    temp_path: str,
) -> tuple[str, dict[str, Any]]:
    """Execute the sequential transcription+analysis path.

    Returns:
        (final_source_type, final_source_metadata)
    """
    transcript_result = await transcribe_uploaded_file(
        temp_path=Path(temp_path),
        filename=filename,
        content_type=content_type,
        stt_settings=stt_settings,
        provider_override=provider,
        source_type_override=resolved_source_type,
        on_chunk_progress=ctx.on_chunk_progress if is_likely_audio else None,
        on_provider_fallback=ctx.on_provider_fallback if is_likely_audio else None,
    )

    source_timings = transcript_result.metadata.get("timings_ms", {})
    if isinstance(source_timings, dict):
        ctx.telemetry["stt_provider_ms"] = source_timings.get("stt_ms")
        ctx.telemetry["diarization_ms"] = source_timings.get("diarization_ms")
        ctx.telemetry["alignment_ms"] = source_timings.get("alignment_ms")
    if transcript_result.metadata.get("provider_fallback_used"):
        ctx.telemetry["stt_provider_fallback_used"] = True
        ctx.telemetry["stt_provider_fallback_from"] = transcript_result.metadata.get("provider_fallback_from")
        ctx.telemetry["stt_provider_fallback_to"] = transcript_result.metadata.get("provider_fallback_to")
    if transcript_result.metadata.get("stt_backend"):
        ctx.telemetry["stt_backend"] = transcript_result.metadata.get("stt_backend")
    if ctx.transcription_started_at is not None:
        ctx.telemetry["transcription_ms"] = elapsed_ms(ctx.transcription_started_at)

    status_message = f"Got {transcript_result.source_type} transcript."
    if transcript_result.source_type == "audio" and transcript_result.metadata.get("provider_fallback_used"):
        fallback_from = transcript_result.metadata.get("provider_fallback_from") or "local"
        fallback_to = transcript_result.metadata.get("provider") or "fallback provider"
        status_message = f"Got audio transcript via fallback ({fallback_from} -> {fallback_to})."

    await ctx.emit(
        "status",
        {
            "stage": "transcribed",
            "progress": 0.35,
            "message": status_message,
            "source_type": transcript_result.source_type,
            "metadata": transcript_result.metadata,
            "telemetry": {
                "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                "transcription_ms": ctx.telemetry.get("transcription_ms"),
                "stt_provider_ms": ctx.telemetry.get("stt_provider_ms"),
                "diarization_ms": ctx.telemetry.get("diarization_ms"),
                "alignment_ms": ctx.telemetry.get("alignment_ms"),
                "stt_backend": transcript_result.metadata.get("stt_backend"),
            },
        },
    )
    ctx.active_stage = "chunking"

    transcript_text = transcript_result.transcript_text.strip()
    if not transcript_text:
        raise ValueError("No transcript text could be extracted from file.")

    chunking_started_at = time.perf_counter()
    transcript_chunks = chunk_transcript_lines(transcript_text)
    if not transcript_chunks:
        raise ValueError("Transcript parser produced no usable chunks.")
    ctx.telemetry["chunking_ms"] = elapsed_ms(chunking_started_at)
    ctx.telemetry["transcript_chars"] = len(transcript_text)
    ctx.telemetry["transcript_chunk_count"] = len(transcript_chunks)

    ctx.active_stage = "analyzing"
    await ctx.emit(
        "status",
        {
            "stage": "analyzing",
            "progress": 0.55,
            "message": f"Generating graph from {len(transcript_chunks)} transcript chunks...",
            "stt_backend": transcript_result.metadata.get("stt_backend", ""),
            "llm_backend": llm_backend,
            "telemetry": {
                "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                "chunking_ms": ctx.telemetry.get("chunking_ms"),
                "transcript_chunk_count": len(transcript_chunks),
                "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                "llm_backend": llm_backend,
            },
        },
    )

    for index, chunk in enumerate(transcript_chunks, start=1):
        if await request.is_disconnected():
            ctx.logger.info(
                "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                index,
                len(transcript_chunks),
            )
            return transcript_result.source_type, transcript_result.metadata

        analysis_elapsed_ms = (
            elapsed_ms(ctx.graph_started_at) if ctx.graph_started_at is not None else None
        )
        analysis_eta_ms, analysis_estimated_total_ms = estimate_analysis_eta_ms(
            analysis_elapsed_ms=analysis_elapsed_ms,
            chunk_idx=index - 1,  # Use completed chunks for ETA
            total_chunks=len(transcript_chunks),
        )

        # Calculate progress within analysis phase (0.55 to 0.95)
        analysis_progress = 0.55 + (index / len(transcript_chunks)) * 0.40

        await ctx.emit(
            "status",
            {
                "stage": "analyzing",
                "progress": round(analysis_progress, 3),
                "message": f"Analyzing chunk {index}/{len(transcript_chunks)}...",
                "stt_backend": ctx.telemetry.get("stt_backend", ""),
                "llm_backend": ctx.telemetry.get("llm_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                    "analysis_elapsed_ms": analysis_elapsed_ms,
                    "analysis_eta_ms": analysis_eta_ms,
                    "analysis_estimated_total_ms": analysis_estimated_total_ms,
                    "analysis_chunks_completed": index - 1,
                    "analysis_chunks_total": len(transcript_chunks),
                    "stt_backend": ctx.telemetry.get("stt_backend", ""),
                    "llm_backend": ctx.telemetry.get("llm_backend", ""),
                },
            },
        )

        await ctx.emit(
            "transcript",
            {
                "phase": "analyzing",
                "chunk_id": f"segment-{index}",
                "index": index,
                "total": len(transcript_chunks),
                "text": chunk,
                "telemetry": {
                    "total_elapsed_ms": elapsed_ms(ctx.pipeline_started_at),
                    "graph_elapsed_ms": analysis_elapsed_ms,
                    "analysis_eta_ms": analysis_eta_ms,
                },
            },
        )

        ctx.logger.info(
            "[PROCESS FILE] Processing chunk %d/%d (eta: %s ms)",
            index,
            len(transcript_chunks),
            analysis_eta_ms,
        )
        await processor.handle_final_text(chunk)

    await processor.flush()
    return transcript_result.source_type, transcript_result.metadata

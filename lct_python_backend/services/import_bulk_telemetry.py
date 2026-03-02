"""Telemetry helpers for import bulk-processing pipelines."""

from __future__ import annotations

import time
from typing import Any, Optional


def elapsed_ms(started_at: float) -> int:
    """Return elapsed milliseconds since a perf-counter timestamp."""
    return int((time.perf_counter() - started_at) * 1000)


def estimate_transcription_eta_ms(
    *,
    transcription_elapsed_ms: Optional[int],
    chunk_idx: int,
    total_chunks: int,
) -> tuple[Optional[int], Optional[int]]:
    """Return (eta_ms, estimated_total_ms) for current transcription progress."""
    if not isinstance(transcription_elapsed_ms, int):
        return (None, None)
    if chunk_idx <= 0 or total_chunks <= 0:
        return (None, None)

    average_per_chunk_ms = transcription_elapsed_ms / chunk_idx
    estimated_total_ms = int(average_per_chunk_ms * total_chunks)
    eta_ms = max(0, estimated_total_ms - transcription_elapsed_ms)
    return (eta_ms, estimated_total_ms)


def estimate_analysis_eta_ms(
    *,
    analysis_elapsed_ms: Optional[int],
    chunk_idx: int,
    total_chunks: int,
) -> tuple[Optional[int], Optional[int]]:
    """Return (eta_ms, estimated_total_ms) for LLM graph analysis progress."""
    if not isinstance(analysis_elapsed_ms, int):
        return (None, None)
    if chunk_idx <= 0 or total_chunks <= 0:
        return (None, None)

    average_per_chunk_ms = analysis_elapsed_ms / chunk_idx
    estimated_total_ms = int(average_per_chunk_ms * total_chunks)
    eta_ms = max(0, estimated_total_ms - analysis_elapsed_ms)
    return (eta_ms, estimated_total_ms)


def estimate_segment_eta_ms(
    *,
    total_elapsed_ms: int,
    segments_completed: int,
    segments_total: int,
) -> tuple[Optional[int], Optional[int]]:
    """Estimate remaining time for segmented pipeline.

    Args:
        total_elapsed_ms: Total elapsed time since pipeline start
        segments_completed: Number of fully completed segments (STT + analysis)
        segments_total: Total number of segments

    Returns:
        Tuple of (eta_ms, estimated_total_ms)
    """
    if segments_completed <= 0 or segments_total <= 0:
        return (None, None)

    # Average time per completed segment
    avg_segment_ms = total_elapsed_ms / segments_completed
    # Estimate total time
    estimated_total_ms = int(avg_segment_ms * segments_total)
    # ETA is remaining time
    eta_ms = max(0, estimated_total_ms - total_elapsed_ms)

    return (eta_ms, estimated_total_ms)


def calculate_segmented_progress(
    segment_index: int,
    segment_total: int,
    stage: str,
    stage_progress: float,
) -> float:
    """Calculate overall progress for segmented pipeline.

    Each segment contributes equally to total progress. Within a segment:
    - 60% is transcription
    - 40% is analysis

    Args:
        segment_index: Current segment (1-based)
        segment_total: Total number of segments
        stage: "transcribing" or "analyzing"
        stage_progress: 0.0-1.0 progress within current stage

    Returns:
        Overall progress as 0.0-1.0 float
    """
    if segment_total <= 0:
        return 0.0

    # Clamp values
    segment_index = max(1, min(segment_index, segment_total))
    stage_progress = max(0.0, min(1.0, stage_progress))

    # Each segment contributes equally
    segment_weight = 1.0 / segment_total
    segment_base = (segment_index - 1) * segment_weight

    # Within segment: 60% transcription, 40% analysis
    if stage == "transcribing":
        return segment_base + (stage_progress * 0.6 * segment_weight)
    else:  # analyzing
        return segment_base + (0.6 + stage_progress * 0.4) * segment_weight


def attach_bottleneck_stage(telemetry: dict[str, Any]) -> None:
    """Compute and annotate the current bottleneck stage into telemetry."""
    stage_candidates = {
        "transcription_ms": telemetry.get("transcription_ms"),
        "stt_provider_ms": telemetry.get("stt_provider_ms"),
        "diarization_ms": telemetry.get("diarization_ms"),
        "alignment_ms": telemetry.get("alignment_ms"),
        "graph_generation_ms": telemetry.get("graph_generation_ms"),
    }
    numeric_stage_candidates = {
        key: int(value)
        for key, value in stage_candidates.items()
        if isinstance(value, (int, float))
    }
    if not numeric_stage_candidates:
        return
    bottleneck_stage = max(numeric_stage_candidates, key=numeric_stage_candidates.get)
    telemetry["bottleneck_stage"] = bottleneck_stage
    telemetry["bottleneck_ms"] = numeric_stage_candidates[bottleneck_stage]

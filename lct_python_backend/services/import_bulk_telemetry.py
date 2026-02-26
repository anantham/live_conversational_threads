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

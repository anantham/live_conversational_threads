"""PipelineContext: shared mutable state and SSE emit helpers for the bulk import pipeline.

Replaces the four inner closures (send_update, send_status, on_chunk_progress,
on_provider_fallback) that previously captured shared mutable locals in
run_bulk_processing_worker.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable, Optional

from lct_python_backend.services.import_bulk_telemetry import (
    elapsed_ms,
    estimate_transcription_eta_ms,
)


class PipelineContext:
    """Owns mutable pipeline state and provides SSE emit helper methods.

    Constructor accepts:
        emit: SSE emitter callable
        logger: Logger instance
        filename: Original upload filename (seeds telemetry)
        content_size: File size in bytes (seeds telemetry)

    Instance variables set by orchestrator after construction:
        transcription_started_at: set just before transcription begins
        graph_started_at: set just before graph analysis begins
        active_stage: updated throughout the pipeline for error reporting
    """

    def __init__(
        self,
        emit: Callable[[str, dict[str, Any]], Awaitable[None]],
        logger: logging.Logger,
        filename: str,
        content_size: int,
    ) -> None:
        self.emit = emit
        self.logger = logger
        self.filename = filename

        self.pipeline_started_at: float = time.perf_counter()
        self.transcription_started_at: Optional[float] = None
        self.graph_started_at: Optional[float] = None
        self.active_stage: str = "uploading"

        self.telemetry: dict[str, Any] = {
            "file_name": filename,
            "file_size_bytes": content_size,
        }

    # ─────────────────────────────────────────────────────────────────────────
    # Emit helpers — direct lifts of the four closures, self.* prefixed
    # ─────────────────────────────────────────────────────────────────────────

    async def emit_graph_update(self, existing_json: Any, chunk_dict: Any) -> None:
        """Emit graph node and chunk payloads (was send_update closure)."""
        await self.emit("graph", {"type": "existing_json", "data": existing_json})
        await self.emit("graph", {"type": "chunk_dict", "data": chunk_dict})

    async def emit_status(
        self, level: str, message: str, context: dict[str, Any]
    ) -> None:
        """Emit a processor status event (was send_status closure)."""
        context = context or {}
        stage = str(context.get("stage") or "").strip()
        progress_map = {
            "accumulate": 0.65,
            "generate_lct_json": 0.85,
        }
        await self.emit(
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

    async def on_chunk_progress(
        self, chunk_idx: int, total: int, chunk_text: str
    ) -> None:
        """Emit per-chunk transcription progress (was on_chunk_progress closure)."""
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
        await self.emit(
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
            await self.emit(
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

    async def on_provider_fallback(
        self,
        from_provider: str,
        to_provider: str,
        error_message: str,
    ) -> None:
        """Emit STT provider fallback notice (was on_provider_fallback closure)."""
        fallback_record = {
            "from_provider": str(from_provider or "").strip().lower() or "unknown",
            "to_provider": str(to_provider or "").strip().lower() or "unknown",
            "error": str(error_message or "").strip() or "unknown_error",
        }
        fallback_events = self.telemetry.setdefault("stt_provider_fallbacks", [])
        if isinstance(fallback_events, list):
            fallback_events.append(fallback_record)
        await self.emit(
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

"""SSE stage event emitters for the import bulk-processing worker.

Extracted from import_bulk_pipeline.py so status / transcript / graph / error
payload shaping lives in one place while the worker stays orchestration-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from .import_bulk_telemetry import elapsed_ms

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]

_ANALYSIS_STAGE_PROGRESS = {
    "accumulate": 0.65,
    "generate_lct_json": 0.85,
}


@dataclass
class ImportBulkStageEvents:
    """Thin facade over the worker's SSE emit callback."""

    emit: EmitFn
    pipeline_started_at: float
    telemetry: dict[str, Any] = field(default_factory=dict)

    def _total_elapsed_ms(self) -> int:
        return elapsed_ms(self.pipeline_started_at)

    async def send_graph_update(
        self,
        existing_json: Any,
        chunk_dict: Any,
        patch: Optional[dict[str, Any]] = None,
    ) -> None:
        if isinstance(patch, dict):
            await self.emit("graph", {"type": "graph_patch", "data": patch})
        await self.emit("graph", {"type": "existing_json", "data": existing_json})
        await self.emit("graph", {"type": "chunk_dict", "data": chunk_dict})

    async def send_analysis_status(
        self,
        level: str,
        message: str,
        context: Optional[dict[str, Any]] = None,
    ) -> None:
        context = context or {}
        stage = str(context.get("stage") or "").strip()
        await self.emit(
            "status",
            {
                "level": level,
                "stage": stage or "analyzing",
                "message": message,
                "progress": _ANALYSIS_STAGE_PROGRESS.get(stage, 0.55),
                "context": context,
                "stt_backend": self.telemetry.get("stt_backend", ""),
                "llm_backend": self.telemetry.get("llm_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "stt_backend": self.telemetry.get("stt_backend", ""),
                    "llm_backend": self.telemetry.get("llm_backend", ""),
                },
            },
        )

    async def emit_upload_received(self, *, filename: str, content_size: int) -> None:
        await self.emit(
            "status",
            {
                "stage": "uploading",
                "progress": 0.05,
                "message": f"File received ({content_size} bytes)",
                "file_name": filename,
                "telemetry": {"total_elapsed_ms": self._total_elapsed_ms()},
            },
        )

    async def emit_cache_hit_done(
        self,
        *,
        prior_conv: str,
        prior_node_count: int,
        completed: int,
        total: int,
        file_hash: str,
        persisted_audio_path: Optional[str],
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "done",
                "progress": 1.0,
                "message": f"Cache hit — reusing existing conversation ({prior_node_count} nodes).",
                "conversation_id": prior_conv,
                "cache_hit": True,
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "file_hash": file_hash,
                    "cached_node_count": prior_node_count,
                    "cached_completed_chunks": completed,
                    "cached_total_chunks": total,
                    "source_audio_backfilled": str(persisted_audio_path) if persisted_audio_path else None,
                },
            },
        )

    async def emit_checkpoint_transcript_replays(self, existing_checkpoint: dict[str, Any]) -> None:
        for ct in existing_checkpoint.get("completed_chunk_texts", []):
            if not ct.get("text"):
                continue
            await self.emit(
                "transcript",
                {
                    "phase": "transcribing",
                    "chunk_id": f"stt-chunk-{ct['index']}",
                    "index": ct["index"],
                    "total": existing_checkpoint.get("total_chunks", 0),
                    "text": ct["text"],
                    "resumed": True,
                    "telemetry": {"checkpoint_replayed": True},
                },
            )

    async def emit_resume_checkpoint(
        self,
        *,
        resume_from_chunk: int,
        checkpoint_total: Optional[int],
        stt_backend: str,
        is_likely_audio: bool,
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "resuming",
                "progress": 0.08,
                "message": f"Resuming from chunk {resume_from_chunk} (found checkpoint)...",
                "stt_backend": stt_backend if is_likely_audio else "",
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "checkpoint_chunks": resume_from_chunk,
                    "checkpoint_total_chunks": checkpoint_total,
                    "resume_available": True,
                },
            },
        )

    async def emit_transcription_start(
        self,
        *,
        is_likely_audio: bool,
        transcribe_msg: str,
        stt_backend: str,
        stt_http_url: str,
        audio_duration_ms: Optional[float],
        initial_eta_ms: Optional[int],
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "transcribing" if is_likely_audio else "parsing",
                "progress": 0.10,
                "message": transcribe_msg,
                "stt_backend": stt_backend if is_likely_audio else "",
                "stt_http_url": stt_http_url if is_likely_audio else "",
                "audio_duration_ms": audio_duration_ms,
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "stt_backend": stt_backend if is_likely_audio else "",
                    "stt_http_url": stt_http_url if is_likely_audio else "",
                    "audio_duration_ms": audio_duration_ms,
                    "initial_eta_ms": initial_eta_ms,
                },
            },
        )

    async def emit_chunk_progress(
        self,
        *,
        chunk_idx: int,
        total: int,
        progress: float,
        normalized_chunk_text: str,
        transcription_elapsed_ms: Optional[int],
        transcription_eta_ms: Optional[int],
        transcription_estimated_total_ms: Optional[int],
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "transcribing",
                "progress": round(progress, 3),
                "message": f"Transcribing audio chunk {chunk_idx}/{total}...",
                "stt_backend": self.telemetry.get("stt_backend", ""),
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "transcription_elapsed_ms": transcription_elapsed_ms,
                    "transcription_eta_ms": transcription_eta_ms,
                    "transcription_estimated_total_ms": transcription_estimated_total_ms,
                    "stt_chunks_completed": chunk_idx,
                    "stt_chunks_total": total,
                    "stt_backend": self.telemetry.get("stt_backend", ""),
                },
            },
        )
        if not normalized_chunk_text:
            return
        await self.emit(
            "transcript",
            {
                "phase": "transcribing",
                "chunk_id": f"stt-chunk-{chunk_idx}",
                "index": chunk_idx,
                "total": total,
                "text": normalized_chunk_text,
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "transcription_elapsed_ms": transcription_elapsed_ms,
                    "transcription_eta_ms": transcription_eta_ms,
                    "stt_chunks_completed": chunk_idx,
                    "stt_chunks_total": total,
                },
            },
        )

    async def emit_provider_fallback(self, fallback_record: dict[str, str], *, transcription_elapsed_ms: Optional[int]) -> None:
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
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "transcription_elapsed_ms": transcription_elapsed_ms,
                },
            },
        )

    async def emit_segment_started(
        self,
        *,
        segment_index: int,
        segment_total: int,
        start_ms: int,
        end_ms: int,
    ) -> None:
        await self.emit(
            "segment_started",
            {
                "index": segment_index,
                "total": segment_total,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_ms": end_ms - start_ms,
                "telemetry": {"total_elapsed_ms": self._total_elapsed_ms()},
            },
        )

    async def emit_segment_transcribed(
        self,
        *,
        segment_index: int,
        segment_total: int,
        stt_progress: float,
        segment_elapsed_ms: Optional[int],
        segment_eta_ms: Optional[int],
        llm_backend: str,
        segment_stt_backend: str,
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "transcribing",
                "progress": round(stt_progress, 3),
                "message": f"Transcribed segment {segment_index}/{segment_total}",
                "segment_index": segment_index,
                "segment_total": segment_total,
                "stt_backend": segment_stt_backend,
                "llm_backend": llm_backend,
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "segment_elapsed_ms": segment_elapsed_ms,
                    "segment_index": segment_index,
                    "segment_total": segment_total,
                    "stt_chunks_completed": segment_index,
                    "stt_chunks_total": segment_total,
                    "transcription_elapsed_ms": self._total_elapsed_ms(),
                    "transcription_eta_ms": segment_eta_ms,
                },
            },
        )

    async def emit_segment_transcript(
        self,
        *,
        segment_index: int,
        segment_total: int,
        transcript_text: str,
        resumed: bool,
    ) -> None:
        await self.emit(
            "transcript",
            {
                "phase": "transcribing",
                "segment_index": segment_index,
                "segment_total": segment_total,
                "text": transcript_text,
                "resumed": resumed,
                "telemetry": {"total_elapsed_ms": self._total_elapsed_ms()},
            },
        )

    async def emit_segment_analyzing(
        self,
        *,
        segment_index: int,
        segment_total: int,
        chunk_idx: int,
        chunk_total: int,
        overall_progress: float,
        llm_backend: str,
    ) -> None:
        await self.emit(
            "status",
            {
                "stage": "analyzing",
                "progress": round(overall_progress, 3),
                "message": (
                    f"Analyzing segment {segment_index}/{segment_total} "
                    f"chunk {chunk_idx}/{chunk_total}..."
                ),
                "segment_index": segment_index,
                "segment_total": segment_total,
                "stt_backend": self.telemetry.get("stt_backend", ""),
                "llm_backend": llm_backend,
                "telemetry": {
                    "total_elapsed_ms": self._total_elapsed_ms(),
                    "segment_index": segment_index,
                    "segment_total": segment_total,
                },
            },
        )

    async def emit_segment_complete(
        self,
        *,
        segment_index: int,
        segment_total: int,
        nodes_generated: int,
        total_nodes: int,
        segment_elapsed_ms: Optional[int],
    ) -> None:
        await self.emit(
            "segment_complete",
            {
                "index": segment_index,
                "total": segment_total,
                "nodes_generated": nodes_generated,
                "total_nodes": total_nodes,
                "elapsed_ms": segment_elapsed_ms,
                "telemetry": {"total_elapsed_ms": self._total_elapsed_ms()},
            },
        )

    async def emit_consolidation_status(self, *, progress: float, message: str) -> None:
        await self.emit(
            "status",
            {
                "stage": "consolidating",
                "progress": progress,
                "message": message,
                "telemetry": {"total_elapsed_ms": self._total_elapsed_ms()},
            },
        )

    async def emit_pipeline_error(
        self,
        *,
        err_msg: str,
        filename: str,
        conversation_id: str,
        active_stage: str,
        retryable: bool,
        resume_available: bool,
        checkpoint_chunks: int,
        checkpoint_total_chunks: Optional[int],
        error_telemetry: dict[str, Any],
    ) -> None:
        await self.emit(
            "error",
            {
                "message": err_msg,
                "file_name": filename,
                "conversation_id": conversation_id,
                "failure_stage": active_stage,
                "retryable": retryable,
                "resume_available": resume_available,
                "checkpoint_chunks": checkpoint_chunks,
                "checkpoint_total_chunks": checkpoint_total_chunks,
                "telemetry": error_telemetry,
            },
        )

    async def emit_done(self, payload: dict[str, Any]) -> None:
        await self.emit("done", payload)
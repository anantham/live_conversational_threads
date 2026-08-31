"""Async in-memory queue for post-import diarization and graph patch generation."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from lct_python_backend.services.file_transcriber import (
    chunk_transcript_lines,
    transcribe_uploaded_file,
)
from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
from lct_python_backend.services.stt.stt_config import get_env_stt_defaults
from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


IMPORT_ASYNC_DIARIZATION_ENABLED = _env_flag("IMPORT_ASYNC_DIARIZATION_ENABLED", False)
IMPORT_ASYNC_DIARIZATION_MAX_QUEUE = _env_int(
    "IMPORT_ASYNC_DIARIZATION_MAX_QUEUE",
    default=4,
    minimum=1,
    maximum=64,
)
IMPORT_ASYNC_DIARIZATION_MAX_JOBS = _env_int(
    "IMPORT_ASYNC_DIARIZATION_MAX_JOBS",
    default=200,
    minimum=10,
    maximum=2000,
)


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


_SENSITIVE_QUEUE_KEY_NAMES = {
    "api_key",
    "access_token",
    "refresh_token",
    "token",
    "secret",
    "password",
}
_CLOUD_STT_PROVIDER_IDS = {"openai_audio", "openrouter_audio"}


def _is_sensitive_queue_key(value: Any) -> bool:
    normalized = str(value or "").strip().lower()
    return normalized in _SENSITIVE_QUEUE_KEY_NAMES or normalized.endswith(
        ("_api_key", "_token", "_secret", "_password")
    )


def _sanitize_runtime_for_queue(value: Any) -> Any:
    """Return a deep copy with credential-shaped fields removed recursively."""
    if isinstance(value, dict):
        return {
            key: _sanitize_runtime_for_queue(item)
            for key, item in value.items()
            if not _is_sensitive_queue_key(key)
        }
    if isinstance(value, list):
        return [_sanitize_runtime_for_queue(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_sanitize_runtime_for_queue(item) for item in value)
    return _clone(value)


def _non_cloud_provider_map(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): _sanitize_runtime_for_queue(item)
        for key, item in value.items()
        if str(key or "").strip().lower() not in _CLOUD_STT_PROVIDER_IDS
    }


def _sanitize_stt_settings_for_queue(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Strip credentials and cloud authority from delayed STT job state.

    A queued job executes after the foreground BYOK/session scope has ended, so
    it may retain non-secret local endpoint preferences but must not inherit a
    cloud credential, provider override, or external fallback route.
    """
    sanitized = _sanitize_runtime_for_queue(settings)
    if not isinstance(sanitized, dict):
        return {}

    provider_http_urls = _non_cloud_provider_map(sanitized.get("provider_http_urls"))
    provider_urls = _non_cloud_provider_map(sanitized.get("provider_urls"))
    sanitized["provider_http_urls"] = provider_http_urls
    sanitized["provider_urls"] = provider_urls

    configured_provider = str(sanitized.get("provider") or "").strip().lower()
    configured_local_provider = configured_provider if (
        configured_provider not in _CLOUD_STT_PROVIDER_IDS
        and (provider_http_urls.get(configured_provider) or provider_urls.get(configured_provider))
    ) else ""
    if configured_local_provider:
        sanitized["provider"] = configured_local_provider
        if provider_http_urls.get(configured_local_provider):
            sanitized["http_url"] = provider_http_urls[configured_local_provider]
        else:
            sanitized.pop("http_url", None)
        if provider_urls.get(configured_local_provider):
            sanitized["ws_url"] = provider_urls[configured_local_provider]
        else:
            sanitized.pop("ws_url", None)
    else:
        sanitized.pop("provider", None)
        sanitized.pop("http_url", None)
        sanitized.pop("ws_url", None)

    for key in (
        "local_authorities",
        "cloud_fallback_providers",
        "external_fallback_http_url",
        "external_fallback_ws_url",
        "fallback_provider",
        "live_fallback_priority",
    ):
        sanitized.pop(key, None)
    for key in tuple(sanitized):
        if str(key).startswith("_validated_stt_"):
            sanitized.pop(key, None)
    sanitized["local_only"] = True
    sanitized["live_cloud_fallback_enabled"] = False
    sanitized["live_allow_text_only_fallback"] = False
    sanitized["upload_remote_fallback"] = False
    return sanitized


@dataclass
class _QueuedDiarizationJob:
    job_id: str
    status: str
    created_at: str
    updated_at: str
    request: Dict[str, Any]
    audio_path: Path
    created_perf: float = field(default_factory=time.perf_counter)
    started_perf: Optional[float] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None
    telemetry: Dict[str, Any] = field(default_factory=dict)
    result: Dict[str, Any] = field(default_factory=dict)
    events: List[Dict[str, Any]] = field(default_factory=list)
    next_seq: int = 1


class ImportDiarizationQueue:
    """Single-worker in-memory queue for diarization follow-up jobs."""

    def __init__(self) -> None:
        self._jobs: Dict[str, _QueuedDiarizationJob] = {}
        self._job_order: List[str] = []
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=IMPORT_ASYNC_DIARIZATION_MAX_QUEUE)
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None

    def _ensure_worker(self) -> None:
        if self._worker_task and not self._worker_task.done():
            return
        self._worker_task = asyncio.create_task(self._worker_loop(), name="import-diarization-worker")

    async def enqueue(
        self,
        *,
        audio_path: Path,
        filename: str,
        content_type: Optional[str],
        source_type_override: Optional[str],
        provider_override: Optional[str],
        conversation_id: str,
        speaker_id: str,
        stt_settings: Dict[str, Any],
        llm_config: Dict[str, Any],
        source_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Enqueue a background diarization + graph merge job."""
        self._ensure_worker()
        if self._queue.full():
            raise RuntimeError("Async diarization queue is full. Please retry shortly.")

        now = _utc_iso_now()
        job_id = str(uuid.uuid4())
        job = _QueuedDiarizationJob(
            job_id=job_id,
            status="pending",
            created_at=now,
            updated_at=now,
            audio_path=audio_path,
            request={
                "filename": filename,
                "content_type": content_type,
                "source_type_override": source_type_override,
                # Foreground provider/BYOK authority expires before this
                # delayed job runs. Re-enter the ordinary local-only resolver.
                "provider_override": None,
                "conversation_id": conversation_id,
                "speaker_id": speaker_id,
                "stt_settings": _sanitize_stt_settings_for_queue(stt_settings),
                "llm_config": _sanitize_runtime_for_queue(llm_config),
            },
        )

        async with self._lock:
            self._jobs[job_id] = job
            self._job_order.append(job_id)
            self._prune_completed_jobs_locked()

        await self._record_event(
            job,
            "status",
            {
                "level": "info",
                "stage": "queued",
                "message": "Queued background diarization job.",
                "progress": 0.0,
                "telemetry": {
                    "queue_depth": self._queue.qsize() + 1,
                },
            },
        )
        self._queue.put_nowait(job_id)
        return self._job_snapshot(job)

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            return self._job_snapshot(job)

    async def get_events(self, job_id: str, *, cursor: int = 0) -> Optional[Dict[str, Any]]:
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            bounded_cursor = max(0, int(cursor))
            events = [_clone(item) for item in job.events if int(item.get("seq", 0)) > bounded_cursor]
            next_cursor = bounded_cursor
            if events:
                next_cursor = int(events[-1]["seq"])
            return {
                "job_id": job.job_id,
                "status": job.status,
                "cursor": bounded_cursor,
                "next_cursor": next_cursor,
                "events": events,
            }

    async def _worker_loop(self) -> None:
        while True:
            job_id = await self._queue.get()
            try:
                await self._run_job(job_id)
            except Exception:  # noqa: BLE001
                logger.exception("Unhandled async diarization worker failure for job %s", job_id)
            finally:
                self._queue.task_done()

    async def _run_job(self, job_id: str) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
        if not job:
            logger.warning("Missing queued diarization job: %s", job_id)
            return

        now = _utc_iso_now()
        async with self._lock:
            job.status = "running"
            job.updated_at = now
            job.started_at = now
            job.started_perf = time.perf_counter()

        active_stage = "queued"
        seen_node_count = 0
        seen_chunk_ids: Set[str] = set()
        started_perf = job.started_perf or time.perf_counter()
        job.telemetry["queue_wait_ms"] = _elapsed_ms(job.created_perf)
        job.telemetry["queued_at"] = job.created_at
        job.telemetry["started_at"] = now

        async def send_update(existing_json: List[Dict[str, Any]], chunk_dict: Dict[str, str]) -> None:
            nonlocal seen_node_count, seen_chunk_ids
            if len(existing_json) >= seen_node_count:
                new_nodes = _clone(existing_json[seen_node_count:])
            else:
                new_nodes = _clone(existing_json)
            seen_node_count = len(existing_json)

            new_chunks: Dict[str, str] = {}
            for key, value in chunk_dict.items():
                if key in seen_chunk_ids:
                    continue
                seen_chunk_ids.add(key)
                new_chunks[key] = value

            if not new_nodes and not new_chunks:
                return
            await self._record_event(
                job,
                "patch",
                {
                    "nodes": new_nodes,
                    "chunks": new_chunks,
                    "node_count": len(existing_json),
                    "chunk_count": len(chunk_dict),
                },
            )

        async def send_status(level: str, message: str, context: Dict[str, Any]) -> None:
            context = context or {}
            stage = str(context.get("stage") or "analyzing")
            progress_map = {
                "queued": 0.0,
                "transcribing": 0.15,
                "transcribed": 0.35,
                "analyzing": 0.55,
                "accumulate": 0.7,
                "generate_lct_json": 0.85,
            }
            await self._record_event(
                job,
                "status",
                {
                    "level": level,
                    "stage": stage,
                    "message": message,
                    "progress": progress_map.get(stage, 0.6),
                    "context": _clone(context),
                    "telemetry": {
                        "total_elapsed_ms": _elapsed_ms(started_perf),
                    },
                },
            )

        try:
            await self._record_event(
                job,
                "status",
                {
                    "level": "info",
                    "stage": "transcribing",
                    "message": "Running background transcription+diarization...",
                    "progress": 0.15,
                    "telemetry": {
                        "total_elapsed_ms": _elapsed_ms(started_perf),
                    },
                },
            )
            active_stage = "transcribing"
            transcribe_started_at = time.perf_counter()
            execution_stt_settings = _clone(job.request.get("stt_settings") or {})
            execution_stt_settings["local_authorities"] = _clone(
                get_env_stt_defaults().get("local_authorities") or []
            )
            transcript_result = await transcribe_uploaded_file(
                temp_path=job.audio_path,
                filename=str(job.request.get("filename") or job.audio_path.name),
                content_type=job.request.get("content_type"),
                stt_settings=execution_stt_settings,
                provider_override=job.request.get("provider_override"),
                source_type_override=job.request.get("source_type_override"),
                enable_parakeet_pyannote=True,
            )
            job.telemetry["transcription_ms"] = _elapsed_ms(transcribe_started_at)
            source_timings = transcript_result.metadata.get("timings_ms", {})
            if isinstance(source_timings, dict):
                job.telemetry["stt_provider_ms"] = source_timings.get("stt_ms")
                job.telemetry["diarization_ms"] = source_timings.get("diarization_ms")
                job.telemetry["alignment_ms"] = source_timings.get("alignment_ms")
            await self._record_event(
                job,
                "status",
                {
                    "level": "info",
                    "stage": "transcribed",
                    "message": f"Background transcription complete ({transcript_result.source_type}).",
                    "progress": 0.35,
                    "source_type": transcript_result.source_type,
                    "metadata": _clone(transcript_result.metadata),
                    "telemetry": {
                        "total_elapsed_ms": _elapsed_ms(started_perf),
                        "transcription_ms": job.telemetry.get("transcription_ms"),
                        "stt_provider_ms": job.telemetry.get("stt_provider_ms"),
                        "diarization_ms": job.telemetry.get("diarization_ms"),
                        "alignment_ms": job.telemetry.get("alignment_ms"),
                    },
                },
            )

            transcript_text = transcript_result.transcript_text.strip()
            if not transcript_text:
                raise ValueError("No transcript text could be extracted from background diarization input.")

            speaker_segments = list(getattr(transcript_result, "speaker_segments", []) or [])
            if speaker_segments:
                active_stage = "materializing_speakers"
                materialize_started_at = time.perf_counter()
                materialization_result = await persist_speaker_refinement(
                    conversation_id=str(job.request.get("conversation_id") or ""),
                    segments=speaker_segments,
                    source_text=transcript_text,
                    provider=str(transcript_result.metadata.get("provider") or ""),
                    model=str(transcript_result.metadata.get("model") or ""),
                    transport=str(
                        transcript_result.metadata.get("transport")
                        or transcript_result.metadata.get("stt_backend")
                        or ""
                    ),
                )
                job.telemetry["speaker_materialization_ms"] = _elapsed_ms(materialize_started_at)
                job.telemetry["speaker_materialization"] = _clone(materialization_result)
                await self._record_event(
                    job,
                    "status",
                    {
                        "level": "info",
                        "stage": "materializing_speakers",
                        "message": (
                            "Persisted background speaker refinement "
                            f"({materialization_result.get('persisted_segments', 0)} segments)."
                        ),
                        "progress": 0.45,
                        "telemetry": {
                            "total_elapsed_ms": _elapsed_ms(started_perf),
                            "speaker_materialization_ms": job.telemetry.get("speaker_materialization_ms"),
                        },
                    },
                )

            active_stage = "chunking"
            chunking_started_at = time.perf_counter()
            transcript_chunks = chunk_transcript_lines(transcript_text)
            if not transcript_chunks:
                raise ValueError("Transcript parser produced no usable chunks in background diarization job.")
            job.telemetry["chunking_ms"] = _elapsed_ms(chunking_started_at)
            job.telemetry["transcript_chars"] = len(transcript_text)
            job.telemetry["transcript_chunk_count"] = len(transcript_chunks)

            await self._record_event(
                job,
                "status",
                {
                    "level": "info",
                    "stage": "analyzing",
                    "message": f"Merging diarized transcript into graph ({len(transcript_chunks)} chunks)...",
                    "progress": 0.55,
                    "telemetry": {
                        "total_elapsed_ms": _elapsed_ms(started_perf),
                        "chunking_ms": job.telemetry.get("chunking_ms"),
                        "transcript_chunk_count": len(transcript_chunks),
                    },
                },
            )

            active_stage = "analyzing"
            processor = TranscriptProcessor(
                send_update=send_update,
                send_status=send_status,
                llm_config=_clone(job.request.get("llm_config") or {}),
            )
            graph_started_at = time.perf_counter()
            for idx, chunk in enumerate(transcript_chunks, start=1):
                await self._record_event(
                    job,
                    "status",
                    {
                        "level": "info",
                        "stage": "analyzing",
                        "message": f"Applying diarized chunk {idx}/{len(transcript_chunks)}",
                        "progress": round(0.55 + ((idx / len(transcript_chunks)) * 0.3), 3),
                        "telemetry": {
                            "total_elapsed_ms": _elapsed_ms(started_perf),
                            "graph_elapsed_ms": _elapsed_ms(graph_started_at),
                        },
                    },
                )
                await processor.handle_final_text(chunk)

            await processor.flush()
            job.telemetry["graph_generation_ms"] = _elapsed_ms(graph_started_at)
            job.telemetry["total_processing_ms"] = _elapsed_ms(started_perf)
            job.telemetry["source_type"] = transcript_result.source_type
            job.telemetry["source_metadata"] = _clone(transcript_result.metadata)
            job.telemetry["node_count"] = len(processor.existing_json)
            job.telemetry["chunk_count"] = len(processor.chunk_dict)

            stage_candidates = {
                "transcription_ms": job.telemetry.get("transcription_ms"),
                "stt_provider_ms": job.telemetry.get("stt_provider_ms"),
                "diarization_ms": job.telemetry.get("diarization_ms"),
                "alignment_ms": job.telemetry.get("alignment_ms"),
                "graph_generation_ms": job.telemetry.get("graph_generation_ms"),
            }
            numeric_stage_candidates = {
                key: int(value)
                for key, value in stage_candidates.items()
                if isinstance(value, (int, float))
            }
            if numeric_stage_candidates:
                bottleneck_stage = max(numeric_stage_candidates, key=numeric_stage_candidates.get)
                job.telemetry["bottleneck_stage"] = bottleneck_stage
                job.telemetry["bottleneck_ms"] = numeric_stage_candidates[bottleneck_stage]

            job.result = {
                "conversation_id": str(job.request.get("conversation_id") or ""),
                "speaker_id": str(job.request.get("speaker_id") or ""),
                "source_type": transcript_result.source_type,
                "node_count": len(processor.existing_json),
                "chunk_count": len(processor.chunk_dict),
            }
            await self._record_event(
                job,
                "done",
                {
                    **_clone(job.result),
                    "telemetry": _clone(job.telemetry),
                },
            )

            completed_at = _utc_iso_now()
            async with self._lock:
                job.status = "completed"
                job.updated_at = completed_at
                job.completed_at = completed_at
                job.telemetry["completed_at"] = completed_at
            logger.info(
                "[ASYNC DIARIZATION TELEMETRY] %s",
                job.telemetry,
            )
        except Exception as exc:  # noqa: BLE001
            err_msg = str(exc) or type(exc).__name__
            failed_at = _utc_iso_now()
            async with self._lock:
                job.status = "failed"
                job.updated_at = failed_at
                job.completed_at = failed_at
                job.error = err_msg
                job.telemetry["active_stage"] = active_stage
                job.telemetry["total_elapsed_ms"] = _elapsed_ms(started_perf)
                job.telemetry["failed_at"] = failed_at
            await self._record_event(
                job,
                "error",
                {
                    "message": err_msg,
                    "telemetry": _clone(job.telemetry),
                },
            )
            logger.exception("Async diarization job %s failed", job_id)
        finally:
            with contextlib.suppress(Exception):
                job.audio_path.unlink(missing_ok=True)

    async def _record_event(self, job: _QueuedDiarizationJob, event_type: str, payload: Dict[str, Any]) -> None:
        event = {
            "seq": 0,
            "type": event_type,
            "created_at": _utc_iso_now(),
            "payload": _clone(payload),
        }
        async with self._lock:
            event["seq"] = job.next_seq
            job.next_seq += 1
            job.updated_at = event["created_at"]
            job.events.append(event)

    def _job_snapshot(self, job: _QueuedDiarizationJob) -> Dict[str, Any]:
        return {
            "job_id": job.job_id,
            "status": job.status,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "started_at": job.started_at,
            "completed_at": job.completed_at,
            "error": job.error,
            "telemetry": _clone(job.telemetry),
            "result": _clone(job.result),
            "event_cursor": max(0, job.next_seq - 1),
        }

    def _prune_completed_jobs_locked(self) -> None:
        if len(self._job_order) <= IMPORT_ASYNC_DIARIZATION_MAX_JOBS:
            return
        removable_ids = [
            job_id
            for job_id in self._job_order
            if (self._jobs.get(job_id) and self._jobs[job_id].status in {"completed", "failed"})
        ]
        while len(self._job_order) > IMPORT_ASYNC_DIARIZATION_MAX_JOBS and removable_ids:
            drop_id = removable_ids.pop(0)
            self._jobs.pop(drop_id, None)
            with contextlib.suppress(ValueError):
                self._job_order.remove(drop_id)


_IMPORT_DIARIZATION_QUEUE: Optional[ImportDiarizationQueue] = None


def _queue() -> ImportDiarizationQueue:
    global _IMPORT_DIARIZATION_QUEUE
    if _IMPORT_DIARIZATION_QUEUE is None:
        _IMPORT_DIARIZATION_QUEUE = ImportDiarizationQueue()
    return _IMPORT_DIARIZATION_QUEUE


def is_async_import_diarization_enabled() -> bool:
    return IMPORT_ASYNC_DIARIZATION_ENABLED


async def enqueue_import_diarization_job(**kwargs) -> Dict[str, Any]:
    return await _queue().enqueue(**kwargs)


async def get_import_diarization_job(job_id: str) -> Optional[Dict[str, Any]]:
    return await _queue().get_job(job_id)


async def get_import_diarization_job_events(job_id: str, *, cursor: int = 0) -> Optional[Dict[str, Any]]:
    return await _queue().get_events(job_id, cursor=cursor)

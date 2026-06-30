"""Async diarization job enqueue handoff for bulk import."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .import_bulk_telemetry import elapsed_ms

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]


async def enqueue_async_diarization_if_enabled(
    *,
    final_source_type: str,
    is_async_import_diarization_enabled: Callable[[], bool],
    copy_temp_upload_for_async_job: Callable[..., Path],
    enqueue_import_diarization_job: Callable[..., Awaitable[dict[str, Any]]],
    build_diarization_job_urls: Callable[[str], dict[str, str]],
    cleanup_temp_file: Callable[[Optional[str]], None],
    emit: EmitFn,
    temp_path: str,
    suffix: str,
    filename: str,
    content_type: Optional[str],
    resolved_source_type: Optional[str],
    provider_override: Optional[str],
    conversation_id: str,
    speaker_id: str,
    runtime_stt_settings: dict[str, Any],
    llm_config: dict[str, Any],
    final_source_metadata: dict[str, Any],
    telemetry: dict[str, Any],
    pipeline_started_at: float,
    log: logging.Logger,
) -> Optional[dict[str, Any]]:
    """Queue a background diarization job when enabled for audio imports."""
    if final_source_type != "audio" or not is_async_import_diarization_enabled():
        return None

    async_audio_copy: Optional[Path] = None
    try:
        async_audio_copy = copy_temp_upload_for_async_job(Path(temp_path), suffix=suffix)
        job_snapshot = await enqueue_import_diarization_job(
            audio_path=async_audio_copy,
            filename=filename,
            content_type=content_type,
            source_type_override=resolved_source_type,
            provider_override=provider_override,
            conversation_id=conversation_id,
            speaker_id=speaker_id,
            stt_settings=runtime_stt_settings,
            llm_config=llm_config,
            source_metadata=final_source_metadata,
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
                "telemetry": {"total_elapsed_ms": elapsed_ms(pipeline_started_at)},
            },
        )
        return diarization_job_payload
    except Exception as exc:  # noqa: BLE001
        if async_audio_copy is not None:
            cleanup_temp_file(str(async_audio_copy))
        enqueue_error = str(exc) or type(exc).__name__
        telemetry["async_diarization_enqueue_error"] = enqueue_error
        log.warning(
            "Failed to enqueue async diarization job for %s: %s",
            filename,
            enqueue_error,
        )
        return None
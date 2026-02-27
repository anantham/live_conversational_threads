"""Bulk upload SSE orchestration facade for /api/import/process-file."""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_pipeline import run_bulk_processing_worker
from lct_python_backend.services.import_bulk_sse import stream_event_queue


def cleanup_temp_file(temp_path: Optional[str], *, logger: logging.Logger) -> None:
    if not temp_path:
        return
    try:
        Path(temp_path).unlink(missing_ok=True)
    except Exception:
        logger.warning("Failed to cleanup temp file: %s", temp_path)


def copy_temp_upload_for_async_job(temp_path: Path, *, suffix: str) -> Path:
    normalized_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    handle = tempfile.NamedTemporaryFile(
        suffix=normalized_suffix or ".bin",
        prefix="import_diar_job_",
        delete=False,
    )
    handle.close()
    target_path = Path(handle.name)
    shutil.copy2(temp_path, target_path)
    return target_path


def diarization_job_urls(job_id: str) -> dict[str, str]:
    return {
        "status_url": f"/api/import/diarization-jobs/{job_id}",
        "events_url": f"/api/import/diarization-jobs/{job_id}/events",
    }


async def build_process_file_stream(
    *,
    request: Request,
    file: UploadFile,
    source_type: str,
    conversation_id: Optional[str],
    speaker_id: Optional[str],
    provider: Optional[str],
    db: AsyncSession,
    save_upload_to_temp_file: Callable[[UploadFile, str], Awaitable[tuple[str, int]]],
    load_stt_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_config: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
    chunk_transcript_lines: Callable[[str], list[str]],
    transcript_processor_cls: Callable[..., Any],
    is_async_import_diarization_enabled: Callable[[], bool],
    enqueue_import_diarization_job: Callable[..., Awaitable[dict[str, Any]]],
    copy_temp_upload_for_async_job: Callable[..., Path],
    cleanup_temp_file: Callable[[Optional[str]], None],
    build_diarization_job_urls: Callable[[str], dict[str, str]],
    logger: logging.Logger,
) -> StreamingResponse:
    """Return SSE stream response for file processing pipeline."""
    filename = file.filename or "upload.bin"
    suffix = Path(filename).suffix.lower() or ".bin"
    temp_path = None
    content_size = 0
    event_queue: "asyncio.Queue[tuple[str, dict[str, Any]] | None]" = asyncio.Queue()

    try:
        temp_path, content_size = await save_upload_to_temp_file(file, suffix)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {exc}")

    async def emit(event_type: str, payload: dict[str, Any]) -> None:
        await event_queue.put((event_type, payload))

    async def worker() -> None:
        try:
            await run_bulk_processing_worker(
                request=request,
                file=file,
                source_type=source_type,
                conversation_id=conversation_id,
                speaker_id=speaker_id,
                provider=provider,
                db=db,
                temp_path=temp_path,
                content_size=content_size,
                emit=emit,
                load_stt_settings=load_stt_settings,
                load_llm_config=load_llm_config,
                transcribe_uploaded_file=transcribe_uploaded_file,
                chunk_transcript_lines=chunk_transcript_lines,
                transcript_processor_cls=transcript_processor_cls,
                is_async_import_diarization_enabled=is_async_import_diarization_enabled,
                enqueue_import_diarization_job=enqueue_import_diarization_job,
                copy_temp_upload_for_async_job=copy_temp_upload_for_async_job,
                cleanup_temp_file=cleanup_temp_file,
                build_diarization_job_urls=build_diarization_job_urls,
                logger=logger,
            )
        finally:
            cleanup_temp_file(temp_path)
            await event_queue.put(None)

    async def event_stream():
        async for encoded in stream_event_queue(event_queue=event_queue, worker_coro=worker()):
            yield encoded

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

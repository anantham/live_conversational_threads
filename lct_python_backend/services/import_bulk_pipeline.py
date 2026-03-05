"""Core worker pipeline for /api/import/process-file SSE processing.

Public API: ``run_bulk_processing_worker`` (unchanged for callers).
All implementation lives in ``import_bulk_context.BulkPipelineContext``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_context import (
    BulkPipelineContext,
    # Re-export constants so existing imports keep working
    SEGMENT_PROCESSING_THRESHOLD_BYTES,
    SEGMENT_PROCESSING_FORCE_ENABLED,
    _AUDIO_SUFFIXES,
    get_audio_duration_ms as _get_audio_duration_ms,
    format_duration_for_display as _format_duration_for_display,
)

__all__ = [
    "run_bulk_processing_worker",
    "SEGMENT_PROCESSING_THRESHOLD_BYTES",
    "SEGMENT_PROCESSING_FORCE_ENABLED",
]


async def run_bulk_processing_worker(
    *,
    request: Request,
    file: UploadFile,
    source_type: str,
    conversation_id: Optional[str],
    speaker_id: Optional[str],
    provider: Optional[str],
    db: AsyncSession,
    temp_path: str,
    content_size: int,
    emit: Callable[[str, dict[str, Any]], Awaitable[None]],
    load_stt_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_config: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_providers: Optional[Callable[[AsyncSession], Awaitable[dict[str, Any]]]] = None,
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
    transcribe_audio_segmented: Optional[Callable[..., AsyncGenerator[Any, None]]] = None,
    chunk_transcript_lines: Callable[[str], list[str]],
    transcript_processor_cls: Callable[..., Any],
    is_async_import_diarization_enabled: Callable[[], bool],
    enqueue_import_diarization_job: Callable[..., Awaitable[dict[str, Any]]],
    copy_temp_upload_for_async_job: Callable[..., Path],
    cleanup_temp_file: Callable[[Optional[str]], None],
    build_diarization_job_urls: Callable[[str], dict[str, str]],
    logger: logging.Logger,
) -> None:
    """Execute bulk upload pipeline and emit SSE payloads."""
    await BulkPipelineContext(
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
        load_llm_providers=load_llm_providers,
        transcribe_uploaded_file=transcribe_uploaded_file,
        transcribe_audio_segmented=transcribe_audio_segmented,
        chunk_transcript_lines=chunk_transcript_lines,
        transcript_processor_cls=transcript_processor_cls,
        is_async_import_diarization_enabled=is_async_import_diarization_enabled,
        enqueue_import_diarization_job=enqueue_import_diarization_job,
        copy_temp_upload_for_async_job=copy_temp_upload_for_async_job,
        cleanup_temp_file=cleanup_temp_file,
        build_diarization_job_urls=build_diarization_job_urls,
        logger=logger,
    ).run()

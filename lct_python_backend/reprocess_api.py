"""Conversation reprocessing API.

POST /api/conversations/{conversation_id}/reprocess
  Re-runs the full import pipeline (STT → graph) from the stored audio file,
  overwriting utterances and graph nodes in place.  Streams SSE progress events
  with the same shape as /api/import/process-file so the frontend can reuse the
  same progress UI with no changes.

Why this exists: STT engines and graph-gen intelligence improve over time (better
models, new enrichments like emotion/volume/diarization).  This endpoint lets us
upgrade any conversation that has stored audio without requiring a manual re-upload.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.import_bulk_processor import (
    build_process_file_stream,
    cleanup_temp_file as _cleanup_temp_file,
    copy_temp_upload_for_async_job as _copy_temp_upload_for_async_job,
    diarization_job_urls as _build_diarization_job_urls,
)
from lct_python_backend.services.file_transcriber import (
    chunk_transcript_lines,
    transcribe_audio_segmented,
    transcribe_uploaded_file,
)
from lct_python_backend.services.import_graph_refinement import refine_import_graph_nodes
from lct_python_backend.services.llm_config import (
    load_llm_config,
    load_llm_providers as _load_llm_providers_from_db,
)
from lct_python_backend.services.stt_settings_service import load_stt_settings
from lct_python_backend.services.artifact_settings_service import load_artifact_export_settings
from lct_python_backend.services.artifact_export_service import auto_export_conversation_artifacts
from lct_python_backend.services.transcript_processing import TranscriptProcessor
from lct_python_backend.services.import_diarization_queue import (
    enqueue_import_diarization_job,
    is_async_import_diarization_enabled,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["reprocess"])

_RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
_audio_storage = AudioStorageManager(_RECORDINGS_DIR)


class _StoredAudioFile:
    """Minimal shim satisfying the .filename / .content_type reads inside the pipeline.

    build_process_file_stream accepts an UploadFile but only reads .filename and
    .content_type from it — the actual bytes come from save_upload_to_temp_file,
    which we override to return the already-copied file.
    """

    def __init__(self, filename: str, content_type: str = "audio/wav") -> None:
        self.filename = filename
        self.content_type = content_type


@router.post("/api/conversations/{conversation_id}/reprocess")
async def reprocess_conversation(
    conversation_id: str,
    request: Request,
    db: AsyncSession = Depends(get_async_session),
) -> Any:
    """Re-transcribe and re-graph a conversation from its stored audio file.

    Streams SSE events (same format as POST /api/import/process-file).
    The stored audio file is read-only; utterances and graph nodes are replaced.
    Returns 404 if no stored audio exists for this conversation.
    """
    audio_path = _audio_storage._find_source_audio(conversation_id)
    if audio_path is None:
        return JSONResponse(
            status_code=404,
            content={
                "detail": (
                    f"No stored audio found for conversation {conversation_id}. "
                    "Reprocessing requires the original audio to be present on disk."
                )
            },
        )

    suffix = audio_path.suffix or ".wav"

    # Copy the stored audio to a temp file so the pipeline can own its lifecycle
    # (seek, read multiple times, clean up on completion) without touching the
    # original recording.  Guard against leaks: if anything raises before the
    # pipeline takes ownership, clean up the temp file ourselves.
    tmp_path: Optional[str] = None
    try:
        tmp_handle = tempfile.NamedTemporaryFile(
            suffix=suffix, prefix="reprocess_", delete=False
        )
        tmp_handle.close()
        tmp_path = tmp_handle.name
        shutil.copy2(audio_path, tmp_path)

        logger.info(
            "[REPROCESS] conversation=%s audio=%s tmp=%s",
            conversation_id, audio_path.name, tmp_path,
        )

        # Inject a custom save_upload_to_temp_file that short-circuits the normal
        # "read UploadFile bytes → write to temp" step and just returns our copy.
        async def _use_stored_audio(_file_obj: Any, _suffix: str) -> tuple[str, int]:
            return tmp_path, Path(tmp_path).stat().st_size  # type: ignore[arg-type]

        async def _load_llm_providers(session: Optional[AsyncSession] = None) -> Any:
            return await _load_llm_providers_from_db(session)

        def _cleanup(path: Optional[str]) -> None:
            _cleanup_temp_file(path, logger=logger)

        return await build_process_file_stream(
            request=request,
            file=_StoredAudioFile(
                filename=f"{conversation_id}{suffix}",
                content_type=content_type,
            ),
            source_type="audio",
            conversation_id=conversation_id,   # existing id → pipeline UPDATES this conversation
            speaker_id=None,
            provider=None,
            byok_session_token=None,
            db=db,
            save_upload_to_temp_file=_use_stored_audio,
            load_stt_settings=load_stt_settings,
            load_artifact_export_settings=load_artifact_export_settings,
            load_llm_config=load_llm_config,
            load_llm_providers=_load_llm_providers,
            transcribe_uploaded_file=transcribe_uploaded_file,
            transcribe_audio_segmented=transcribe_audio_segmented,
            chunk_transcript_lines=chunk_transcript_lines,
            transcript_processor_cls=TranscriptProcessor,
            refine_import_graph_nodes=refine_import_graph_nodes,
            auto_export_conversation_artifacts=auto_export_conversation_artifacts,
            is_async_import_diarization_enabled=is_async_import_diarization_enabled,
            enqueue_import_diarization_job=enqueue_import_diarization_job,
            copy_temp_upload_for_async_job=_copy_temp_upload_for_async_job,
            cleanup_temp_file=_cleanup,
            build_diarization_job_urls=_build_diarization_job_urls,
            logger=logger,
        )
    except Exception:
        # Pipeline never took ownership — clean up temp file ourselves.
        _cleanup_temp_file(tmp_path, logger=logger)
        raise

"""
API endpoints for importing transcripts.

Thin router — delegates parsing/validation/persistence to ``import_orchestrator``
and source-specific helpers to ``import_validation`` / ``import_fetchers``.
"""

import asyncio
import contextlib
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.import_fetchers import (
    download_url_text,
    save_upload_to_temp_file,
)
from lct_python_backend.services.import_orchestrator import (
    parse_transcript,
    parse_validate_and_persist,
    validate_or_raise,
)
from lct_python_backend.services.import_validation import (
    get_supported_import_formats,
    is_url_import_enabled,
    validate_import_url,
    validate_transcript_filename,
)
from lct_python_backend.services.file_transcriber import (
    chunk_transcript_lines,
    transcribe_uploaded_file,
)
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.stt_settings_service import load_stt_settings
from lct_python_backend.services.transcript_processing import TranscriptProcessor

logger = logging.getLogger(__name__)


# ── Pydantic models ─────────────────────────────────────────────────────────

class UtteranceResponse(BaseModel):
    """Response model for utterance."""
    speaker: str
    text: str
    start_time: Optional[float]
    end_time: Optional[float]
    sequence_number: int

    model_config = ConfigDict(from_attributes=True)


class ValidationResponse(BaseModel):
    """Response model for validation result."""
    is_valid: bool
    errors: List[str]
    warnings: List[str]
    stats: dict


class ParsedTranscriptResponse(BaseModel):
    """Response model for parsed transcript."""
    conversation_id: str
    utterance_count: int
    participant_count: int
    participants: List[str]
    duration: Optional[float]
    validation: ValidationResponse
    sample_utterances: List[UtteranceResponse]


class ImportStatusResponse(BaseModel):
    """Response model for import status."""
    success: bool
    conversation_id: Optional[str]
    message: str
    utterance_count: int
    participant_count: int


class ImportFromUrlRequest(BaseModel):
    """Request model for importing from URL."""
    url: str
    conversation_name: Optional[str] = None
    owner_id: Optional[str] = None


class ImportFromTextRequest(BaseModel):
    """Request model for importing from text."""
    text: str
    conversation_name: Optional[str] = None
    owner_id: Optional[str] = None


# ── Backward-compat wrappers (test monkeypatch targets) ─────────────────────

router = APIRouter(prefix="/api/import", tags=["import"])


def _is_url_import_enabled() -> bool:
    """Backward-compatible wrapper used by tests and existing imports."""
    return is_url_import_enabled()


def _validate_import_url(raw_url: str) -> str:
    """Backward-compatible wrapper used by tests and existing imports."""
    return validate_import_url(raw_url)


async def _download_url_text(url: str) -> str:
    """Backward-compatible wrapper used by tests and existing imports."""
    return await download_url_text(url)


def _cleanup_temp_file(temp_path: Optional[str]) -> None:
    if not temp_path:
        return
    try:
        Path(temp_path).unlink(missing_ok=True)
    except Exception:
        logger.warning("Failed to cleanup temp file: %s", temp_path)


def _sse_encode(event: str, payload: dict) -> str:
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/google-meet", response_model=ImportStatusResponse)
async def import_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
    conversation_name: Optional[str] = Form(None, description="Name for this conversation"),
    owner_id: Optional[str] = Form(None, description="Owner/user ID"),
    db: AsyncSession = Depends(get_async_session),
):
    """Import a Google Meet transcript from PDF or TXT file."""
    file_ext = validate_transcript_filename(file.filename)

    temp_path = None
    try:
        temp_path, content_size = await save_upload_to_temp_file(file, file_ext)
        logger.info("Saved upload to %s (%s bytes)", temp_path, content_size)

        result = await parse_validate_and_persist(
            db, temp_path, is_file=True,
            source_type="google_meet",
            conversation_name=conversation_name or file.filename or "Google Meet Transcript",
            owner_id=owner_id or "anonymous",
            metadata={"source_file": file.filename},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to import transcript: {exc}")
    finally:
        _cleanup_temp_file(temp_path)

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.post("/google-meet/preview", response_model=ParsedTranscriptResponse)
async def preview_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
):
    """Preview/validate a Google Meet transcript without saving to database."""
    import uuid as _uuid

    file_ext = validate_transcript_filename(file.filename)

    temp_path = None
    try:
        temp_path, _ = await save_upload_to_temp_file(file, file_ext)
        parser, transcript = parse_transcript(temp_path, is_file=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected error during parsing: {exc}")
    finally:
        _cleanup_temp_file(temp_path)

    validation = parser.validate_transcript(transcript)

    sample_utterances = [
        UtteranceResponse(
            speaker=u.speaker, text=u.text,
            start_time=u.start_time, end_time=u.end_time,
            sequence_number=u.sequence_number,
        )
        for u in transcript.utterances[:10]
    ]

    return ParsedTranscriptResponse(
        conversation_id=str(_uuid.uuid4()),
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
        participants=transcript.participants,
        duration=transcript.duration,
        validation=ValidationResponse(
            is_valid=validation.is_valid,
            errors=validation.errors,
            warnings=validation.warnings,
            stats=validation.stats,
        ),
        sample_utterances=sample_utterances,
    )


@router.post("/from-url", response_model=ImportStatusResponse)
async def import_from_url(
    request: ImportFromUrlRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a transcript from a URL."""
    if not _is_url_import_enabled():
        raise HTTPException(
            status_code=403,
            detail="URL import is disabled. Set ENABLE_URL_IMPORT=true to enable (SSRF risk — only for trusted networks).",
        )

    validated_url = _validate_import_url(request.url)
    content = await _download_url_text(validated_url)

    try:
        result = await parse_validate_and_persist(
            db, content, is_file=False,
            source_type="url",
            conversation_name=request.conversation_name or f"Transcript from {validated_url}",
            owner_id=request.owner_id or "anonymous",
            metadata={"source_url": validated_url},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("URL import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {exc}")

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.post("/from-text", response_model=ImportStatusResponse)
async def import_from_text(
    request: ImportFromTextRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a transcript from pasted text."""
    try:
        result = await parse_validate_and_persist(
            db, request.text, is_file=False,
            source_type="text",
            conversation_name=request.conversation_name or "Pasted Transcript",
            owner_id=request.owner_id or "anonymous",
            metadata={"source": "pasted_text"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Text import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {exc}")

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.get("/health")
async def health_check():
    """Health check endpoint for import API."""
    url_import_enabled = _is_url_import_enabled()
    supported_formats = get_supported_import_formats(url_import_enabled)
    return {
        "status": "healthy",
        "service": "import_api",
        "url_import_enabled": url_import_enabled,
        "supported_formats": supported_formats,
        "timestamp": datetime.now().isoformat(),
    }


@router.post("/process-file")
async def process_file(
    request: Request,
    file: UploadFile = File(..., description="Audio/text transcript file"),
    source_type: str = Form("auto"),
    conversation_id: Optional[str] = Form(None),
    speaker_id: Optional[str] = Form(None),
    provider: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_async_session),
):
    """Process uploaded file through STT/parsing + transcript-to-graph pipeline.

    Streams SSE events:
    - status
    - transcript
    - graph (existing_json/chunk_dict)
    - done / error
    """
    filename = file.filename or "upload.bin"
    suffix = Path(filename).suffix.lower() or ".bin"
    temp_path = None
    content_size = 0
    event_queue: asyncio.Queue = asyncio.Queue()
    resolved_conversation_id = conversation_id or str(uuid.uuid4())
    resolved_speaker_id = speaker_id or "speaker_1"

    try:
        temp_path, content_size = await save_upload_to_temp_file(file, suffix)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {exc}")

    async def emit(event_type: str, payload: dict) -> None:
        await event_queue.put((event_type, payload))

    async def send_update(existing_json, chunk_dict):
        await emit("graph", {"type": "existing_json", "data": existing_json})
        await emit("graph", {"type": "chunk_dict", "data": chunk_dict})

    async def send_status(level: str, message: str, context: dict):
        context = context or {}
        stage = str(context.get("stage") or "").strip()
        progress_map = {
            "accumulate": 0.65,
            "generate_lct_json": 0.85,
        }
        payload = {
            "level": level,
            "stage": stage or "analyzing",
            "message": message,
            "progress": progress_map.get(stage, 0.55),
            "context": context,
        }
        await emit("status", payload)

    async def worker() -> None:
        try:
            await emit(
                "status",
                {
                    "stage": "uploading",
                    "progress": 0.05,
                    "message": f"File received ({content_size} bytes)",
                    "file_name": filename,
                },
            )

            stt_settings = await load_stt_settings(db)

            # Emit progress before the (potentially slow) transcription call
            resolved_source_type = source_type if source_type != "auto" else None
            is_likely_audio = (
                resolved_source_type == "audio"
                or (resolved_source_type is None and Path(filename).suffix.lower() in {
                    ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4",
                })
            )
            await emit(
                "status",
                {
                    "stage": "transcribing" if is_likely_audio else "parsing",
                    "progress": 0.10,
                    "message": (
                        "Transcribing audio..."
                        if is_likely_audio
                        else "Extracting transcript text..."
                    ),
                },
            )

            transcript_result = await transcribe_uploaded_file(
                temp_path=Path(temp_path),
                filename=filename,
                content_type=file.content_type,
                stt_settings=stt_settings,
                provider_override=provider,
                source_type_override=resolved_source_type,
            )
            await emit(
                "status",
                {
                    "stage": "transcribed",
                    "progress": 0.35,
                    "message": f"Got {transcript_result.source_type} transcript.",
                    "source_type": transcript_result.source_type,
                    "metadata": transcript_result.metadata,
                },
            )

            transcript_text = transcript_result.transcript_text.strip()
            if not transcript_text:
                raise ValueError("No transcript text could be extracted from file.")

            transcript_chunks = chunk_transcript_lines(transcript_text)
            if not transcript_chunks:
                raise ValueError("Transcript parser produced no usable chunks.")

            await emit(
                "status",
                {
                    "stage": "analyzing",
                    "progress": 0.55,
                    "message": f"Generating graph from {len(transcript_chunks)} transcript chunks...",
                },
            )

            llm_config = await load_llm_config(db)
            processor = TranscriptProcessor(
                send_update=send_update,
                send_status=send_status,
                llm_config=llm_config,
            )

            for index, chunk in enumerate(transcript_chunks, start=1):
                if await request.is_disconnected():
                    logger.info("[PROCESS FILE] Client disconnected, aborting at chunk %d/%d", index, len(transcript_chunks))
                    return

                await emit(
                    "transcript",
                    {
                        "chunk_id": f"segment-{index}",
                        "index": index,
                        "total": len(transcript_chunks),
                        "text": chunk,
                    },
                )
                await processor.handle_final_text(chunk)

            await processor.flush()

            await emit(
                "done",
                {
                    "conversation_id": resolved_conversation_id,
                    "speaker_id": resolved_speaker_id,
                    "node_count": len(processor.existing_json),
                    "chunk_count": len(processor.chunk_dict),
                    "source_type": transcript_result.source_type,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Bulk file processing failed for %s", filename)
            await emit(
                "error",
                {
                    "message": str(exc),
                    "file_name": filename,
                },
            )
        finally:
            _cleanup_temp_file(temp_path)
            await event_queue.put(None)

    async def event_stream():
        worker_task = asyncio.create_task(worker())
        try:
            while True:
                item = await event_queue.get()
                if item is None:
                    break
                event_type, payload = item
                yield _sse_encode(event_type, payload)
        finally:
            if not worker_task.done():
                worker_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await worker_task

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

"""
API endpoints for importing transcripts.

Thin router — delegates parsing/validation/persistence to ``import_orchestrator``
and source-specific helpers to ``import_validation`` / ``import_fetchers``.
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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

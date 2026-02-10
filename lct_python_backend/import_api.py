"""
API endpoints for importing transcripts.

Provides endpoints for:
- Importing Google Meet transcripts (PDF/TXT)
- Parsing and validating transcripts
- Saving to database
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.import_fetchers import (
    download_url_text,
    save_upload_to_temp_file,
)
from lct_python_backend.services.import_persistence import persist_transcript
from lct_python_backend.services.import_validation import (
    get_supported_import_formats,
    is_url_import_enabled,
    validate_import_url,
    validate_transcript_filename,
)

logger = logging.getLogger(__name__)


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


@router.post("/google-meet", response_model=ImportStatusResponse)
async def import_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
    conversation_name: Optional[str] = Form(None, description="Name for this conversation"),
    owner_id: Optional[str] = Form(None, description="Owner/user ID"),
    db: AsyncSession = Depends(get_async_session),
):
    """Import a Google Meet transcript from PDF or TXT file."""
    logger.info("=== Import request received ===")
    logger.info("File: %s", file.filename or "No filename")
    logger.info("Conversation name: %s", conversation_name or "Not provided")
    logger.info("Owner ID: %s", owner_id or "Not provided (will use anonymous)")

    file_ext = validate_transcript_filename(file.filename)
    logger.info("File extension: %s", file_ext)

    temp_path = None
    try:
        temp_path, content_size = await save_upload_to_temp_file(file, file_ext)
        logger.info("File saved to: %s (%s bytes)", temp_path, content_size)

        parser = GoogleMeetParser()
        transcript = parser.parse_file(temp_path)
        logger.info(
            "Parsing successful! Found %s utterances from %s participants",
            len(transcript.utterances),
            len(transcript.participants),
        )
        logger.info("Participants: %s", ", ".join(transcript.participants))

    except ValueError as exc:
        logger.error("Parsing failed (ValueError): %s", str(exc))
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(exc)}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Failed to process uploaded file: %s", str(exc))
        raise HTTPException(status_code=500, detail=f"Failed to process uploaded file: {str(exc)}")
    finally:
        _cleanup_temp_file(temp_path)

    validation = parser.validate_transcript(transcript)
    logger.info(
        "Validation result: valid=%s, errors=%s, warnings=%s",
        validation.is_valid,
        len(validation.errors),
        len(validation.warnings),
    )

    if validation.warnings:
        for warning in validation.warnings:
            logger.warning("Validation warning: %s", warning)

    if not validation.is_valid:
        logger.error("Validation failed: %s", ", ".join(validation.errors))
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}",
        )

    conversation_id = str(uuid.uuid4())
    logger.info("Saving to database with conversation_id: %s", conversation_id)

    try:
        await persist_transcript(
            db=db,
            transcript=transcript,
            conversation_id=conversation_id,
            conversation_name=conversation_name or file.filename or "Google Meet Transcript",
            source_type="google_meet",
            owner_id=owner_id or "anonymous",
            metadata={
                "source_file": file.filename,
                "parse_metadata": transcript.parse_metadata,
                "validation": {
                    "warnings": validation.warnings,
                    "stats": validation.stats,
                },
            },
        )
        logger.info("Database commit successful")

    except Exception as exc:
        logger.error("Database operation failed: %s", str(exc))
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {str(exc)}")

    logger.info("=== Import successful! Conversation ID: %s ===", conversation_id)
    return ImportStatusResponse(
        success=True,
        conversation_id=conversation_id,
        message=f"Successfully imported transcript with {len(transcript.utterances)} utterances",
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
    )


@router.post("/google-meet/preview", response_model=ParsedTranscriptResponse)
async def preview_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
):
    """Preview/validate a Google Meet transcript without saving to database."""
    file_ext = validate_transcript_filename(file.filename)

    temp_path = None
    try:
        temp_path, _ = await save_upload_to_temp_file(file, file_ext)
        parser = GoogleMeetParser()
        transcript = parser.parse_file(temp_path)

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(exc)}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected error during parsing: {str(exc)}")
    finally:
        _cleanup_temp_file(temp_path)

    validation = parser.validate_transcript(transcript)

    sample_utterances = [
        UtteranceResponse(
            speaker=utterance.speaker,
            text=utterance.text,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            sequence_number=utterance.sequence_number,
        )
        for utterance in transcript.utterances[:10]
    ]

    return ParsedTranscriptResponse(
        conversation_id=str(uuid.uuid4()),
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
            detail=(
                "URL import is disabled. "
                "Set ENABLE_URL_IMPORT=true to enable (SSRF risk — only for trusted networks)."
            ),
        )

    validated_url = _validate_import_url(request.url)
    content = await _download_url_text(validated_url)

    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_text(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(exc)}")

    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}",
        )

    conversation_id = str(uuid.uuid4())

    if db is not None:
        try:
            await persist_transcript(
                db=db,
                transcript=transcript,
                conversation_id=conversation_id,
                conversation_name=request.conversation_name or f"Transcript from {validated_url}",
                source_type="url",
                owner_id=request.owner_id or "anonymous",
                metadata={"source_url": validated_url},
            )
        except Exception as exc:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save to database: {str(exc)}")

    return ImportStatusResponse(
        success=True,
        conversation_id=conversation_id,
        message=f"Successfully imported transcript with {len(transcript.utterances)} utterances",
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
    )


@router.post("/from-text", response_model=ImportStatusResponse)
async def import_from_text(
    request: ImportFromTextRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a transcript from pasted text."""
    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_text(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(exc)}")

    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}",
        )

    conversation_id = str(uuid.uuid4())

    if db is not None:
        try:
            await persist_transcript(
                db=db,
                transcript=transcript,
                conversation_id=conversation_id,
                conversation_name=request.conversation_name or "Pasted Transcript",
                source_type="text",
                owner_id=request.owner_id or "anonymous",
                metadata={"source": "pasted_text"},
            )
        except Exception as exc:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save to database: {str(exc)}")

    return ImportStatusResponse(
        success=True,
        conversation_id=conversation_id,
        message=f"Successfully imported transcript with {len(transcript.utterances)} utterances",
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
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

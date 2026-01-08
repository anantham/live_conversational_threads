"""
API endpoints for importing transcripts.

Provides endpoints for:
- Importing Google Meet transcripts (PDF/TXT)
- Parsing and validating transcripts
- Saving to database
"""

import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Form
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List
from pathlib import Path
import tempfile
import uuid
from datetime import datetime

from pydantic import BaseModel

# Configure logger
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

from lct_python_backend.parsers import GoogleMeetParser, ParsedTranscript, ValidationResult
from lct_python_backend.models import Conversation, Utterance as DBUtterance


# Pydantic models for API responses

class UtteranceResponse(BaseModel):
    """Response model for utterance."""
    speaker: str
    text: str
    start_time: Optional[float]
    end_time: Optional[float]
    sequence_number: int

    class Config:
        from_attributes = True


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


# Create router
router = APIRouter(prefix="/api/import", tags=["import"])


# Import database session
from lct_python_backend.db_session import get_async_session


@router.post("/google-meet", response_model=ImportStatusResponse)
async def import_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
    conversation_name: Optional[str] = Form(None, description="Name for this conversation"),
    owner_id: Optional[str] = Form(None, description="Owner/user ID"),
    db: AsyncSession = Depends(get_async_session),
):
    """
    Import a Google Meet transcript from PDF or TXT file.

    This endpoint:
    1. Accepts uploaded PDF or TXT file
    2. Parses speaker-diarized transcript
    3. Extracts timestamps
    4. Validates the transcript
    5. Saves to database (conversation + utterances)

    Args:
        file: Uploaded transcript file (PDF or TXT)
        conversation_name: Optional name for the conversation
        owner_id: Optional owner/user ID
        db: Database session

    Returns:
        ImportStatusResponse with success status and metadata
    """
    logger.info(f"=== Import request received ===")
    logger.info(f"File: {file.filename if file.filename else 'No filename'}")
    logger.info(f"Conversation name: {conversation_name or 'Not provided'}")
    logger.info(f"Owner ID: {owner_id or 'Not provided (will use anonymous)'}")

    # Validate file format
    if not file.filename:
        logger.error("No filename provided in upload")
        raise HTTPException(status_code=400, detail="No filename provided")

    file_ext = Path(file.filename).suffix.lower()
    logger.info(f"File extension: {file_ext}")

    if file_ext not in ['.pdf', '.txt', '.text']:
        logger.error(f"Unsupported file format: {file_ext}")
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {file_ext}. Only PDF and TXT are supported."
        )

    # Save uploaded file to temporary location
    logger.info("Saving uploaded file to temporary location...")
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_path = temp_file.name
        logger.info(f"File saved to: {temp_path} ({len(content)} bytes)")

    except Exception as e:
        logger.error(f"Failed to save uploaded file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {str(e)}")

    # Parse the transcript
    logger.info("Starting transcript parsing...")
    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_file(temp_path)
        logger.info(f"Parsing successful! Found {len(transcript.utterances)} utterances from {len(transcript.participants)} participants")
        logger.info(f"Participants: {', '.join(transcript.participants)}")

    except ValueError as e:
        # Clean up temp file
        logger.error(f"Parsing failed (ValueError): {str(e)}")
        Path(temp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(e)}")

    except Exception as e:
        # Clean up temp file
        logger.error(f"Parsing failed (unexpected error): {str(e)}")
        Path(temp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Unexpected error during parsing: {str(e)}")

    finally:
        # Always clean up temp file
        try:
            Path(temp_path).unlink(missing_ok=True)
            logger.info("Temporary file cleaned up")
        except:
            pass

    # Validate the transcript
    logger.info("Validating transcript...")
    validation = parser.validate_transcript(transcript)
    logger.info(f"Validation result: valid={validation.is_valid}, errors={len(validation.errors)}, warnings={len(validation.warnings)}")

    if validation.warnings:
        for warning in validation.warnings:
            logger.warning(f"Validation warning: {warning}")

    if not validation.is_valid:
        logger.error(f"Validation failed: {', '.join(validation.errors)}")
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}"
        )

    # Save to database
    conversation_id = str(uuid.uuid4())
    logger.info(f"Saving to database with conversation_id: {conversation_id}")

    try:
        # Create conversation record
        logger.info("Creating conversation record...")
        # Calculate speaker turns (nodes) from utterances
        speaker_turns = 1
        prev_speaker = None
        for utt in transcript.utterances:
            if prev_speaker and utt.speaker != prev_speaker:
                speaker_turns += 1
            prev_speaker = utt.speaker

        logger.info(f"Calculated {speaker_turns} speaker turns from {len(transcript.utterances)} utterances")

        conversation = Conversation(
            id=uuid.UUID(conversation_id),
            conversation_name=conversation_name or file.filename,
            conversation_type='transcript',
            source_type='google_meet',
            owner_id=owner_id or "anonymous",
            participant_count=len(transcript.participants),
            participants=[
                {"name": p, "utterance_count": sum(1 for u in transcript.utterances if u.speaker == p)}
                for p in transcript.participants
            ],
            duration_seconds=transcript.duration,
            started_at=datetime.now(),
            created_at=datetime.now(),
            total_utterances=len(transcript.utterances),
            total_nodes=speaker_turns,
            metadata={
                'source_file': file.filename,
                'parse_metadata': transcript.parse_metadata,
                'validation': {
                    'warnings': validation.warnings,
                    'stats': validation.stats,
                }
            }
        )

        db.add(conversation)
        logger.info("Conversation record created")

        # Create utterance records
        logger.info(f"Creating {len(transcript.utterances)} utterance records...")
        for idx, utt in enumerate(transcript.utterances):
            db_utterance = DBUtterance(
                id=uuid.uuid4(),
                conversation_id=uuid.UUID(conversation_id),
                text=utt.text,
                speaker_id=utt.speaker,
                sequence_number=utt.sequence_number,
                timestamp_start=utt.start_time,
                timestamp_end=utt.end_time,
                platform_metadata=utt.metadata or {},
            )
            db.add(db_utterance)
            if (idx + 1) % 5 == 0:
                logger.info(f"  Created {idx + 1}/{len(transcript.utterances)} utterances...")

        # Commit to database
        logger.info("Committing to database...")
        await db.commit()
        logger.info("Database commit successful!")

    except Exception as e:
        logger.error(f"Database operation failed: {str(e)}")
        await db.rollback()
        logger.info("Database rollback completed")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save to database: {str(e)}"
        )

    # Return success response
    logger.info(f"=== Import successful! Conversation ID: {conversation_id} ===")
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
    """
    Preview/validate a Google Meet transcript without saving to database.

    This endpoint:
    1. Parses the uploaded file
    2. Validates the transcript
    3. Returns parsed data for review
    4. Does NOT save to database

    Args:
        file: Uploaded transcript file (PDF or TXT)

    Returns:
        ParsedTranscriptResponse with validation results and sample data
    """

    # Validate file format
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in ['.pdf', '.txt', '.text']:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {file_ext}. Only PDF and TXT are supported."
        )

    # Save to temp file
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_path = temp_file.name

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {str(e)}")

    # Parse the transcript
    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_file(temp_path)

    except ValueError as e:
        Path(temp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(e)}")

    except Exception as e:
        Path(temp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Unexpected error during parsing: {str(e)}")

    finally:
        try:
            Path(temp_path).unlink(missing_ok=True)
        except:
            pass

    # Validate
    validation = parser.validate_transcript(transcript)

    # Get sample utterances (first 10)
    sample_utterances = [
        UtteranceResponse(
            speaker=u.speaker,
            text=u.text,
            start_time=u.start_time,
            end_time=u.end_time,
            sequence_number=u.sequence_number,
        )
        for u in transcript.utterances[:10]
    ]

    # Return preview
    return ParsedTranscriptResponse(
        conversation_id=str(uuid.uuid4()),  # Generate temporary ID
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
    """
    Import a transcript from a URL.

    Downloads content from the URL and parses it as a transcript.
    """
    import requests

    try:
        # Fetch content from URL
        response = requests.get(request.url, timeout=30)
        response.raise_for_status()
        content = response.text

    except requests.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(e)}")

    # Parse the transcript
    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_text(content)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(e)}")

    # Validate
    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}"
        )

    # Save to database
    conversation_id = str(uuid.uuid4())

    if db is not None:
        try:
            # Calculate speaker turns (nodes) from utterances
            speaker_turns = 1
            prev_speaker = None
            for utt in transcript.utterances:
                if prev_speaker and utt.speaker != prev_speaker:
                    speaker_turns += 1
                prev_speaker = utt.speaker

            conversation = Conversation(
                id=uuid.UUID(conversation_id),
                conversation_name=request.conversation_name or f"Transcript from {request.url}",
                conversation_type='transcript',
                source_type='url',
                owner_id=request.owner_id or "anonymous",
                participant_count=len(transcript.participants),
                participants=[
                    {"name": p, "utterance_count": sum(1 for u in transcript.utterances if u.speaker == p)}
                    for p in transcript.participants
                ],
                duration_seconds=transcript.duration,
                started_at=datetime.now(),
                created_at=datetime.now(),
                total_utterances=len(transcript.utterances),
                total_nodes=speaker_turns,
                metadata={'source_url': request.url}
            )

            db.add(conversation)

            for utt in transcript.utterances:
                db_utterance = DBUtterance(
                    id=uuid.uuid4(),
                    conversation_id=uuid.UUID(conversation_id),
                    text=utt.text,
                    speaker_id=utt.speaker,
                    sequence_number=utt.sequence_number,
                    timestamp_start=utt.start_time,
                    timestamp_end=utt.end_time,
                    platform_metadata=utt.metadata or {},
                )
                db.add(db_utterance)

            await db.commit()

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save to database: {str(e)}")

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
    """
    Import a transcript from pasted text.

    Parses the provided text as a transcript.
    """
    # Parse the transcript
    try:
        parser = GoogleMeetParser()
        transcript = parser.parse_text(request.text)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse transcript: {str(e)}")

    # Validate
    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise HTTPException(
            status_code=400,
            detail=f"Transcript validation failed: {', '.join(validation.errors)}"
        )

    # Save to database
    conversation_id = str(uuid.uuid4())

    if db is not None:
        try:
            # Calculate speaker turns (nodes) from utterances
            speaker_turns = 1
            prev_speaker = None
            for utt in transcript.utterances:
                if prev_speaker and utt.speaker != prev_speaker:
                    speaker_turns += 1
                prev_speaker = utt.speaker

            conversation = Conversation(
                id=uuid.UUID(conversation_id),
                conversation_name=request.conversation_name or "Pasted Transcript",
                conversation_type='transcript',
                source_type='text',
                owner_id=request.owner_id or "anonymous",
                participant_count=len(transcript.participants),
                participants=[
                    {"name": p, "utterance_count": sum(1 for u in transcript.utterances if u.speaker == p)}
                    for p in transcript.participants
                ],
                duration_seconds=transcript.duration,
                started_at=datetime.now(),
                created_at=datetime.now(),
                total_utterances=len(transcript.utterances),
                total_nodes=speaker_turns,
                metadata={'source': 'pasted_text'}
            )

            db.add(conversation)

            for utt in transcript.utterances:
                db_utterance = DBUtterance(
                    id=uuid.uuid4(),
                    conversation_id=uuid.UUID(conversation_id),
                    text=utt.text,
                    speaker_id=utt.speaker,
                    sequence_number=utt.sequence_number,
                    timestamp_start=utt.start_time,
                    timestamp_end=utt.end_time,
                    platform_metadata=utt.metadata or {},
                )
                db.add(db_utterance)

            await db.commit()

        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save to database: {str(e)}")

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
    return {
        "status": "healthy",
        "service": "import_api",
        "supported_formats": ["pdf", "txt", "url", "text"],
        "timestamp": datetime.now().isoformat(),
    }

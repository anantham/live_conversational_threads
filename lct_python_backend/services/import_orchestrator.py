"""
Import orchestration — parse, validate, and persist transcripts.

Consolidates the duplicated parse→validate→persist flow that was repeated
across three import endpoints (file upload, URL, pasted text).
"""

import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.parsers import GoogleMeetParser
from lct_python_backend.services.import_persistence import persist_transcript

logger = logging.getLogger(__name__)


@dataclass
class ImportResult:
    """Outcome of a successful parse-validate-persist cycle."""
    conversation_id: str
    utterance_count: int
    participant_count: int
    participants: list = field(default_factory=list)
    duration: Optional[float] = None
    validation: object = None  # ValidationResult from parser
    transcript: object = None  # ParsedTranscript from parser


# ---------------------------------------------------------------------------
# Building blocks (used individually by preview endpoint)
# ---------------------------------------------------------------------------

def parse_transcript(source, *, is_file: bool = False):
    """Parse a transcript from a file path or raw text.

    Returns ``(parser, transcript)`` so the caller can also call
    ``parser.validate_transcript(transcript)`` if needed.

    Raises ``ValueError`` on parse failure.
    """
    parser = GoogleMeetParser()
    if is_file:
        transcript = parser.parse_file(str(source))
    else:
        transcript = parser.parse_text(source)
    return parser, transcript


def validate_or_raise(parser, transcript):
    """Validate a parsed transcript; raise ``ValueError`` if invalid.

    Returns the ``ValidationResult`` on success.
    """
    validation = parser.validate_transcript(transcript)
    if not validation.is_valid:
        raise ValueError(
            f"Transcript validation failed: {', '.join(validation.errors)}"
        )
    return validation


# ---------------------------------------------------------------------------
# Full orchestration
# ---------------------------------------------------------------------------

async def parse_validate_and_persist(
    db: AsyncSession,
    source,
    *,
    is_file: bool = False,
    source_type: str,
    conversation_name: str,
    owner_id: str = "anonymous",
    metadata: Optional[dict] = None,
) -> ImportResult:
    """Parse, validate, and persist a transcript in one call.

    Parameters
    ----------
    db : AsyncSession
        Database session for persistence.
    source : str | Path
        Raw text content *or* a file path (when ``is_file=True``).
    is_file : bool
        If ``True``, treat *source* as a file path.
    source_type : str
        One of ``"google_meet"``, ``"url"``, ``"text"``.
    conversation_name : str
        Human-readable name for the conversation.
    owner_id : str
        Creator / owner identifier.
    metadata : dict, optional
        Extra metadata to store alongside the conversation.

    Returns
    -------
    ImportResult
        A summary of the successfully imported transcript.

    Raises
    ------
    ValueError
        If parsing or validation fails (caller should map to HTTP 400).
    """
    parser, transcript = parse_transcript(source, is_file=is_file)

    validation = validate_or_raise(parser, transcript)

    conversation_id = str(uuid.uuid4())

    enriched_metadata = dict(metadata or {})
    enriched_metadata.setdefault("validation", {
        "warnings": validation.warnings,
        "stats": validation.stats,
    })

    if db is not None:
        await persist_transcript(
            db=db,
            transcript=transcript,
            conversation_id=conversation_id,
            conversation_name=conversation_name,
            source_type=source_type,
            owner_id=owner_id,
            metadata=enriched_metadata,
        )
        logger.info("Persisted conversation %s (%s utterances)", conversation_id, len(transcript.utterances))

    return ImportResult(
        conversation_id=conversation_id,
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
        participants=transcript.participants,
        duration=transcript.duration,
        validation=validation,
        transcript=transcript,
    )

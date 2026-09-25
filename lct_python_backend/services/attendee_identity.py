"""Exact calendar occurrence contract; URLs and titles never prove identity."""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class CalendarOccurrence(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    calendar_id: str = Field(min_length=1, max_length=2048)
    event_id: str = Field(min_length=1, max_length=1024)


def parse_occurrence(value) -> Optional[dict]:
    if value is None:
        return None
    try:
        return CalendarOccurrence.model_validate(value).model_dump()
    except (ValidationError, TypeError):
        return None


def source_identity(occurrence, transcription_mode: str) -> dict:
    """Metadata retained at conversation creation, independent of process memory."""
    return {
        "provider": "attendee",
        "calendar_occurrence": parse_occurrence(occurrence),
        "identity_provenance": "authenticated_join_request" if occurrence else None,
        "transcription_mode": transcription_mode,
    }

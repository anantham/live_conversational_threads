"""Fact-check, audio download, and cost tracking API endpoints."""

import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from lct_python_backend.config import AUDIO_DOWNLOAD_TOKEN, AUDIO_RECORDINGS_DIR
from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation
from lct_python_backend.models import APICallsLog
from lct_python_backend.schemas import ClaimsResponse, FactCheckRequest
from lct_python_backend.services.cost_stats_service import (
    aggregate_cost_logs,
    fetch_cost_logs,
    parse_time_range_to_start,
)
from lct_python_backend.services.perplexity_factcheck import (
    generate_fact_check_json_perplexity as generate_fact_check_json_perplexity_service,
)
from lct_python_backend.services.openai_factcheck import (
    analyze_transcript_window,
    check_conversation_facts,
    format_transcript_window,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["factcheck"])


def _parse_time_range_to_start(time_range: str):
    """Backward-compatible wrapper used by existing tests."""
    return parse_time_range_to_start(time_range)


def _aggregate_cost_logs(logs: List[APICallsLog]) -> Dict[str, Any]:
    """Backward-compatible wrapper used by existing tests."""
    return aggregate_cost_logs(logs)


async def generate_fact_check_json_perplexity(claims: List[str]) -> Dict[str, Any]:
    """Backward-compatible wrapper for fact-check provider integration."""
    return await generate_fact_check_json_perplexity_service(claims)


@router.post("/fact_check_claims/", response_model=ClaimsResponse)
async def fact_check_claims_call(request: FactCheckRequest):
    try:
        if not request.claims:
            raise HTTPException(status_code=400, detail="No claims provided.")

        result = await generate_fact_check_json_perplexity(request.claims)
        return result

    except HTTPException as http_err:
        raise http_err
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(exc)}")


_SAFE_CONVERSATION_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def _slugify(text: str, max_len: int = 50) -> str:
    """Convert text to a safe filename slug."""
    import unicodedata
    import re
    # Normalize unicode and replace non-alphanumeric with underscore
    text = unicodedata.normalize("NFKD", text)
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "_", text)
    return text[:max_len].strip("_-")


def _sanitize_conversation_name(name: Optional[str], conversation_id: str) -> str:
    """Create a safe filename from conversation name, fallback to UUID.

    Format: ``{slug} ({uuid8})``. The slug-first ordering matters — file
    managers sort alphabetically by default, so users browsing their
    Downloads folder see meaningful titles, not hash dumps. The short UUID
    tail disambiguates when two conversations share a name.
    """
    if name:
        slug = _slugify(name, max_len=50)
        if slug:
            short_id = conversation_id[:8] if conversation_id else ""
            return f"{slug} ({short_id})" if short_id else slug
    return conversation_id


def _format_duration_short(seconds: Optional[float]) -> str:
    """Render duration as Hh Mm Ss / Mm Ss / Ss for filenames."""
    if not seconds or seconds <= 0:
        return ""
    total = int(round(float(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{secs:02d}s"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def _build_audio_filename(
    conversation,
    conversation_id: str,
    suffix: str,
) -> str:
    """Build a human-readable download filename for a conversation's audio.

    Format: ``{name} ({YYYY-MM-DD}, {duration}, {N spk}) ({uuid8}){.ext}``.
    Pieces only appear when their metadata is present, so a barely-tagged
    conversation just gets the slug + short-id.
    """
    name = getattr(conversation, "conversation_name", None) or ""
    slug_with_id = _sanitize_conversation_name(name, conversation_id)

    parts = []
    started_at = getattr(conversation, "started_at", None)
    if started_at is not None:
        try:
            parts.append(started_at.strftime("%Y-%m-%d"))
        except Exception:  # noqa: BLE001
            pass

    duration_str = _format_duration_short(getattr(conversation, "duration_seconds", None))
    if duration_str:
        parts.append(duration_str)

    participant_count = getattr(conversation, "participant_count", None) or 0
    if participant_count > 0:
        parts.append(f"{int(participant_count)} spk")

    suffix = suffix if suffix.startswith(".") else f".{suffix}"
    if not parts:
        return f"{slug_with_id}{suffix}"

    # Pull the short_id off the end of slug_with_id so it lands AFTER the
    # parens block — final shape: "Name (date, dur, spk) (uuid8).wav".
    name_part = slug_with_id
    short_id_tail = ""
    if slug_with_id.endswith(")") and "(" in slug_with_id:
        last_open = slug_with_id.rfind("(")
        candidate = slug_with_id[last_open:].strip("()")
        if len(candidate) <= 12:  # short_id is 8 chars
            name_part = slug_with_id[:last_open].rstrip()
            short_id_tail = f" ({candidate})"

    return f"{name_part} ({', '.join(parts)}){short_id_tail}{suffix}"


@router.get("/api/conversations/{conversation_id}/audio")
async def download_audio(
    conversation_id: str,
    token: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_async_session),
):
    if AUDIO_DOWNLOAD_TOKEN and token != AUDIO_DOWNLOAD_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing token")

    if not _SAFE_CONVERSATION_ID.match(conversation_id):
        raise HTTPException(status_code=400, detail="Invalid conversation_id format")

    # Pull the conversation row so we can build a human-readable filename
    # (slug + date + duration + speaker count). Falls back to the UUID
    # alone if the row can't be fetched — never blocks the download.
    conversation_row = None
    try:
        try:
            conv_uuid = uuid.UUID(conversation_id)
        except ValueError:
            conv_uuid = None

        if conv_uuid:
            result = await db.execute(
                select(Conversation).where(Conversation.id == conv_uuid)
            )
            conversation_row = result.scalar_one_or_none()
    except Exception:
        pass  # filename falls back to UUID

    recordings_root = Path(AUDIO_RECORDINGS_DIR).resolve()

    # Priority order: prefer the highest-fidelity format we have. Live STT
    # writes wav/flac; imports preserve the original upload suffix.
    _AUDIO_MEDIA_TYPES = {
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
        ".webm": "audio/webm",
        ".mp4": "audio/mp4",
    }
    for suffix, media_type in _AUDIO_MEDIA_TYPES.items():
        candidate = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}{suffix}"
        if not candidate.resolve().is_relative_to(recordings_root):
            raise HTTPException(status_code=400, detail="Invalid conversation_id format")
        if candidate.exists():
            filename = _build_audio_filename(conversation_row, conversation_id, suffix)
            return FileResponse(candidate, media_type=media_type, filename=filename)

    raise HTTPException(status_code=404, detail="Recording not found")


@router.get("/api/cost-tracking/stats")
async def get_cost_stats(
    time_range: str = "7d",
    db: AsyncSession = Depends(get_async_session),
):
    """Get API cost statistics aggregated by feature/model and time window."""
    try:
        logs = await fetch_cost_logs(db, time_range)
        return _aggregate_cost_logs(logs)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[COST_TRACKING] Failed to get cost stats for time_range=%s", time_range)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/conversations/{conversation_id}/fact_check")
async def get_conversation_fact_check(
    conversation_id: str,
    turns: int = Query(10, ge=3, le=20),
    db: AsyncSession = Depends(get_async_session),
):
    """Get fact-check analysis for a conversation's recent transcript window."""
    try:
        result = await check_conversation_facts(
            conversation_id=conversation_id,
            db_session=db,
            window_turns=turns,
        )
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[FACT_CHECK] Failed for conversation_id=%s", conversation_id)
        raise HTTPException(status_code=500, detail=str(exc))

"""Fact-check, audio download, and cost tracking API endpoints."""

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.config import AUDIO_DOWNLOAD_TOKEN, AUDIO_RECORDINGS_DIR
from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import APICallsLog
from lct_python_backend.schemas import ClaimsResponse, FactCheckRequest
from lct_python_backend.services.cost_stats_service import (
    aggregate_cost_logs,
    fetch_cost_logs,
    parse_time_range_to_start,
)
from lct_python_backend.services.factcheck_service import (
    generate_fact_check_json_perplexity as generate_fact_check_json_perplexity_service,
)
from lct_python_backend.services.fact_check_service import (
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


@router.get("/api/conversations/{conversation_id}/audio")
async def download_audio(conversation_id: str, token: Optional[str] = Query(None)):
    if AUDIO_DOWNLOAD_TOKEN and token != AUDIO_DOWNLOAD_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing token")

    if not _SAFE_CONVERSATION_ID.match(conversation_id):
        raise HTTPException(status_code=400, detail="Invalid conversation_id format")

    wav_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.wav"
    flac_path = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}.flac"

    recordings_root = Path(AUDIO_RECORDINGS_DIR).resolve()
    if not wav_path.resolve().is_relative_to(recordings_root):
        raise HTTPException(status_code=400, detail="Invalid conversation_id format")

    if wav_path.exists():
        return FileResponse(wav_path, media_type="audio/wav", filename=wav_path.name)
    if flac_path.exists():
        return FileResponse(flac_path, media_type="audio/flac", filename=flac_path.name)

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

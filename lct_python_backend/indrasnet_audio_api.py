"""Owner-only bridge from IndraSNet's audio catalog to LCT's RawTurn import.

The browser never learns the IndraSNet address and catalog reads never fetch
transcript text. Processing is an explicit user action; extraction remains the
existing second step at POST /api/import/turns/extract.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.attendee_source_api import require_source_auth
from lct_python_backend.db_session import get_async_session
from lct_python_backend.models import Conversation, Node
from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
from lct_python_backend.services.graph_persistence import persist_turns
from lct_python_backend.services.indrasnet_client import (
    IndrasNetDisabled,
    get_indrasnet_base_url,
)
from lct_python_backend.services.owner_context import get_current_owner_id

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/indrasnet/audio-sources",
    tags=["indrasnet-audio"],
    dependencies=[Depends(require_source_auth)],
)

_SOURCE_KEY = re.compile(r"^(media|item):[1-9][0-9]*$")
_SOURCE_FIELDS = (
    "source_key", "source_kind", "title", "recorded_at", "duration_seconds",
    "status", "can_process",
)
_STATUS_FIELDS = (
    "source_key", "status", "stage", "job_id", "queued_at", "started_at",
    "completed_at", "error", "can_process",
)


def _source_path(source_key: str) -> str:
    if not _SOURCE_KEY.fullmatch(source_key):
        raise HTTPException(status_code=400, detail="Invalid audio source key.")
    return f"/api/lct/audio-sources/{source_key}"


async def _indrasnet_json(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 20.0,
) -> Dict[str, Any]:
    try:
        base = get_indrasnet_base_url()
    except IndrasNetDisabled as exc:
        logger.info("IndraSNet audio catalog unavailable: capability disabled")
        raise HTTPException(
            status_code=503,
            detail="IndraSNet audio library is not configured for this LCT deployment.",
        ) from exc

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.request(method, f"{base}{path}", params=params)
    except httpx.HTTPError as exc:
        logger.warning("IndraSNet audio request transport failed: %s %s (%s)", method, path, type(exc).__name__)
        raise HTTPException(status_code=502, detail="IndraSNet audio library is unreachable.") from exc

    if response.status_code == 404:
        if path == "/api/lct/audio-sources":
            raise HTTPException(status_code=503, detail="IndraSNet audio library is not available on this server.")
        raise HTTPException(status_code=404, detail="Audio source not found.")
    if response.status_code == 409:
        detail = ("Audio transcript is not ready. Process the recording first."
                  if path.endswith("/turns")
                  else "Recording cannot be processed here. Check its file and transcription configuration.")
        raise HTTPException(status_code=409, detail=detail)
    if response.status_code >= 400:
        logger.warning("IndraSNet audio request failed: %s %s HTTP %d", method, path, response.status_code)
        raise HTTPException(
            status_code=502,
            detail=f"IndraSNet audio request failed (HTTP {response.status_code}).",
        )
    try:
        body = response.json()
    except ValueError as exc:
        logger.warning("IndraSNet audio request returned non-JSON: %s %s", method, path)
        raise HTTPException(status_code=502, detail="IndraSNet returned an unreadable audio response.") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="IndraSNet returned an invalid audio response.")
    return body


@router.get("")
async def list_audio_sources(
    q: str = Query("", max_length=200),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    body = await _indrasnet_json(
        "GET", "/api/lct/audio-sources",
        params={"q": q, "limit": limit, "offset": offset},
    )
    sources = body.get("sources")
    if not isinstance(sources, list):
        raise HTTPException(status_code=502, detail="IndraSNet audio list is malformed.")
    return {
        "sources": [
            {field: source.get(field) for field in _SOURCE_FIELDS}
            for source in sources if isinstance(source, dict)
        ],
        "limit": limit,
        "offset": offset,
        "has_more": bool(body.get("has_more")),
    }


@router.get("/{source_key}/status")
async def get_audio_source_status(source_key: str):
    body = await _indrasnet_json("GET", f"{_source_path(source_key)}/status")
    return {field: body.get(field) for field in _STATUS_FIELDS}


@router.post("/{source_key}/process")
async def process_audio_source(source_key: str):
    body = await _indrasnet_json("POST", f"{_source_path(source_key)}/process", timeout_seconds=30.0)
    return {field: body.get(field) for field in _STATUS_FIELDS}


@router.post("/{source_key}/import")
async def import_audio_source(
    source_key: str,
    db: AsyncSession = Depends(get_async_session),
):
    raw = await _indrasnet_json("GET", f"{_source_path(source_key)}/turns", timeout_seconds=60.0)
    try:
        payload = RawTurnsPayloadV1.model_validate(raw)
    except ValidationError as exc:
        logger.error("IndraSNet audio turns violate RawTurnsPayloadV1 (%d errors)", len(exc.errors()))
        raise HTTPException(status_code=502, detail="IndraSNet returned invalid structured turns.") from exc
    expected_group_id = f"indrasnet_audio:{source_key}"
    if payload.group_id != expected_group_id:
        logger.error("IndraSNet audio turns group does not match requested source %s", source_key)
        raise HTTPException(status_code=502, detail="IndraSNet returned turns for a different recording.")
    # The sibling cannot select an LCT owner or a conversation to overwrite.
    owner_id = get_current_owner_id()
    payload = payload.model_copy(update={"owner_id": owner_id, "conversation_id": None})
    try:
        existing = (await db.execute(select(Conversation).where(
            Conversation.owner_id == owner_id,
            Conversation.indrasnet_group_id == expected_group_id,
            Conversation.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if existing is not None:
            has_graph = (await db.execute(select(Node.id).where(
                Node.conversation_id == existing.id,
            ).limit(1))).scalar_one_or_none() is not None
            return {
                "success": True,
                "conversation_id": str(existing.id),
                "utterance_count": existing.total_utterances or 0,
                "already_imported": True,
                "needs_extraction": not has_graph,
                "message": "Recording already has an LCT conversation.",
            }
        result = await persist_turns(db=db, payload=payload)
    except DeploymentPrivacyError as exc:
        await db.rollback()
        logger.warning("IndraSNet audio import blocked by deployment privacy policy")
        raise HTTPException(
            status_code=409, detail="This deployment cannot retain unredacted recording turns."
        ) from exc
    except HTTPException:
        await db.rollback()
        raise
    except ValueError as exc:
        await db.rollback()
        logger.warning("IndraSNet audio import rejected: %s", type(exc).__name__)
        raise HTTPException(status_code=400, detail="Audio turns could not be imported.") from exc
    except Exception as exc:
        await db.rollback()
        logger.exception("IndraSNet audio import failed for %s", source_key)
        raise HTTPException(status_code=500, detail="Could not save audio turns in LCT.") from exc
    return {
        "success": True,
        "conversation_id": result["conversation_id"],
        "utterance_count": result["utterance_count"],
        "already_imported": False,
        "needs_extraction": True,
        "message": "Audio turns imported. Graph extraction is the next step.",
    }

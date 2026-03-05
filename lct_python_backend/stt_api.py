"""STT settings, telemetry, health, audio upload, and transcript WebSocket endpoints."""

import asyncio
import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
)
from fastapi.responses import JSONResponse

from lct_python_backend.db_session import get_async_session, get_async_session_context
from lct_python_backend.middleware import check_ws_auth
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.stt_config import STT_PROVIDER_IDS
from lct_python_backend.services.stt_ws_helpers import (
    normalize_provider as _normalize_provider,
    safe_send_json as _safe_send_json,
    send_processor_update as _send_processor_update_helper,
)
from lct_python_backend.services.stt_health_service import (
    derive_health_url,
    derive_health_url_from_http_url,
    probe_health_url,
)
from lct_python_backend.services.stt_settings_service import load_stt_settings, save_stt_settings
from lct_python_backend.services.stt_telemetry_service import aggregate_telemetry
from lct_python_backend.services.stt_ws_session import WsSessionContext

logger = logging.getLogger("lct_backend")

router = APIRouter()

RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
DOWNLOAD_TOKEN = os.getenv("AUDIO_DOWNLOAD_TOKEN")
STT_DEBUG = os.getenv("STT_DEBUG", "false").lower() in {"1", "true", "yes"}

audio_storage = AudioStorageManager(RECORDINGS_DIR)


# ---------------------------------------------------------------------------
# Backward-compatible wrappers (preserve existing test monkeypatch targets)
# ---------------------------------------------------------------------------
async def _load_stt_settings(session):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return await load_stt_settings(session)


def _probe_health_url(health_url, timeout_seconds):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return probe_health_url(health_url, timeout_seconds)


def _derive_health_url(ws_url):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return derive_health_url(ws_url)


def _derive_health_url_from_http(http_url):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return derive_health_url_from_http_url(http_url)


# ---------------------------------------------------------------------------
# Settings routes
# ---------------------------------------------------------------------------
@router.get("/api/settings/stt")
async def read_stt_settings(session=Depends(get_async_session)):
    return await _load_stt_settings(session)


@router.put("/api/settings/stt")
async def update_stt_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")
    return await save_stt_settings(session, payload)


# ---------------------------------------------------------------------------
# Telemetry route
# ---------------------------------------------------------------------------
@router.get("/api/settings/stt/telemetry")
async def read_stt_telemetry(
    limit: int = Query(400, ge=50, le=5000),
    session=Depends(get_async_session),
):
    stt_settings = await _load_stt_settings(session)
    return await aggregate_telemetry(session, limit, stt_settings)


# ---------------------------------------------------------------------------
# Health check route
# ---------------------------------------------------------------------------
@router.post("/api/settings/stt/health-check")
async def stt_provider_health_check(
    payload: Dict[str, Any],
    session=Depends(get_async_session),
):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in STT_PROVIDER_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"provider must be one of: {', '.join(STT_PROVIDER_IDS)}",
        )

    stt_settings = await _load_stt_settings(session)
    provider_urls = stt_settings.get("provider_urls") if isinstance(stt_settings.get("provider_urls"), dict) else {}
    provider_http_urls = (
        stt_settings.get("provider_http_urls")
        if isinstance(stt_settings.get("provider_http_urls"), dict)
        else {}
    )
    ws_url = str(payload.get("ws_url") or provider_urls.get(provider) or "").strip()
    http_url = str(
        payload.get("http_url")
        or provider_http_urls.get(provider)
        or stt_settings.get("http_url")
        or ""
    ).strip()

    health_url = str(payload.get("health_url") or "").strip()
    if not health_url and http_url:
        health_url = _derive_health_url_from_http(http_url)
    if not health_url and ws_url:
        health_url = _derive_health_url(ws_url)
    if not health_url:
        raise HTTPException(
            status_code=400,
            detail=f"No STT URL configured for provider '{provider}'. Provide http_url/ws_url or health_url explicitly.",
        )

    try:
        timeout_seconds = float(payload.get("timeout_seconds", 3.0))
    except (TypeError, ValueError):
        timeout_seconds = 3.0
    timeout_seconds = min(max(timeout_seconds, 0.5), 15.0)

    probe_result = await asyncio.to_thread(_probe_health_url, health_url, timeout_seconds)
    return {
        "provider": provider,
        "ws_url": ws_url or None,
        "http_url": http_url or None,
        "health_url": health_url,
        "checked_at": datetime.utcnow().isoformat() + "Z",
        **probe_result,
    }


# ---------------------------------------------------------------------------
# Audio upload routes
# ---------------------------------------------------------------------------
@router.post("/api/conversations/{conversation_id}/audio/chunk")
async def upload_audio_chunk(
    conversation_id: str,
    request: Request,
    session_id: Optional[str] = Query(None),
):
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    chunk = await request.body()
    if not chunk:
        raise HTTPException(status_code=400, detail="Empty audio chunk")
    await audio_storage.append_chunk(conversation_id, chunk)
    return {"status": "ok", "session_id": session_id, "bytes": len(chunk)}


@router.post("/api/conversations/{conversation_id}/audio/complete")
async def finalize_audio_upload(
    conversation_id: str,
    request: Request,
    session_id: Optional[str] = Query(None),
):
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    result = await audio_storage.finalize(conversation_id)
    paths = audio_storage.get_paths(conversation_id)
    download_url = None
    if paths.get("wav_path") and DOWNLOAD_TOKEN:
        download_url = f"/api/conversations/{conversation_id}/audio?token={DOWNLOAD_TOKEN}"
    return {"status": "ok", "session_id": session_id, "paths": paths, "download_url": download_url}


@router.get("/ws/audio")
async def get_audio_ws_fallback():
    return JSONResponse(
        status_code=410,
        content={"detail": "Legacy /ws/audio endpoint is deprecated. Use /ws/transcripts instead."},
    )


# ---------------------------------------------------------------------------
# Transcript WebSocket
# ---------------------------------------------------------------------------
@router.websocket("/ws/transcripts")
async def transcripts_websocket(websocket: WebSocket):
    if not check_ws_auth(websocket):
        await websocket.close(code=4401, reason="Unauthorized")
        return
    await websocket.accept()
    async with get_async_session_context() as session:
        llm_config = await load_llm_config(session)
        ctx = WsSessionContext(
            websocket=websocket,
            session=session,
            audio_storage=audio_storage,
            llm_config=llm_config,
            load_stt_settings_fn=_load_stt_settings,
            download_token=DOWNLOAD_TOKEN,
        )
        await ctx.run()

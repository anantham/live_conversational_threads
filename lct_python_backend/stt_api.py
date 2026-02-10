"""STT settings, telemetry, health, audio upload, and transcript WebSocket endpoints."""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse

from lct_python_backend.db_session import get_async_session, get_async_session_context
from lct_python_backend.middleware import check_ws_auth
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.stt_config import STT_PROVIDER_IDS
from lct_python_backend.services.stt_health_service import derive_health_url, probe_health_url
from lct_python_backend.services.stt_session import SessionState, persist_transcript_event
from lct_python_backend.services.stt_settings_service import load_stt_settings, save_stt_settings
from lct_python_backend.services.stt_telemetry_service import aggregate_telemetry
from lct_python_backend.services.transcript_processing import TranscriptProcessor

logger = logging.getLogger("lct_backend")

router = APIRouter()

RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
DOWNLOAD_TOKEN = os.getenv("AUDIO_DOWNLOAD_TOKEN")
STT_DEBUG = os.getenv("STT_DEBUG", "false").lower() in {"1", "true", "yes"}

audio_storage = AudioStorageManager(RECORDINGS_DIR)


def _log_debug(*args, **kwargs):
    if STT_DEBUG:
        logger.debug(*args, **kwargs)


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
    ws_url = str(payload.get("ws_url") or provider_urls.get(provider) or "").strip()
    if not ws_url:
        raise HTTPException(status_code=400, detail=f"No websocket URL configured for provider '{provider}'.")

    health_url = str(payload.get("health_url") or "").strip() or _derive_health_url(ws_url)
    if not health_url:
        raise HTTPException(status_code=400, detail="Unable to derive health URL. Provide health_url explicitly.")

    try:
        timeout_seconds = float(payload.get("timeout_seconds", 3.0))
    except (TypeError, ValueError):
        timeout_seconds = 3.0
    timeout_seconds = min(max(timeout_seconds, 0.5), 15.0)

    probe_result = await asyncio.to_thread(_probe_health_url, health_url, timeout_seconds)
    return {
        "provider": provider,
        "ws_url": ws_url,
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
    state = SessionState(metadata={})

    async def _processor_update(existing_json, chunk_dict):
        await _send_processor_update(websocket, existing_json, chunk_dict)

    async with get_async_session_context() as session:
        llm_config = await load_llm_config(session)
        processor = TranscriptProcessor(send_update=_processor_update, llm_config=llm_config)
        try:
            while True:
                message = await websocket.receive_text()
                payload = json.loads(message)
                msg_type = payload.get("type")

                if msg_type == "session_meta":
                    conversation_id = payload.get("conversation_id")
                    if not conversation_id:
                        await websocket.send_json({"type": "error", "detail": "Missing conversation_id"})
                        continue
                    state.conversation_id = conversation_id
                    state.session_id = payload.get("session_id") or str(uuid.uuid4())
                    state.provider = payload.get("provider") or "local"
                    state.store_audio = bool(payload.get("store_audio"))
                    state.speaker_id = payload.get("speaker_id", state.speaker_id)
                    state.metadata = payload.get("metadata") or {}
                    await websocket.send_json({
                        "type": "session_ack",
                        "conversation_id": conversation_id,
                        "session_id": state.session_id,
                        "store_audio": state.store_audio,
                    })
                    continue

                if msg_type in {"transcript_partial", "transcript_final"}:
                    if not state.conversation_id:
                        await websocket.send_json({"type": "error", "detail": "session_meta must be sent first"})
                        continue
                    text = payload.get("text", "")
                    if not text:
                        continue
                    event_type = "final" if msg_type == "transcript_final" else "partial"
                    await persist_transcript_event(session, state, payload, event_type, text)
                    await session.commit()
                    if event_type == "final":
                        await processor.handle_final_text(text)
                    continue

                if msg_type == "final_flush":
                    await processor.flush()
                    await websocket.send_json({"type": "flush_ack"})
                    continue

                if msg_type == "client_log":
                    logger.info("[CLIENT LOG] %s", payload.get("message"))
                    continue

                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue

        except WebSocketDisconnect:
            logger.info("[WS] Client disconnected")
        except Exception as exc:
            logger.exception("[WS] Error processing transcript websocket: %s", exc)
            await websocket.send_json({"type": "error", "detail": "Internal server error"})
            await websocket.close(code=1011)


async def _send_processor_update(websocket: WebSocket, existing_json: Any, chunk_dict: Any):
    try:
        if websocket.client_state.name != "CONNECTED":
            return
        await websocket.send_json({"type": "existing_json", "data": existing_json})
        await websocket.send_json({"type": "chunk_dict", "data": chunk_dict})
    except WebSocketDisconnect:
        logger.info("[WS] Processor update failed - client disconnected")

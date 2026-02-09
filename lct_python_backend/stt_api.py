import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request as UrlRequest, urlopen

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
from sqlalchemy import select

from lct_python_backend.db_session import get_async_session, get_async_session_context
from lct_python_backend.models import AppSetting, TranscriptEvent
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.stt_config import (
    STT_CONFIG_KEY,
    STT_PROVIDER_IDS,
    merge_stt_config,
)
from lct_python_backend.services.stt_session import SessionState, persist_transcript_event
from lct_python_backend.services.transcript_processing import TranscriptProcessor
from lct_python_backend.middleware import check_ws_auth

logger = logging.getLogger("lct_backend")

router = APIRouter()

RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
DOWNLOAD_TOKEN = os.getenv("AUDIO_DOWNLOAD_TOKEN")
STT_DEBUG = os.getenv("STT_DEBUG", "false").lower() in {"1", "true", "yes"}

audio_storage = AudioStorageManager(RECORDINGS_DIR)


def _log_debug(*args, **kwargs):
    if STT_DEBUG:
        logger.debug(*args, **kwargs)


def _utc_iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _to_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return round(parsed, 2)


async def _load_stt_settings(session) -> Dict[str, Any]:
    setting = await session.execute(select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY))
    value = setting.scalar_one_or_none()
    overrides = value.value if value else {}
    return merge_stt_config(overrides)


def _derive_health_url(ws_url: str) -> str:
    if not ws_url:
        return ""
    parsed = urlparse(str(ws_url).strip())
    if not parsed.netloc:
        return ""

    if parsed.scheme in {"wss", "https"}:
        scheme = "https"
    elif parsed.scheme in {"ws", "http"}:
        scheme = "http"
    else:
        return ""

    return urlunparse((scheme, parsed.netloc, "/health", "", "", ""))


def _probe_health_url(health_url: str, timeout_seconds: float) -> Dict[str, Any]:
    start = time.perf_counter()
    status_code: Optional[int] = None
    ok = False
    response_preview: Any = None
    error: Optional[str] = None

    try:
        req = UrlRequest(health_url, headers={"Accept": "application/json,text/plain,*/*"})
        with urlopen(req, timeout=timeout_seconds) as response:
            status_code = int(getattr(response, "status", response.getcode()))
            raw_body = response.read(4096)
            text = raw_body.decode("utf-8", errors="replace").strip()
            content_type = response.headers.get("Content-Type", "")
            if "application/json" in content_type:
                try:
                    response_preview = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    response_preview = text[:500]
            else:
                response_preview = text[:500]
            ok = 200 <= status_code < 300
    except HTTPError as exc:
        status_code = int(exc.code)
        body = exc.read(2048).decode("utf-8", errors="replace").strip()
        response_preview = body[:500] if body else None
        error = f"HTTP {status_code}"
    except URLError as exc:
        error = f"Connection error: {exc.reason}"
    except Exception as exc:  # pylint: disable=broad-except
        error = f"{type(exc).__name__}: {exc}"

    latency_ms = round((time.perf_counter() - start) * 1000, 2)
    return {
        "ok": ok,
        "status_code": status_code,
        "latency_ms": latency_ms,
        "response_preview": response_preview,
        "error": error,
    }


@router.get("/api/settings/stt")
async def read_stt_settings(session=Depends(get_async_session)):
    return await _load_stt_settings(session)


@router.put("/api/settings/stt")
async def update_stt_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    stmt = select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing:
        existing.value = payload
        existing.updated_at = datetime.utcnow()
    else:
        session.add(
            AppSetting(
                key=STT_CONFIG_KEY,
                value=payload,
            )
        )
    await session.commit()
    return merge_stt_config(payload)


@router.get("/api/settings/stt/telemetry")
async def read_stt_telemetry(
    limit: int = Query(400, ge=50, le=5000),
    session=Depends(get_async_session),
):
    stt_settings = await _load_stt_settings(session)
    configured_providers = list(STT_PROVIDER_IDS)
    providers: Dict[str, Dict[str, Any]] = {
        provider: {
            "last_event_at": None,
            "last_partial_ms": None,
            "last_partial_at": None,
            "last_final_ms": None,
            "last_final_at": None,
            "avg_partial_ms": None,
            "avg_final_ms": None,
            "partial_samples": 0,
            "final_samples": 0,
            "event_count": 0,
        }
        for provider in configured_providers
    }

    result = await session.execute(
        select(TranscriptEvent).order_by(TranscriptEvent.received_at.desc()).limit(limit)
    )
    events = result.scalars().all()

    partial_sums: Dict[str, float] = {provider: 0.0 for provider in providers}
    final_sums: Dict[str, float] = {provider: 0.0 for provider in providers}

    for event in events:
        provider = str(event.provider or "").strip().lower() or "unknown"
        if provider not in providers:
            providers[provider] = {
                "last_event_at": None,
                "last_partial_ms": None,
                "last_partial_at": None,
                "last_final_ms": None,
                "last_final_at": None,
                "avg_partial_ms": None,
                "avg_final_ms": None,
                "partial_samples": 0,
                "final_samples": 0,
                "event_count": 0,
            }
            partial_sums[provider] = 0.0
            final_sums[provider] = 0.0

        provider_info = providers[provider]
        if provider_info["last_event_at"] is None and event.received_at is not None:
            provider_info["last_event_at"] = event.received_at.isoformat()
        provider_info["event_count"] += 1

        metadata = event.event_metadata if isinstance(event.event_metadata, dict) else {}
        telemetry = metadata.get("telemetry") if isinstance(metadata.get("telemetry"), dict) else {}
        partial_ms = _to_float(telemetry.get("partial_turnaround_ms"))
        final_ms = _to_float(telemetry.get("final_turnaround_ms"))

        if partial_ms is not None:
            if provider_info["last_partial_ms"] is None:
                provider_info["last_partial_ms"] = partial_ms
                provider_info["last_partial_at"] = (
                    event.received_at.isoformat() if event.received_at is not None else None
                )
            provider_info["partial_samples"] += 1
            partial_sums[provider] += partial_ms

        if final_ms is not None:
            if provider_info["last_final_ms"] is None:
                provider_info["last_final_ms"] = final_ms
                provider_info["last_final_at"] = (
                    event.received_at.isoformat() if event.received_at is not None else None
                )
            provider_info["final_samples"] += 1
            final_sums[provider] += final_ms

    for provider, info in providers.items():
        if info["partial_samples"] > 0:
            info["avg_partial_ms"] = round(partial_sums[provider] / info["partial_samples"], 2)
        if info["final_samples"] > 0:
            info["avg_final_ms"] = round(final_sums[provider] / info["final_samples"], 2)

    return {
        "generated_at": _utc_iso_now(),
        "window_size": len(events),
        "active_provider": stt_settings.get("provider"),
        "providers": providers,
    }


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
        "checked_at": _utc_iso_now(),
        **probe_result,
    }


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

    return {
        "status": "ok",
        "session_id": session_id,
        "paths": paths,
        "download_url": download_url,
    }


@router.get("/ws/audio")
async def get_audio_ws_fallback():
    return JSONResponse(
        status_code=410,
        content={
            "detail": "Legacy /ws/audio endpoint is deprecated. Use /ws/transcripts instead."
        },
    )

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
                    await websocket.send_json(
                        {
                            "type": "session_ack",
                            "conversation_id": conversation_id,
                            "session_id": state.session_id,
                            "store_audio": state.store_audio,
                        }
                    )
                    continue

                if msg_type in {"transcript_partial", "transcript_final"}:
                    if not state.conversation_id:
                        await websocket.send_json(
                            {"type": "error", "detail": "session_meta must be sent first"}
                        )
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

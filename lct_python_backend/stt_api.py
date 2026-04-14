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
from lct_python_backend.middleware import check_ws_auth, check_ws_auth_message
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.byok_session_store import create_byok_session
from lct_python_backend.services.llm_config import (
    load_llm_config,
    load_llm_providers as _db_load_llm_providers,
)
from lct_python_backend.services.stt_config import (
    STT_CLOUD_PROVIDER_IDS,
    STT_PROVIDER_IDS,
    build_cloud_provider_api_url,
)
from lct_python_backend.services.stt_http_transcriber import smoke_test_stt_candidate
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
from lct_python_backend.services.stt_settings_service import (
    load_stt_settings,
    load_stt_settings_for_client,
    save_stt_settings,
)
from lct_python_backend.services.session_observability import get_conversation_observability
from lct_python_backend.services.stt_telemetry_service import aggregate_telemetry
from lct_python_backend.services.thread_observability_service import (
    get_thread_session_detail,
    get_threads_error_breakdown,
    get_threads_observability_summary,
)
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


async def _load_llm_providers(session):
    """Wrapper for runtime provider loading with secrets preserved server-side."""
    config = await _db_load_llm_providers(session, include_secrets=True)
    providers = config.get("providers")
    return providers if isinstance(providers, list) else []


def _probe_health_url(health_url, timeout_seconds):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return probe_health_url(health_url, timeout_seconds)


def _derive_health_url(ws_url):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return derive_health_url(ws_url)


def _derive_health_url_from_http(http_url):
    """Wrapper for test_stt_api_settings.py monkeypatch compatibility."""
    return derive_health_url_from_http_url(http_url)


async def _run_stt_cloud_provider_smoke_test(candidate, *, timeout_seconds, sample_rate_hz, language):
    """Wrapper for test monkeypatch compatibility."""
    return await smoke_test_stt_candidate(
        candidate,
        timeout_seconds=timeout_seconds,
        sample_rate_hz=sample_rate_hz,
        language=language,
    )


def _build_cloud_test_candidate(stt_settings: Dict[str, Any], provider_id: str) -> tuple[Dict[str, Any], str]:
    cloud_providers = (
        stt_settings.get("cloud_fallback_providers")
        if isinstance(stt_settings.get("cloud_fallback_providers"), dict)
        else {}
    )
    provider = cloud_providers.get(provider_id)
    if not isinstance(provider, dict):
        return {}, f"No cloud fallback provider configuration exists for '{provider_id}'."

    base_url = str(provider.get("base_url") or "").strip()
    model = str(provider.get("model") or "").strip()
    api_key = str(provider.get("api_key") or "").strip()
    http_url = build_cloud_provider_api_url(provider_id, base_url)
    missing_fields = []
    if not base_url:
        missing_fields.append("base URL")
    if not model:
        missing_fields.append("model")
    if not api_key:
        missing_fields.append("API key")
    if not http_url:
        missing_fields.append("resolved API URL")

    candidate = {
        "route_id": f"{provider_id}_manual_test",
        "provider": provider_id,
        "transport": provider_id,
        "base_url": base_url,
        "http_url": http_url,
        "api_key": api_key,
        "model": model,
        "language": str(stt_settings.get("http_language") or "").strip(),
        "reason": "manual_settings_test",
        "supports_diarization": provider_id == "openai_audio" and bool(provider.get("diarize_model")),
        "degraded": provider_id == "openrouter_audio",
        "request_diarization": False,
        "enabled": bool(provider.get("enabled")),
    }
    if missing_fields:
        return candidate, "Missing " + ", ".join(missing_fields) + ". Save the provider settings before testing."
    return candidate, ""


# ---------------------------------------------------------------------------
# BYOK session routes
# ---------------------------------------------------------------------------
@router.post("/api/byok/session")
async def create_byok_session_route(payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    try:
        return await create_byok_session(
            provider=payload.get("provider") or "openai_audio",
            api_key=payload.get("api_key"),
            scopes=payload.get("scopes"),
            ttl_seconds=payload.get("ttl_seconds"),
            base_url=payload.get("base_url"),
            model=payload.get("model"),
            diarize_model=payload.get("diarize_model"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Settings routes
# ---------------------------------------------------------------------------
@router.get("/api/settings/stt")
async def read_stt_settings(session=Depends(get_async_session)):
    return await load_stt_settings_for_client(session)


@router.put("/api/settings/stt")
async def update_stt_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")
    return await save_stt_settings(session, payload, include_secrets=False)


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


@router.get("/api/conversations/{conversation_id}/session-observability")
async def read_conversation_session_observability(conversation_id: str):
    return get_conversation_observability(conversation_id)


@router.get("/api/conversations/{conversation_id}/thread-session-details")
async def read_conversation_thread_session_details(
    conversation_id: str,
    session=Depends(get_async_session),
):
    return await get_thread_session_detail(session, conversation_id=conversation_id)


@router.get("/api/threads/observability/summary")
async def read_threads_observability_summary(
    since_hours: int = Query(24, ge=1, le=24 * 30),
    session=Depends(get_async_session),
):
    return await get_threads_observability_summary(session, since_hours=since_hours)


@router.get("/api/threads/observability/errors")
async def read_threads_observability_errors(
    since_hours: int = Query(24, ge=1, le=24 * 30),
    limit: int = Query(100, ge=1, le=500),
    session=Depends(get_async_session),
):
    return await get_threads_error_breakdown(session, since_hours=since_hours, limit=limit)


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


@router.post("/api/settings/stt/cloud-provider-test")
async def stt_cloud_provider_test(
    payload: Dict[str, Any],
    session=Depends(get_async_session),
):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in STT_CLOUD_PROVIDER_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"provider must be one of: {', '.join(STT_CLOUD_PROVIDER_IDS)}",
        )

    try:
        timeout_seconds = float(payload.get("timeout_seconds", 20.0))
    except (TypeError, ValueError):
        timeout_seconds = 20.0
    timeout_seconds = min(max(timeout_seconds, 5.0), 60.0)

    stt_settings = await _load_stt_settings(session)
    candidate, config_error = _build_cloud_test_candidate(stt_settings, provider)
    checked_at = datetime.utcnow().isoformat() + "Z"
    try:
        sample_rate_hz = int(float(stt_settings.get("sample_rate_hz") or 16000))
    except (TypeError, ValueError):
        sample_rate_hz = 16000
    if config_error:
        logger.warning(
            "[STT TEST] Skipping provider=%s due to incomplete configuration: %s",
            provider,
            config_error,
        )
        return {
            "provider": provider,
            "transport": provider,
            "route_id": candidate.get("route_id") or f"{provider}_manual_test",
            "http_url": candidate.get("http_url") or None,
            "base_url": candidate.get("base_url") or None,
            "model": candidate.get("model") or None,
            "checked_at": checked_at,
            "ok": False,
            "status": "misconfigured",
            "latency_ms": None,
            "sample_seconds": None,
            "diarization_requested": bool(candidate.get("request_diarization")),
            "supports_diarization": bool(candidate.get("supports_diarization")),
            "degraded": bool(candidate.get("degraded")),
            "enabled": bool(candidate.get("enabled")),
            "transcript_preview": "",
            "segments_count": 0,
            "warning": None,
            "error": config_error,
            "status_code": None,
        }

    result = await _run_stt_cloud_provider_smoke_test(
        candidate,
        timeout_seconds=timeout_seconds,
        sample_rate_hz=sample_rate_hz,
        language=str(stt_settings.get("http_language") or "").strip(),
    )
    return {
        **result,
        "enabled": bool(candidate.get("enabled")),
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


@router.get("/api/conversations/{conversation_id}/audio/status")
async def get_audio_status(conversation_id: str):
    status = audio_storage.get_status(conversation_id)
    download_url = None
    if status.get("wav_path"):
        download_url = f"/api/conversations/{conversation_id}/audio?token={DOWNLOAD_TOKEN}" if DOWNLOAD_TOKEN else f"/api/conversations/{conversation_id}/audio"
    return {
        "status": "ok",
        "conversation_id": conversation_id,
        "audio": status,
        "recoverable": bool(status.get("has_pcm")),
        "download_url": download_url,
    }


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
    if paths.get("wav_path"):
        download_url = f"/api/conversations/{conversation_id}/audio?token={DOWNLOAD_TOKEN}" if DOWNLOAD_TOKEN else f"/api/conversations/{conversation_id}/audio"
    return {"status": "ok", "session_id": session_id, "paths": paths, "download_url": download_url}


@router.post("/api/conversations/{conversation_id}/audio/recover")
async def recover_audio(conversation_id: str):
    result = await audio_storage.finalize(conversation_id)
    status = audio_storage.get_status(conversation_id)
    download_url = None
    if status.get("wav_path"):
        download_url = f"/api/conversations/{conversation_id}/audio?token={DOWNLOAD_TOKEN}" if DOWNLOAD_TOKEN else f"/api/conversations/{conversation_id}/audio"
    return {
        "status": "ok",
        "conversation_id": conversation_id,
        "audio": status,
        "paths": audio_storage.get_paths(conversation_id),
        "recoverable": bool(status.get("has_pcm")),
        "download_url": download_url,
        "recovered": bool(result.get("wav_path") or result.get("flac_path")),
    }


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
    await websocket.accept()
    if not await check_ws_auth_message(websocket):
        return
    async with get_async_session_context() as session:
        llm_config = await load_llm_config(session)
        llm_providers = await _load_llm_providers(session)
        ctx = WsSessionContext(
            websocket=websocket,
            session=session,
            audio_storage=audio_storage,
            llm_config=llm_config,
            llm_providers=llm_providers,
            load_stt_settings_fn=_load_stt_settings,
            download_token=DOWNLOAD_TOKEN,
        )
        await ctx.run()

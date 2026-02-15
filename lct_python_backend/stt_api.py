"""STT settings, telemetry, health, audio upload, and transcript WebSocket endpoints."""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

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
from lct_python_backend.services.stt_http_transcriber import (
    RealtimeHttpSttSession,
    decode_audio_base64,
)
from lct_python_backend.services.stt_health_service import (
    derive_health_url,
    derive_health_url_from_http_url,
    probe_health_url,
)
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


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _elapsed_ms(started_at: float) -> float:
    return round(max(0.0, (time.perf_counter() - started_at) * 1000.0), 2)


def _coerce_latency_ms(value: Any) -> Optional[float]:
    parsed = _safe_float(value, -1.0)
    if parsed < 0:
        return None
    return round(parsed, 2)


def _build_telemetry_metadata(
    telemetry_state: Dict[str, Optional[int]],
    event_type: str,
    stage_metrics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now_ms = _now_ms()
    if event_type == "partial" and not telemetry_state.get("first_partial_at_ms"):
        telemetry_state["first_partial_at_ms"] = now_ms
    if event_type == "final" and not telemetry_state.get("first_final_at_ms"):
        telemetry_state["first_final_at_ms"] = now_ms

    started = telemetry_state.get("audio_send_started_at_ms")
    first_partial = telemetry_state.get("first_partial_at_ms")
    first_final = telemetry_state.get("first_final_at_ms")
    telemetry: Dict[str, Any] = {
        "event_received_at_ms": now_ms,
        "audio_send_started_at_ms": started,
        "first_partial_at_ms": first_partial,
        "first_final_at_ms": first_final,
        "partial_turnaround_ms": (first_partial - started) if started and first_partial else None,
        "final_turnaround_ms": (first_final - started) if started and first_final else None,
    }
    if isinstance(stage_metrics, dict):
        for key, value in stage_metrics.items():
            if not key:
                continue
            parsed = _coerce_latency_ms(value)
            if parsed is None:
                continue
            telemetry[str(key)] = parsed
    return telemetry


def _normalize_provider(provider: Any, fallback_provider: Any) -> str:
    candidate = str(provider or "").strip().lower()
    if candidate in STT_PROVIDER_IDS:
        return candidate
    fallback = str(fallback_provider or "").strip().lower()
    if fallback in STT_PROVIDER_IDS:
        return fallback
    return "parakeet"


def _should_emit_final_segment(latest_text: str, pending_parts: List[str], pending_chars: int) -> bool:
    text = str(latest_text or "").strip()
    if not text:
        return False
    if len(pending_parts) >= 3:
        return True
    if pending_chars >= 180:
        return True
    return text.endswith((".", "!", "?", ";"))


def _ws_is_connected(websocket: WebSocket) -> bool:
    try:
        return websocket.client_state.name == "CONNECTED"
    except Exception:
        return False


async def _safe_send_json(websocket: WebSocket, payload: Dict[str, Any]) -> bool:
    if not _ws_is_connected(websocket):
        return False
    try:
        await websocket.send_json(payload)
        return True
    except (WebSocketDisconnect, RuntimeError):
        return False


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
    state = SessionState(metadata={})
    stt_runtime: Optional[RealtimeHttpSttSession] = None
    pending_partial_parts: List[str] = []
    pending_partial_chars = 0
    pending_speaker_segments: List[Dict[str, Any]] = []
    stt_unready_notified = False
    stt_flush_requested = False
    background_tasks: set[asyncio.Task[Any]] = set()
    pending_processor_final_tasks: set[asyncio.Task[Any]] = set()
    pending_stt_chunk_tasks: set[asyncio.Task[Any]] = set()
    telemetry_state: Dict[str, Optional[int]] = {
        "audio_send_started_at_ms": None,
        "first_partial_at_ms": None,
        "first_final_at_ms": None,
    }

    def _track_background_task(task: asyncio.Task[Any]) -> None:
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

    async def _processor_update(existing_json, chunk_dict):
        await _send_processor_update(websocket, existing_json, chunk_dict)

    async with get_async_session_context() as session:
        async def _processor_status(level: str, message: str, context: Dict[str, Any]) -> None:
            await _safe_send_json(
                websocket,
                {
                    "type": "processing_status",
                    "level": str(level or "info"),
                    "message": str(message or ""),
                    "context": context or {},
                }
            )

        llm_config = await load_llm_config(session)
        processor = TranscriptProcessor(
            send_update=_processor_update,
            send_status=_processor_status,
            llm_config=llm_config,
        )
        processor_lock = asyncio.Lock()
        stt_stream_lock = asyncio.Lock()

        def _track_processor_final_task(task: asyncio.Task[Any]) -> None:
            pending_processor_final_tasks.add(task)
            background_tasks.add(task)
            task.add_done_callback(pending_processor_final_tasks.discard)
            task.add_done_callback(background_tasks.discard)

        def _track_stt_chunk_task(task: asyncio.Task[Any]) -> None:
            pending_stt_chunk_tasks.add(task)
            background_tasks.add(task)
            task.add_done_callback(pending_stt_chunk_tasks.discard)
            task.add_done_callback(background_tasks.discard)

        async def _processor_handle_final_text(
            text: str,
            speaker_segments: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            if speaker_segments:
                try:
                    await processor.handle_final_text(text, speaker_segments=speaker_segments)
                    return
                except TypeError as exc:
                    if "speaker_segments" not in str(exc):
                        raise
                    logger.debug(
                        "[WS] Processor handle_final_text does not accept speaker_segments; retrying without labels."
                    )
            await processor.handle_final_text(text)

        async def _run_processor_final(
            text: str,
            speaker_segments: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            try:
                async with processor_lock:
                    await _processor_handle_final_text(text, speaker_segments=speaker_segments)
            except Exception as exc:
                logger.exception("[WS] Final transcript processing failed: %s", exc)
                await _safe_send_json(
                    websocket,
                    {
                        "type": "processing_status",
                        "level": "error",
                        "message": "Failed to process final transcript into graph data.",
                        "context": {"error": str(exc), "stage": "handle_final_text"},
                    },
                )

        async def _persist_event(
            event_type: str,
            text: str,
            *,
            metadata: Optional[Dict[str, Any]] = None,
            timestamps: Optional[Dict[str, Any]] = None,
            emit_to_client: bool = False,
            process_final: bool = True,
            speaker_segments: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            normalized_text = str(text or "").strip()
            if not normalized_text:
                return

            event_metadata = dict(metadata or {})
            raw_stage_metrics = (
                event_metadata.get("telemetry")
                if isinstance(event_metadata.get("telemetry"), dict)
                else {}
            )
            event_metadata["telemetry"] = _build_telemetry_metadata(
                telemetry_state,
                event_type,
                raw_stage_metrics,
            )
            event_metadata.setdefault("provider", state.provider or "parakeet")

            payload = {
                "text": normalized_text,
                "metadata": event_metadata,
                "timestamps": timestamps or {},
                "speaker_id": state.speaker_id,
            }
            await persist_transcript_event(session, state, payload, event_type, normalized_text)
            await session.commit()

            if event_type == "final" and process_final:
                _track_processor_final_task(
                    asyncio.create_task(_run_processor_final(normalized_text, speaker_segments=speaker_segments))
                )

            if emit_to_client:
                await _safe_send_json(
                    websocket,
                    {
                        "type": f"transcript_{event_type}",
                        "text": normalized_text,
                        "metadata": event_metadata,
                        "timestamps": payload["timestamps"],
                    }
                )

        async def _process_audio_chunk(chunk_bytes: bytes, audio_decode_ms: float) -> None:
            nonlocal pending_partial_parts
            nonlocal pending_partial_chars
            nonlocal pending_speaker_segments
            nonlocal stt_unready_notified

            if not chunk_bytes:
                return

            if state.store_audio and state.conversation_id:
                await audio_storage.append_chunk(state.conversation_id, chunk_bytes)

            if not stt_runtime or not stt_runtime.is_ready():
                if not stt_unready_notified:
                    stt_unready_notified = True
                    await _safe_send_json(
                        websocket,
                        {
                            "type": "stt_provider_error",
                            "detail": (
                                f"No STT HTTP URL configured for provider '{state.provider}'. "
                                "Set provider HTTP URL in Settings."
                            ),
                        },
                    )
                return

            async with stt_stream_lock:
                try:
                    partial_result = await stt_runtime.push_audio_chunk(chunk_bytes)
                except Exception as exc:
                    logger.warning("STT provider request failed: %s", exc)
                    await _safe_send_json(
                        websocket,
                        {
                            "type": "stt_provider_error",
                            "detail": f"STT provider request failed: {exc}",
                        },
                    )
                    return

                if not partial_result or not partial_result.get("text"):
                    return

                partial_text = str(partial_result.get("text") or "").strip()
                if not partial_text:
                    return

                partial_metadata = (
                    partial_result.get("metadata")
                    if isinstance(partial_result.get("metadata"), dict)
                    else {}
                )
                telemetry_overrides: Dict[str, Any] = {}
                decoded_ms = _coerce_latency_ms(audio_decode_ms)
                if decoded_ms is not None:
                    telemetry_overrides["audio_decode_ms"] = decoded_ms
                stt_request_ms = _coerce_latency_ms(partial_metadata.get("stt_request_ms"))
                if stt_request_ms is not None:
                    telemetry_overrides["stt_request_ms"] = stt_request_ms
                if telemetry_overrides:
                    existing_telemetry = (
                        partial_metadata.get("telemetry")
                        if isinstance(partial_metadata.get("telemetry"), dict)
                        else {}
                    )
                    partial_metadata["telemetry"] = {
                        **existing_telemetry,
                        **telemetry_overrides,
                    }
                await _persist_event(
                    "partial",
                    partial_text,
                    metadata=partial_metadata,
                    emit_to_client=True,
                )
                pending_partial_parts.append(partial_text)
                pending_partial_chars += len(partial_text)

                # Accumulate speaker segments from diarized STT response
                chunk_segments = partial_result.get("segments")
                if isinstance(chunk_segments, list):
                    pending_speaker_segments.extend(chunk_segments)

                if _should_emit_final_segment(
                    partial_text,
                    pending_partial_parts,
                    pending_partial_chars,
                ):
                    final_text = " ".join(pending_partial_parts).strip()
                    final_segments = pending_speaker_segments if pending_speaker_segments else None
                    await _persist_event(
                        "final",
                        final_text,
                        metadata={
                            **partial_metadata,
                            "aggregated_parts": len(pending_partial_parts),
                            "transport": "backend_http_stt",
                        },
                        emit_to_client=True,
                        speaker_segments=final_segments,
                    )
                    pending_partial_parts = []
                    pending_partial_chars = 0
                    pending_speaker_segments = []

        try:
            while True:
                message = await websocket.receive_text()
                payload = json.loads(message)
                msg_type = payload.get("type")

                if msg_type == "session_meta":
                    stt_flush_requested = False
                    if pending_stt_chunk_tasks:
                        for task in list(pending_stt_chunk_tasks):
                            task.cancel()
                        await asyncio.gather(*list(pending_stt_chunk_tasks), return_exceptions=True)
                    pending_partial_parts = []
                    pending_partial_chars = 0
                    pending_speaker_segments = []
                    stt_unready_notified = False
                    telemetry_state = {
                        "audio_send_started_at_ms": None,
                        "first_partial_at_ms": None,
                        "first_final_at_ms": None,
                    }

                    conversation_id = payload.get("conversation_id")
                    if not conversation_id:
                        await websocket.send_json({"type": "error", "detail": "Missing conversation_id"})
                        continue
                    stt_settings: Dict[str, Any] = {}
                    try:
                        stt_settings = await _load_stt_settings(session)
                    except Exception as exc:
                        logger.warning("Unable to load STT settings during session setup: %s", exc)

                    normalized_provider = _normalize_provider(
                        payload.get("provider"),
                        stt_settings.get("provider"),
                    )
                    provider_http_urls = (
                        stt_settings.get("provider_http_urls")
                        if isinstance(stt_settings.get("provider_http_urls"), dict)
                        else {}
                    )
                    provider_http_url = str(
                        payload.get("provider_http_url")
                        or provider_http_urls.get(normalized_provider)
                        or stt_settings.get("http_url")
                        or ""
                    ).strip()

                    state.conversation_id = conversation_id
                    state.session_id = payload.get("session_id") or str(uuid.uuid4())
                    state.provider = normalized_provider
                    default_store_audio = bool(stt_settings.get("store_audio"))
                    state.store_audio = bool(payload.get("store_audio", default_store_audio))
                    state.speaker_id = payload.get("speaker_id", state.speaker_id)
                    state.metadata = payload.get("metadata") or {}

                    stt_runtime = RealtimeHttpSttSession(
                        provider=normalized_provider,
                        http_url=provider_http_url,
                        sample_rate_hz=_safe_int(
                            payload.get("sample_rate_hz") or stt_settings.get("sample_rate_hz"),
                            16000,
                        ),
                        chunk_seconds=_safe_float(
                            payload.get("http_chunk_seconds") or stt_settings.get("http_chunk_seconds"),
                            1.2,
                        ),
                        timeout_seconds=_safe_float(stt_settings.get("http_timeout_seconds"), 30.0),
                        model=str(stt_settings.get("http_model") or ""),
                        language=str(stt_settings.get("http_language") or ""),
                    )

                    await websocket.send_json({
                        "type": "session_ack",
                        "conversation_id": conversation_id,
                        "session_id": state.session_id,
                        "store_audio": state.store_audio,
                        "provider": normalized_provider,
                        "provider_http_url": provider_http_url or None,
                        "stt_mode": "backend_http",
                        "stt_ready": bool(stt_runtime.is_ready()),
                    })
                    continue

                if msg_type == "audio_chunk":
                    if not state.conversation_id:
                        await websocket.send_json({"type": "error", "detail": "session_meta must be sent first"})
                        continue

                    if stt_flush_requested:
                        await _safe_send_json(
                            websocket,
                            {
                                "type": "processing_status",
                                "level": "warning",
                                "message": "Ignoring audio chunk after final_flush request.",
                                "context": {"stage": "audio_chunk"},
                            },
                        )
                        continue

                    if telemetry_state.get("audio_send_started_at_ms") is None:
                        telemetry_state["audio_send_started_at_ms"] = _now_ms()

                    decode_started_at = time.perf_counter()
                    try:
                        chunk_bytes = decode_audio_base64(
                            payload.get("audio_base64") or payload.get("audio_b64")
                        )
                    except ValueError as exc:
                        await websocket.send_json({"type": "error", "detail": str(exc)})
                        continue

                    audio_decode_ms = _elapsed_ms(decode_started_at)

                    if not chunk_bytes:
                        continue

                    _track_stt_chunk_task(
                        asyncio.create_task(_process_audio_chunk(chunk_bytes, audio_decode_ms))
                    )
                    continue

                if msg_type in {"transcript_partial", "transcript_final"}:
                    if not state.conversation_id:
                        await websocket.send_json({"type": "error", "detail": "session_meta must be sent first"})
                        continue
                    text = payload.get("text", "")
                    if not text:
                        continue
                    event_type = "final" if msg_type == "transcript_final" else "partial"
                    await _persist_event(
                        event_type,
                        text,
                        metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
                        timestamps=payload.get("timestamps") if isinstance(payload.get("timestamps"), dict) else {},
                        emit_to_client=False,
                    )
                    continue

                if msg_type == "final_flush":
                    stt_flush_requested = True
                    flush_started_at = time.perf_counter()
                    flush_stage_metrics: Dict[str, Any] = {}
                    flush_stage_metrics["pending_stt_chunks"] = len(pending_stt_chunk_tasks)
                    flush_stage_metrics["final_flush_total_ms"] = _elapsed_ms(flush_started_at)
                    flush_payload: Dict[str, Any] = {
                        "type": "flush_ack",
                        "telemetry": {
                            key: value
                            for key, value in flush_stage_metrics.items()
                            if _coerce_latency_ms(value) is not None
                        },
                    }
                    await _safe_send_json(websocket, flush_payload)

                    async def _run_post_flush_processing() -> None:
                        nonlocal pending_partial_parts
                        nonlocal pending_partial_chars
                        nonlocal pending_speaker_segments
                        try:
                            if pending_stt_chunk_tasks:
                                await asyncio.gather(
                                    *list(pending_stt_chunk_tasks),
                                    return_exceptions=True,
                                )

                            flush_final_metadata: Dict[str, Any] = {}
                            final_text_for_post_flush: Optional[str] = None
                            final_segments_for_post_flush: Optional[List[Dict[str, Any]]] = None
                            if stt_runtime and stt_runtime.is_ready():
                                async with stt_stream_lock:
                                    stt_flush_started_at = time.perf_counter()
                                    try:
                                        final_result = await stt_runtime.flush()
                                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                                    except Exception as exc:
                                        logger.warning("STT provider flush failed: %s", exc)
                                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                                        await _safe_send_json(
                                            websocket,
                                            {"type": "stt_provider_error", "detail": f"STT flush failed: {exc}"},
                                        )
                                        final_result = None

                                    if final_result and final_result.get("text"):
                                        final_text_piece = str(final_result.get("text") or "").strip()
                                        if final_text_piece:
                                            flush_final_metadata = (
                                                final_result.get("metadata")
                                                if isinstance(final_result.get("metadata"), dict)
                                                else {}
                                            )
                                            stt_request_ms = _coerce_latency_ms(
                                                flush_final_metadata.get("stt_request_ms")
                                            )
                                            telemetry_overrides: Dict[str, Any] = {}
                                            if stt_request_ms is not None:
                                                telemetry_overrides["stt_request_ms"] = stt_request_ms
                                            normalized_flush_ms = _coerce_latency_ms(stt_flush_ms)
                                            if normalized_flush_ms is not None:
                                                telemetry_overrides["stt_flush_request_ms"] = normalized_flush_ms
                                            if telemetry_overrides:
                                                existing_telemetry = (
                                                    flush_final_metadata.get("telemetry")
                                                    if isinstance(flush_final_metadata.get("telemetry"), dict)
                                                    else {}
                                                )
                                                flush_final_metadata["telemetry"] = {
                                                    **existing_telemetry,
                                                    **telemetry_overrides,
                                                }
                                            pending_partial_parts.append(final_text_piece)
                                            pending_partial_chars += len(final_text_piece)
                                            # Accumulate segments from flush result
                                            flush_segments = final_result.get("segments")
                                            if isinstance(flush_segments, list):
                                                pending_speaker_segments.extend(flush_segments)

                            if pending_partial_parts:
                                final_text = " ".join(pending_partial_parts).strip()
                                flush_speaker_segments = pending_speaker_segments if pending_speaker_segments else None
                                final_event_metadata: Dict[str, Any] = {
                                    **flush_final_metadata,
                                    "aggregated_parts": len(pending_partial_parts),
                                    "transport": "backend_http_stt",
                                }
                                await _persist_event(
                                    "final",
                                    final_text,
                                    metadata=final_event_metadata,
                                    emit_to_client=True,
                                    process_final=False,
                                    speaker_segments=flush_speaker_segments,
                                )
                                final_text_for_post_flush = final_text
                                final_segments_for_post_flush = flush_speaker_segments
                                pending_partial_parts = []
                                pending_partial_chars = 0
                                pending_speaker_segments = []

                            if state.store_audio and state.conversation_id:
                                finalized = await audio_storage.finalize(state.conversation_id)
                                audio_ready_payload: Dict[str, Any] = {
                                    "type": "audio_ready",
                                    "audio_paths": finalized,
                                }
                                if finalized.get("wav_path") and DOWNLOAD_TOKEN:
                                    audio_ready_payload["download_url"] = (
                                        f"/api/conversations/{state.conversation_id}/audio?token={DOWNLOAD_TOKEN}"
                                    )
                                await _safe_send_json(websocket, audio_ready_payload)

                            if pending_processor_final_tasks:
                                await asyncio.gather(
                                    *list(pending_processor_final_tasks),
                                    return_exceptions=True,
                                )
                            async with processor_lock:
                                if final_text_for_post_flush:
                                    await _processor_handle_final_text(
                                        final_text_for_post_flush,
                                        speaker_segments=final_segments_for_post_flush,
                                    )
                                await processor.flush()
                        except Exception as exc:
                            logger.exception("[WS] Processor flush failed: %s", exc)
                            await _safe_send_json(
                                websocket,
                                {
                                    "type": "processing_status",
                                    "level": "error",
                                    "message": "Final flush failed while generating graph updates.",
                                    "context": {"error": str(exc), "stage": "flush"},
                                },
                            )

                    _track_background_task(asyncio.create_task(_run_post_flush_processing()))
                    continue

                if msg_type == "client_log":
                    logger.info("[CLIENT LOG] %s", payload.get("message"))
                    continue

                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue

        except WebSocketDisconnect:
            logger.info("[WS] Client disconnected")
        except RuntimeError as exc:
            if "WebSocket is not connected" in str(exc):
                logger.info("[WS] Client disconnected")
            else:
                logger.exception("[WS] Runtime error in transcript websocket: %s", exc)
                await _safe_send_json(websocket, {"type": "error", "detail": "Internal server error"})
                if _ws_is_connected(websocket):
                    try:
                        await websocket.close(code=1011)
                    except RuntimeError:
                        pass
        except Exception as exc:
            logger.exception("[WS] Error processing transcript websocket: %s", exc)
            await _safe_send_json(websocket, {"type": "error", "detail": "Internal server error"})
            if _ws_is_connected(websocket):
                try:
                    await websocket.close(code=1011)
                except RuntimeError:
                    pass
        finally:
            if pending_stt_chunk_tasks:
                for task in list(pending_stt_chunk_tasks):
                    task.cancel()
                await asyncio.gather(*list(pending_stt_chunk_tasks), return_exceptions=True)
            if stt_runtime:
                try:
                    await stt_runtime.close()
                except Exception as exc:
                    logger.debug("[WS] stt_runtime.close() failed: %s", exc)


async def _send_processor_update(websocket: WebSocket, existing_json: Any, chunk_dict: Any):
    try:
        if websocket.client_state.name != "CONNECTED":
            return
        await websocket.send_json({"type": "existing_json", "data": existing_json})
        await websocket.send_json({"type": "chunk_dict", "data": chunk_dict})
    except WebSocketDisconnect:
        logger.info("[WS] Processor update failed - client disconnected")
    except RuntimeError:
        logger.info("[WS] Processor update failed - websocket already closed")

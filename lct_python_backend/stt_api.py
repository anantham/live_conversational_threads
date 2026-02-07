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
from sqlalchemy import select

from lct_python_backend.db_session import get_async_session, get_async_session_context
from lct_python_backend.models import AppSetting
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.stt_config import (
    STT_CONFIG_KEY,
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


@router.get("/api/settings/stt")
async def read_stt_settings(session=Depends(get_async_session)):
    setting = await session.execute(
        select(AppSetting).where(AppSetting.key == STT_CONFIG_KEY)
    )
    value = setting.scalar_one_or_none()
    overrides = value.value if value else {}
    return merge_stt_config(overrides)


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

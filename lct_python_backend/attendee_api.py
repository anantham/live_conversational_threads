"""Attendee meeting-bot integration endpoints.

Flow:
  1. ``POST /api/attendee/meetings`` — start a backend-owned meeting session
     (loopback producer -> /ws/transcripts, creates the conversation) and ask the
     self-hosted Attendee instance to send a bot into the Google Meet link.
  2. ``POST /api/attendee/webhook`` — receive Attendee events (``transcript.update``,
     ``bot.state_change``), verify the HMAC signature, and drive the bridge. This
     endpoint is HMAC-authenticated, not bearer-authenticated, so it is exempted
     from the AUTH/RATE-LIMIT middleware (see ``middleware._is_attendee_webhook``).
  3. ``GET /api/attendee/meetings/{conversation_id}`` — bot/meeting status.
  4. ``WS /ws/meeting/{conversation_id}`` — read-only viewer; the bridge fans out
     the exact live-graph protocol (existing_json / graph_patch / ...) so the
     frontend reuses its recording-path handlers with no new graph code.

The webhook is registered ONCE at the Attendee *project* level pointing at
``http://host.docker.internal:<lct_port>/api/attendee/webhook`` (Attendee's
inline create-bot webhooks force https://; the project path allows http when
``REQUIRE_HTTPS_WEBHOOKS=false``). Every event carries ``bot_id`` so the bridge
routes it to the right meeting.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from lct_python_backend.middleware import check_ws_auth_message
from lct_python_backend.services import attendee_bridge, attendee_client
from lct_python_backend.services.env_helpers import env_bool, env_str, env_str_or_none

logger = logging.getLogger("lct_backend")

router = APIRouter(prefix="/api/attendee", tags=["attendee"])
ws_router = APIRouter()  # no prefix — viewer WS lives at /ws/meeting/{id}

WEBHOOK_PATH = "/api/attendee/webhook"
WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature"

# Per-webhook signing secret (base64) from Attendee's Settings -> Webhooks.
ATTENDEE_WEBHOOK_SECRET: Optional[str] = env_str_or_none("ATTENDEE_WEBHOOK_SECRET")
# "custom_async" (self-hosted STT via the shim) or "closed_captions" (Meet's own
# captions — zero extra infra, proven fallback). Default: self-hosted.
ATTENDEE_TRANSCRIPTION_MODE: str = env_str("ATTENDEE_TRANSCRIPTION_MODE", "custom_async").strip().lower()
ATTENDEE_STT_LANGUAGE: str = env_str("ATTENDEE_STT_LANGUAGE", "en")
# Recording format for the custom-async path. Recording is enabled so per-utterance
# audio blobs exist for Attendee to POST to the shim ("mp3" = audio only, light).
ATTENDEE_RECORDING_FORMAT: str = env_str("ATTENDEE_RECORDING_FORMAT", "mp3")


# --- models -----------------------------------------------------------------

class CreateMeetingRequest(BaseModel):
    meeting_url: str = Field(..., description="Google Meet / Zoom / Teams URL the bot should join")
    bot_name: Optional[str] = Field(default=None, description="Display name shown in the meeting")
    dry_run: bool = Field(
        default=False,
        description="Test mode: start the bridge session WITHOUT dispatching a real Attendee bot. "
        "Only honored when ATTENDEE_ALLOW_DRY_RUN=1. Lets the loopback->/ws/transcripts->viewer "
        "pipeline be exercised by POSTing synthetic webhooks (no Docker/Meet needed).",
    )


# --- helpers ----------------------------------------------------------------

def _build_bot_settings() -> Dict[str, Any]:
    """transcription_settings + recording_settings for the create-bot call.

    Webhooks are NOT included inline (Attendee forces https:// on inline create
    webhooks); the project-level webhook handles delivery.
    """
    if ATTENDEE_TRANSCRIPTION_MODE == "closed_captions":
        # Do NOT record a meeting MP3: its only consumer was the slow-pass, which
        # is not shipped (audit A4). Recording a full audio file nobody uses is a
        # needless privacy/storage cost; closed-captions mode needs no local audio.
        return {
            "transcription_settings": {
                "meeting_closed_captions": {"google_meet_language": f"{ATTENDEE_STT_LANGUAGE}-US"}
            },
            "recording_settings": {"format": "none"},
        }
    # default: self-hosted STT via the Custom Async v2 contract (-> shim).
    return {
        "transcription_settings": {
            "custom_async_v2": {"form_data": {"language": ATTENDEE_STT_LANGUAGE}}
        },
        "recording_settings": {"format": ATTENDEE_RECORDING_FORMAT},
    }


def _verify_signature(raw_body: bytes, signature_header: Optional[str]) -> bool:
    """Validate X-Webhook-Signature = base64(HMAC-SHA256(secret, canonical_json)).

    Canonicalization MUST match Attendee exactly: json.dumps(payload,
    sort_keys=True, ensure_ascii=False, separators=(",", ":")), and the stored
    secret is base64 and must be DECODED before HMAC. When no secret is
    configured, verification is skipped (dev mode).
    """
    if not ATTENDEE_WEBHOOK_SECRET:
        return True
    if not signature_header:
        return False
    try:
        payload = json.loads(raw_body)
        secret = base64.b64decode(ATTENDEE_WEBHOOK_SECRET)
    except Exception:
        return False
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    expected = base64.b64encode(hmac.new(secret, canonical, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(expected, signature_header.strip())


# --- endpoints --------------------------------------------------------------

@router.get("/health", tags=["health"])
async def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "attendee_api",
        "attendee_configured": attendee_client.is_configured(),
        "transcription_mode": ATTENDEE_TRANSCRIPTION_MODE,
        "webhook_secret_set": bool(ATTENDEE_WEBHOOK_SECRET),
    }


@router.post("/meetings")
async def create_meeting(req: CreateMeetingRequest):
    """Start a meeting session and dispatch an Attendee bot to join the link."""
    dry_run = bool(req.dry_run) and env_bool("ATTENDEE_ALLOW_DRY_RUN", False)
    if not dry_run and not attendee_client.is_configured():
        return JSONResponse(
            status_code=400,
            content={"detail": "Attendee not configured. Set ATTENDEE_API_KEY (and ATTENDEE_BASE_URL) in lct_python_backend/.env."},
        )
    meeting_url = (req.meeting_url or "").strip()
    if not (meeting_url.startswith("http://") or meeting_url.startswith("https://")):
        return JSONResponse(status_code=422, content={"detail": "meeting_url must be an http(s) URL"})

    conversation_id = str(uuid.uuid4())
    bot_name = req.bot_name or attendee_client.ATTENDEE_BOT_NAME

    session = attendee_bridge.MeetingSession(
        conversation_id=conversation_id, meeting_url=meeting_url, bot_name=bot_name
    )
    try:
        await session.start()  # opens loopback producer + creates the conversation row
    except Exception as exc:  # noqa: BLE001
        logger.exception("[attendee] failed to start meeting session: %s", exc)
        return JSONResponse(status_code=502, content={"detail": f"Could not start live-graph session: {exc}"})
    await attendee_bridge.register(session)

    if dry_run:
        # No real bot: synthesize a bot_id so synthetic webhooks can route here.
        bot_id = f"dryrun-{conversation_id[:8]}"
        await attendee_bridge.bind_bot(session, bot_id)
        logger.info("[attendee] DRY RUN meeting started conv=%s bot=%s", conversation_id, bot_id)
        return {
            "conversation_id": conversation_id,
            "bot_id": bot_id,
            "bot_state": "dry_run",
            "status": session.status,
            "viewer_ws": f"/ws/meeting/{conversation_id}",
            "dry_run": True,
        }

    settings = _build_bot_settings()
    # NO inline webhooks here: Attendee forces https:// on inline create-bot
    # webhooks (serializers ^https://.*), and our receiver is plain http on the
    # LAN. Delivery is handled by the PROJECT-level webhook registered in the
    # Attendee dashboard (http allowed via REQUIRE_HTTPS_WEBHOOKS=false); every
    # event carries bot_id so the bridge routes it. See docs/attendee-meeting-bot-setup.md.
    try:
        bot = await attendee_client.create_bot(
            meeting_url=meeting_url,
            bot_name=bot_name,
            transcription_settings=settings.get("transcription_settings"),
            recording_settings=settings.get("recording_settings"),
            metadata={"lct_conversation_id": conversation_id},
        )
    except attendee_client.AttendeeError as exc:
        await session.close(reason="create_bot_failed")
        logger.error("[attendee] create_bot failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    bot_id = str(bot.get("id") or "")
    if bot_id:
        await attendee_bridge.bind_bot(session, bot_id)
    return {
        "conversation_id": conversation_id,
        "bot_id": bot_id,
        "bot_state": bot.get("state"),
        "status": session.status,
        "viewer_ws": f"/ws/meeting/{conversation_id}",
    }


@router.get("/meetings/{conversation_id}")
async def meeting_status(conversation_id: str):
    session = attendee_bridge.get_by_conversation(conversation_id)
    if session is None:
        return JSONResponse(status_code=404, content={"detail": "no active meeting for this conversation"})
    return session.public_status()


@router.post("/webhook")
async def attendee_webhook(request: Request):
    """Receive an Attendee webhook event and drive the matching meeting bridge."""
    recv_wall = time.time()  # webhook arrival time, for speech->shown latency
    raw = await request.body()
    if not _verify_signature(raw, request.headers.get(WEBHOOK_SIGNATURE_HEADER)):
        logger.warning("[attendee] webhook signature verification failed")
        return JSONResponse(status_code=401, content={"detail": "invalid signature"})
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "malformed json"})

    trigger = body.get("trigger")
    bot_id = body.get("bot_id")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    session = attendee_bridge.get_by_bot(str(bot_id)) if bot_id else None
    if session is None:
        # Unknown/stale bot — ack so Attendee stops retrying.
        return {"ok": True, "ignored": "unknown_bot", "bot_id": bot_id}

    if session.already_seen(body.get("idempotency_key")):
        return {"ok": True, "deduped": True}

    try:
        if trigger == "transcript.update":
            transcription = data.get("transcription") if isinstance(data.get("transcription"), dict) else {}
            text = transcription.get("transcript") or ""
            await session.inject_utterance(
                text=text,
                speaker_name=data.get("speaker_name"),
                speaker_uuid=data.get("speaker_uuid"),
                speaker_is_host=data.get("speaker_is_host"),
                timestamp_ms=data.get("timestamp_ms"),
                duration_ms=data.get("duration_ms"),
                recv_wall=recv_wall,
            )
        elif trigger == "bot.state_change":
            new_state = data.get("new_state")
            await session.on_bot_state(new_state, sub_type=data.get("event_sub_type"))
            
            # Slow-pass (high-fidelity MP3 re-transcription) is intentionally NOT
            # wired up. The prototype DESTRUCTIVELY overwrote live utterance text
            # (audit A4) and decision B requires a review-gated transcript-revision
            # flow first. No auto-trigger ships until that exists — when it does,
            # enqueue the NON-destructive revision build here (not the old in-place
            # patch), and gate any meeting-audio recording behind the same path.

        else:
            logger.debug("[attendee] ignoring webhook trigger=%s", trigger)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[attendee] error handling webhook trigger=%s: %s", trigger, exc)
        # Still 200 so Attendee doesn't hammer retries on a transient bug.
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@ws_router.websocket("/ws/meeting/{conversation_id}")
async def meeting_viewer_ws(websocket: WebSocket, conversation_id: str):
    """Read-only viewer: replays the meeting's graph history then streams live
    updates in the SAME protocol the recording path emits."""
    await websocket.accept()
    if not await check_ws_auth_message(websocket):
        return
    session = attendee_bridge.get_by_conversation(conversation_id)
    if session is None:
        try:
            await websocket.send_json({"type": "error", "detail": "no active meeting for this conversation"})
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    queue, snapshot = await session.subscribe()
    try:
        for msg in snapshot:
            await websocket.send_json(msg)
        while True:
            msg = await queue.get()
            if msg is None:  # close sentinel
                break
            await websocket.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await session.unsubscribe(queue)

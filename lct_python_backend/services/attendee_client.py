"""Async REST client for a self-hosted Attendee instance (meeting-bot API).

Attendee (https://docs.attendee.dev, github.com/attendee-labs/attendee) runs
meeting bots that join Zoom / Google Meet / Microsoft Teams calls to record and
transcribe. This client talks to a LOCAL, self-hosted instance (default
``http://127.0.0.1:8000``) to:

  * create a bot that joins a Google Meet link, and
  * poll its lifecycle state.

Auth is DRF-style — ``Authorization: Token <api_key>`` (NOT ``Bearer``). A
Bearer header 401s.

Every call targets a loopback / LAN host, so the ``LCT_LOCAL_ONLY`` egress
chokepoint (ADR-034) permits it — ``egress_guard.is_local_host`` classifies
``127.0.0.1`` / ``localhost`` as local. Attendee's web app is published to the
Windows host on :8000 by Docker, so ``127.0.0.1:8000`` reaches it.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from lct_python_backend.services.env_helpers import env_str, env_str_or_none, env_float

logger = logging.getLogger("lct_backend")

# --- Config (module-import-time reads) --------------------------------------

# Base URL of the self-hosted Attendee web/API app (Docker publishes :8000).
ATTENDEE_BASE_URL: str = env_str("ATTENDEE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
# API key minted in Attendee's web UI (Settings -> API Keys). Stored hashed
# server-side; copy the plaintext on creation, it can't be retrieved later.
ATTENDEE_API_KEY: Optional[str] = env_str_or_none("ATTENDEE_API_KEY")
# Display name the bot shows in the participant list.
ATTENDEE_BOT_NAME: str = env_str("ATTENDEE_BOT_NAME", "LCT Live Graph")
# httpx timeout for control-plane calls (create/get bot). Joining is async on
# Attendee's side — create returns immediately with a bot id.
ATTENDEE_HTTP_TIMEOUT_S: float = env_float("ATTENDEE_HTTP_TIMEOUT_S", 30.0)

API_V1 = "/api/v1"


class AttendeeError(RuntimeError):
    """Raised when an Attendee API call fails or is misconfigured."""


class AttendeeNotConfigured(AttendeeError):
    """Raised when ATTENDEE_API_KEY is missing."""


def is_configured() -> bool:
    """True when an API key is present (the only hard requirement to call out)."""
    return bool(ATTENDEE_API_KEY)


def _auth_headers() -> Dict[str, str]:
    if not ATTENDEE_API_KEY:
        raise AttendeeNotConfigured(
            "ATTENDEE_API_KEY is not set. Mint a key in the self-hosted Attendee "
            "web UI (Settings -> API Keys) and add it to lct_python_backend/.env."
        )
    return {
        "Authorization": f"Token {ATTENDEE_API_KEY}",
        "Content-Type": "application/json",
    }


async def _request(method: str, path: str, *, json_body: Optional[dict] = None) -> Dict[str, Any]:
    url = f"{ATTENDEE_BASE_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=ATTENDEE_HTTP_TIMEOUT_S) as client:
            resp = await client.request(method, url, headers=_auth_headers(), json=json_body)
    except httpx.HTTPError as exc:  # connect/timeout/transport
        raise AttendeeError(
            f"Could not reach Attendee at {url}: {exc}. Is the self-hosted stack "
            f"running (docker compose ... up) and ATTENDEE_BASE_URL correct?"
        ) from exc

    if resp.status_code >= 400:
        body_preview = resp.text[:500]
        raise AttendeeError(
            f"Attendee {method} {path} -> HTTP {resp.status_code}: {body_preview}"
        )
    if not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError as exc:
        raise AttendeeError(
            f"Attendee {method} {path} returned non-JSON body: {resp.text[:200]}"
        ) from exc


async def create_bot(
    *,
    meeting_url: str,
    bot_name: Optional[str] = None,
    transcription_settings: Optional[Dict[str, Any]] = None,
    webhooks: Optional[List[Dict[str, Any]]] = None,
    recording_settings: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a bot that joins ``meeting_url``.

    Returns the created bot object (includes ``id`` and ``state``). Attendee
    infers the platform (Meet/Zoom/Teams) from the URL. ``transcription_settings``
    and ``webhooks`` are passed through verbatim so the caller controls the
    provider (e.g. self-hosted STT) and which triggers to subscribe to.
    """
    body: Dict[str, Any] = {
        "meeting_url": meeting_url,
        "bot_name": bot_name or ATTENDEE_BOT_NAME,
    }
    if transcription_settings is not None:
        body["transcription_settings"] = transcription_settings
    if webhooks is not None:
        body["webhooks"] = webhooks
    if recording_settings is not None:
        body["recording_settings"] = recording_settings
    if metadata is not None:
        body["metadata"] = metadata

    logger.info("[attendee] create_bot meeting_url=%s name=%s", meeting_url, body["bot_name"])
    bot = await _request("POST", f"{API_V1}/bots", json_body=body)
    logger.info("[attendee] bot created id=%s state=%s", bot.get("id"), bot.get("state"))
    return bot


async def get_bot(bot_id: str) -> Dict[str, Any]:
    """Fetch a bot's current object (includes ``state``, ``transcription_state``)."""
    return await _request("GET", f"{API_V1}/bots/{bot_id}")


async def leave_bot(bot_id: str) -> Dict[str, Any]:
    """Ask the bot to leave the meeting (best-effort; idempotent on Attendee)."""
    return await _request("POST", f"{API_V1}/bots/{bot_id}/leave")

"""
Public conversation shares with Google-gated email allowlists.

Architecture (see share_conversation_links migration for schema rationale):

    1. Operator hits POST /api/conversations/{id}/share with an optional
       email allowlist. Server mints a URL-safe token and stores it in
       shared_conversation_links.

    2. Recipient opens https://<host>/share/<token>. The frontend hits
       GET /api/share/<token>:
         - If the share has no allowed_emails: returns immediately.
         - If it has allowed_emails: returns 401 with auth_required=google.
       The frontend then prompts a Google Identity Services sign-in,
       receives an ID token, and retries the request with
       Authorization: Bearer <google_id_token>.

    3. The backend verifies the ID token against Google's public certs
       (google-auth library does the JWT crypto, cert fetch, issuer
       check, and expiry check). If verified, we extract the email
       claim and check it against allowed_emails. Mismatch → 403.

    4. On success the response carries the same shape as
       /conversations/{id} so the existing ViewConversation component
       can render it unchanged.

The share endpoints are exempted from AUTH_TOKEN middleware via the
PUBLIC_PATH_PREFIXES list (see middleware.py).

Two security boundaries this carries:

    - URL token: opaque random 32-byte value. Knowing it == owning the
      share row. Anyone who shares the URL leaks access (mitigation:
      email allowlist).
    - Email allowlist: rooted in Google's identity assertion. Verifying
      the ID token's signature + aud against GOOGLE_OAUTH_CLIENT_ID
      means the email claim is trustworthy. Without that env var set,
      email-restricted shares fail closed (503).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.config import AUDIO_RECORDINGS_DIR
from lct_python_backend.db_session import get_async_session

logger = logging.getLogger(__name__)

router = APIRouter()

GOOGLE_OAUTH_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID")

# Server secret for HMAC-signing per-share audio URLs. The signature
# carries (share_token, expiry) so a leaked audio URL only works until
# expiry and only for the specific share. Auto-generated at import time
# if not set, with a loud warning — the audio URLs minted in one server
# process will stop verifying after a restart, but that's acceptable
# (the recipient just hits the share page again and gets a fresh URL).
SHARE_AUDIO_SIGNING_KEY = os.getenv("SHARE_AUDIO_SIGNING_KEY")
if not SHARE_AUDIO_SIGNING_KEY:
    SHARE_AUDIO_SIGNING_KEY = secrets.token_urlsafe(48)
    logger.warning(
        "SHARE_AUDIO_SIGNING_KEY not set; using a per-process random key. "
        "Audio URLs minted by this process will stop working after restart. "
        "Set a stable value in .env for persistent share audio links."
    )

# How long a signed audio URL is valid. Refreshed on every share-fetch.
# 1 hour is enough for a recipient to listen through a long conversation
# without re-fetching; short enough that a leaked URL has a tight window.
SHARE_AUDIO_SIGNATURE_TTL_SECONDS = 60 * 60


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ShareCreateRequest(BaseModel):
    """Per-share gate config. allowed_emails None → public-by-link."""

    allowed_emails: Optional[List[str]] = Field(
        default=None,
        description=(
            "Lowercased Google account emails permitted to view this share. "
            "When None or empty, the share is public-by-link (anyone with "
            "the URL can view)."
        ),
    )
    expires_at: Optional[datetime] = Field(
        default=None,
        description="Optional auto-expiry. None = never expires.",
    )


class ShareRow(BaseModel):
    """One row from shared_conversation_links, serialized for the operator."""

    token: str
    conversation_id: str
    allowed_emails: Optional[List[str]] = None
    created_at: datetime
    revoked_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    view_count: int
    last_viewed_at: Optional[datetime] = None
    last_viewed_by: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_emails(emails: Optional[List[str]]) -> Optional[str]:
    """Lowercase + dedupe + JSON-encode the allowlist. None / empty → None."""
    if not emails:
        return None
    cleaned = sorted({e.strip().lower() for e in emails if e and e.strip()})
    if not cleaned:
        return None
    return json.dumps(cleaned)


def _parse_emails(raw: Optional[str]) -> Optional[List[str]]:
    """Inverse of _normalize_emails for response serialization."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(e) for e in parsed]
    except json.JSONDecodeError:
        logger.warning("Malformed allowed_emails JSON: %r", raw)
    return None


async def _verify_google_id_token(id_token_str: str) -> str:
    """
    Verify a Google Identity Services ID token. Returns the verified
    email. Raises HTTPException on any failure (network, signature,
    expiry, audience mismatch).

    Requires GOOGLE_OAUTH_CLIENT_ID env. We do NOT short-circuit when
    unset because that would silently degrade email gating to "trust
    the client" — the caller already checks GOOGLE_OAUTH_CLIENT_ID
    before reaching this function for restricted shares.
    """
    if not GOOGLE_OAUTH_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="Share-link Google verification is not configured on this server.",
        )
    try:
        # Local import keeps google-auth optional at import time; the
        # endpoint only fails when actually invoked on a restricted share.
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token as google_id_token

        info = google_id_token.verify_oauth2_token(
            id_token_str,
            google_requests.Request(),
            GOOGLE_OAUTH_CLIENT_ID,
        )
    except ValueError as exc:
        logger.warning("Google ID token verify failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Google ID token.")
    except Exception:
        logger.exception("Google ID token verify threw unexpectedly")
        raise HTTPException(status_code=500, detail="Identity verification failed.")

    email = info.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Google ID token has no email claim.")
    if not info.get("email_verified", False):
        raise HTTPException(status_code=403, detail="Google account email is not verified.")
    return str(email).strip().lower()


_AUDIO_MEDIA_TYPES = {
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
    ".mp4": "audio/mp4",
}


def _resolve_audio_file(conversation_id: str) -> Optional[Tuple[Path, str]]:
    """Look up the recording file for a conversation; return (path,
    media_type) or None. Mirrors factcheck_api.download_audio resolution
    logic — we don't import that function because it's wrapped in HTTP
    auth checks that don't apply here."""
    recordings_root = Path(AUDIO_RECORDINGS_DIR).resolve()
    for suffix, media_type in _AUDIO_MEDIA_TYPES.items():
        candidate = Path(AUDIO_RECORDINGS_DIR) / f"{conversation_id}{suffix}"
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if not str(resolved).startswith(str(recordings_root)):
            # Path-traversal guard. resolve() collapses ../ etc., so we
            # check that the resolved path lives inside the recordings
            # root before trusting it.
            continue
        if candidate.exists():
            return candidate, media_type
    return None


def _sign_audio_url(share_token: str, expires_unix: int) -> str:
    """HMAC-SHA256 over '<share_token>|<expires_unix>' → base64url. Both
    inputs go into the payload so a sig for one share can't unlock
    another, and so the signer can verify expiry without trusting the
    client."""
    msg = f"{share_token}|{expires_unix}".encode("utf-8")
    digest = hmac.new(
        SHARE_AUDIO_SIGNING_KEY.encode("utf-8"),
        msg,
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _verify_audio_signature(share_token: str, expires_unix: int, sig: str) -> bool:
    """Constant-time compare against the expected HMAC."""
    expected = _sign_audio_url(share_token, expires_unix)
    return hmac.compare_digest(expected, sig)


def _build_share_audio_url(share_token: str) -> Tuple[str, int]:
    """Mint a signed audio URL valid for SHARE_AUDIO_SIGNATURE_TTL_SECONDS.
    Returns (url, expires_unix)."""
    expires_unix = int(time.time()) + SHARE_AUDIO_SIGNATURE_TTL_SECONDS
    sig = _sign_audio_url(share_token, expires_unix)
    url = f"/api/share/{share_token}/audio?expires={expires_unix}&sig={sig}"
    return url, expires_unix


def _share_row_to_model(row) -> ShareRow:
    return ShareRow(
        token=row.token,
        conversation_id=row.conversation_id,
        allowed_emails=_parse_emails(row.allowed_emails),
        created_at=row.created_at,
        revoked_at=row.revoked_at,
        expires_at=row.expires_at,
        view_count=int(row.view_count or 0),
        last_viewed_at=row.last_viewed_at,
        last_viewed_by=row.last_viewed_by,
    )


# ---------------------------------------------------------------------------
# Owner-side endpoints (gated by the main AUTH_TOKEN per middleware)
# ---------------------------------------------------------------------------


@router.post("/api/conversations/{conversation_id}/share", response_model=ShareRow)
async def create_share(
    conversation_id: str,
    payload: ShareCreateRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Mint a new share token for the conversation."""
    try:
        # Validate conversation exists. Reuse the same UUID-shape check
        # the read endpoint uses.
        conversation_uuid = uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation_id.")

    exists = await db.execute(
        text("SELECT 1 FROM conversations WHERE id = :id"),
        {"id": str(conversation_uuid)},
    )
    if exists.first() is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    token = secrets.token_urlsafe(32)
    allowed_json = _normalize_emails(payload.allowed_emails)

    await db.execute(
        text(
            """
            INSERT INTO shared_conversation_links
                (token, conversation_id, allowed_emails, expires_at)
            VALUES
                (:token, :conversation_id, :allowed_emails, :expires_at)
            """
        ),
        {
            "token": token,
            "conversation_id": str(conversation_uuid),
            "allowed_emails": allowed_json,
            "expires_at": payload.expires_at,
        },
    )
    await db.commit()

    row = (
        await db.execute(
            text("SELECT * FROM shared_conversation_links WHERE token = :token"),
            {"token": token},
        )
    ).first()
    return _share_row_to_model(row)


@router.get("/api/conversations/{conversation_id}/shares", response_model=List[ShareRow])
async def list_shares(
    conversation_id: str,
    include_revoked: bool = False,
    db: AsyncSession = Depends(get_async_session),
):
    """List active share tokens for a conversation."""
    try:
        conversation_uuid = uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation_id.")

    sql = """
        SELECT * FROM shared_conversation_links
        WHERE conversation_id = :conversation_id
    """
    if not include_revoked:
        sql += " AND revoked_at IS NULL"
    sql += " ORDER BY created_at DESC"

    rows = (
        await db.execute(text(sql), {"conversation_id": str(conversation_uuid)})
    ).fetchall()
    return [_share_row_to_model(r) for r in rows]


@router.delete("/api/share/{token}")
async def revoke_share(token: str, db: AsyncSession = Depends(get_async_session)):
    """Revoke a share. Idempotent — re-revoking a revoked share is a no-op."""
    result = await db.execute(
        text(
            """
            UPDATE shared_conversation_links
            SET revoked_at = COALESCE(revoked_at, NOW())
            WHERE token = :token
            """
        ),
        {"token": token},
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Share not found.")
    return {"ok": True}


# ---------------------------------------------------------------------------
# .threads export — self-contained, server-free artifact (ADR-036)
# ---------------------------------------------------------------------------


@router.get("/api/conversations/{conversation_id}/threads-export")
async def export_threads(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Export a conversation as a self-contained ``.threads`` bundle.

    The bundle carries everything the (Vercel-hosted) viewer needs to render the
    graph fully client-side: no backend at view time, no share token, no
    permissioning — possession of the file IS the capability (the owner hands it
    directly to the participant; ADR-036 D3 = participant/T0/full). Audio is
    deliberately EXCLUDED (biometric voice + size, ADR-036 D7); fact-check is an
    online-only extra absent from the static artifact. Owner-scoped: this path is
    under /api/conversations/ so it requires AUTH_TOKEN (unlike the public
    /api/share/* fetch).
    """
    from lct_python_backend.conversations_api import (
        fetch_conversation_bundle,
        build_graph_data_from_nodes,
        build_chunk_dict_from_utterances,
        build_turn_graph_from_utterances,
    )

    conversation_uuid = uuid.UUID(conversation_id)
    conversation, nodes, relationships, utterances = await fetch_conversation_bundle(
        db, conversation_uuid
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    graph_data: list = []
    chunk_dict: dict = {}
    if nodes:
        # include_edges_out=True -> faithful edge round-trip in the artifact
        # (the default-off fold path drops relationship subtype/confidence/etc.).
        graph_data = build_graph_data_from_nodes(
            nodes, relationships, utterances=utterances, include_edges_out=True
        )
        node_chunk_ids: list = []
        for n in nodes:
            if n.chunk_ids:
                node_chunk_ids.extend(n.chunk_ids)
        chunk_dict = build_chunk_dict_from_utterances(
            utterances, node_chunk_ids=node_chunk_ids
        )
    elif utterances:
        graph_data = build_turn_graph_from_utterances(utterances)
        chunk_dict = build_chunk_dict_from_utterances(utterances)

    bundle = {
        "format": "lct.threads",
        "format_version": 1,
        "exported_at": int(time.time()),
        "conversation_id": str(conversation.id),
        "conversation_name": conversation.conversation_name,
        "conversation_title": getattr(conversation, "conversation_title", None),
        "executive_summary": getattr(conversation, "executive_summary", None),
        "graph_data": graph_data,
        "chunk_dict": chunk_dict,
    }

    raw_name = (
        getattr(conversation, "conversation_title", None)
        or conversation.conversation_name
        or "conversation"
    )
    safe_name = "".join(
        c if (c.isalnum() or c in "-_ ") else "_" for c in str(raw_name)
    ).strip()[:60] or "conversation"

    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.threads"'},
    )


# ---------------------------------------------------------------------------
# Public share-fetch endpoint
# ---------------------------------------------------------------------------


@router.get("/api/share/{token}")
async def fetch_share(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Public share-fetch.

    If the share has an allowed_emails list, requires
    Authorization: Bearer <google_id_token> and the verified email must be
    in the allowlist. Bypass-able only when allowed_emails is NULL.

    On success, returns a payload shaped like /conversations/{id} (the
    frontend reuses ViewConversation in read-only mode).
    """
    row = (
        await db.execute(
            text("SELECT * FROM shared_conversation_links WHERE token = :token"),
            {"token": token},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Share not found.")
    if row.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Share has been revoked.")
    if row.expires_at is not None and row.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share has expired.")

    allowed_emails = _parse_emails(row.allowed_emails)
    verified_email: Optional[str] = None

    if allowed_emails:
        # Restricted share — require Google ID token verification.
        if not GOOGLE_OAUTH_CLIENT_ID:
            raise HTTPException(
                status_code=503,
                detail=(
                    "This share is restricted to specific Google accounts, but "
                    "the server is not configured for Google identity "
                    "verification. Ask the share owner to set GOOGLE_OAUTH_CLIENT_ID."
                ),
            )
        auth_header = request.headers.get("authorization") or ""
        if not auth_header.lower().startswith("bearer "):
            return JSONResponse(
                status_code=401,
                content={
                    "detail": "Sign in with Google to view this share.",
                    "auth_required": "google",
                    "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
                },
            )
        id_token_str = auth_header.split(" ", 1)[1].strip()
        verified_email = await _verify_google_id_token(id_token_str)
        if verified_email not in {e.lower() for e in allowed_emails}:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"The Google account {verified_email!r} is not on this "
                    "share's access list. Ask the share owner to add you."
                ),
            )

    # Fetch the conversation payload. Reuse the existing assembly logic
    # by delegating to the conversations endpoint's helpers.
    from lct_python_backend.conversations_api import (
        fetch_conversation_bundle,
        build_graph_data_from_nodes,
        build_chunk_dict_from_utterances,
        build_turn_graph_from_utterances,
    )

    conversation_uuid = uuid.UUID(row.conversation_id)
    conversation, nodes, relationships, utterances = await fetch_conversation_bundle(
        db, conversation_uuid
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation has been deleted.")

    graph_data = []
    chunk_dict: dict = {}
    if nodes:
        graph_data = build_graph_data_from_nodes(nodes, relationships, utterances=utterances)
        node_chunk_ids = []
        for n in nodes:
            if n.chunk_ids:
                node_chunk_ids.extend(n.chunk_ids)
        chunk_dict = build_chunk_dict_from_utterances(
            utterances, node_chunk_ids=node_chunk_ids
        )
    elif utterances:
        graph_data = build_turn_graph_from_utterances(utterances)
        chunk_dict = build_chunk_dict_from_utterances(utterances)

    # Bump view counters. Best-effort — failure here doesn't block the
    # response (the operator can refresh; the row exists).
    try:
        await db.execute(
            text(
                """
                UPDATE shared_conversation_links
                SET view_count = view_count + 1,
                    last_viewed_at = NOW(),
                    last_viewed_by = :viewer
                WHERE token = :token
                """
            ),
            {"token": token, "viewer": verified_email},
        )
        await db.commit()
    except Exception:
        logger.exception("Failed to bump share view counters (token=%s)", token)

    # Per-share audio URL (Phase 3). Recipients hit this URL via the
    # <audio> tag, which doesn't send Authorization headers — so auth
    # rides in the URL itself as a short-lived HMAC signature. The
    # signature binds (share_token, expiry); leaking the URL only
    # leaks audio access for this share until expiry.
    audio_url: Optional[str] = None
    audio_url_expires: Optional[int] = None
    if _resolve_audio_file(str(conversation.id)) is not None:
        audio_url, audio_url_expires = _build_share_audio_url(token)

    return {
        "conversation_id": str(conversation.id),
        "conversation_name": conversation.conversation_name,
        "conversation_title": getattr(conversation, "conversation_title", None),
        "executive_summary": getattr(conversation, "executive_summary", None),
        "graph_data": graph_data,
        "chunk_dict": chunk_dict,
        "audio_url": audio_url,
        "audio_url_expires": audio_url_expires,
        "share": {
            "token": token,
            "viewer_email": verified_email,
            "restricted": allowed_emails is not None,
        },
    }


@router.get("/api/share/{token}/audio")
async def fetch_share_audio(
    token: str,
    expires: int = Query(..., description="Unix epoch seconds the signed URL is valid until."),
    sig: str = Query(..., description="HMAC signature over '<token>|<expires>'."),
    db: AsyncSession = Depends(get_async_session),
):
    """
    Per-share audio download.

    Auth: the URL itself carries (expires, sig). HMAC-signed over
    (share_token, expires) using SHARE_AUDIO_SIGNING_KEY. Constant-time
    verified. No Google ID token needed here — the recipient already
    passed the Google gate to obtain this URL in the share-fetch
    response, and the short expiry (1 hour) bounds how long a leak is
    useful.

    The endpoint also re-checks the share row's revoke/expiry state so
    revoking a share kills audio access immediately (within the
    HMAC's lifetime; an outstanding signed URL is still walking around
    in the recipient's browser until it expires, but the underlying
    share row is now revoked, so this endpoint refuses).
    """
    if int(time.time()) > expires:
        raise HTTPException(status_code=410, detail="Audio URL has expired.")
    if not _verify_audio_signature(token, expires, sig):
        raise HTTPException(status_code=403, detail="Invalid audio URL signature.")

    row = (
        await db.execute(
            text("SELECT conversation_id, revoked_at, expires_at FROM shared_conversation_links WHERE token = :token"),
            {"token": token},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Share not found.")
    if row.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Share has been revoked.")
    if row.expires_at is not None and row.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Share has expired.")

    audio = _resolve_audio_file(str(row.conversation_id))
    if audio is None:
        raise HTTPException(status_code=404, detail="Audio recording not found.")
    path, media_type = audio
    return FileResponse(path, media_type=media_type)

"""HTTP/WebSocket auth policy helpers for P0 security middleware.

Path classification, bearer-token validation, and WebSocket auth live here so
``middleware.py`` can focus on middleware classes and rate/body enforcement.
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Optional, Set, Tuple

from fastapi import WebSocket

logger = logging.getLogger("lct_backend")

AUTH_TOKEN: Optional[str] = os.getenv("AUTH_TOKEN")
ADMIN_AUTH_TOKEN: Optional[str] = os.getenv("ADMIN_AUTH_TOKEN")
IS_PRODUCTION: bool = os.getenv("ENVIRONMENT", "development").strip().lower() == "production"

HEALTH_PATHS: Set[str] = {
    "/health",
    "/api/import/health",
    "/api/bookmarks/health",
}

PUBLIC_PATH_PREFIXES: Tuple[str, ...] = (
    "/api/share/",
)

ATTENDEE_WEBHOOK_PATH: str = "/api/attendee/webhook"

ADMIN_PATH_PREFIXES: Tuple[str, ...] = (
    "/api/settings",
    "/api/analytics",
    "/api/costs",
    "/api/cost-tracking",
    "/api/bookmarks",
    "/api/prompts",
    "/api/graph",
    "/api/backend-catalog",
)
ADMIN_PATH_EXACT: Set[str] = {
    "/conversations",
}

WS_AUTH_TIMEOUT_SECONDS = 10


def normalize_path(path: str) -> str:
    """Strip trailing slash for consistent matching."""
    return path.rstrip("/") if path != "/" else path


def is_health(path: str) -> bool:
    return normalize_path(path) in HEALTH_PATHS


def is_public_share(path: str, method: str = "GET") -> bool:
    """Public share GETs bypass AUTH_TOKEN; owner mutations stay authenticated."""
    if (method or "").upper() != "GET":
        return False
    norm = normalize_path(path)
    return any(norm.startswith(prefix.rstrip("/")) for prefix in PUBLIC_PATH_PREFIXES)


def is_attendee_webhook(path: str, method: str = "POST") -> bool:
    if (method or "").upper() != "POST":
        return False
    return normalize_path(path) == ATTENDEE_WEBHOOK_PATH


def is_audio_download(path: str) -> bool:
    norm = normalize_path(path)
    return norm.startswith("/api/conversations/") and norm.endswith("/audio")


def is_mutating(method: str) -> bool:
    return method in {"POST", "PUT", "DELETE", "PATCH"}


def is_cors_preflight(method: str, headers) -> bool:
    return method == "OPTIONS" and "access-control-request-method" in headers


def check_bearer_token(auth_header: Optional[str], *, token: Optional[str] = None) -> bool:
    """Validate Authorization header against the configured bearer token."""
    expected = token if token is not None else AUTH_TOKEN
    if not expected:
        return True
    if not auth_header:
        return False
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return hmac.compare_digest(parts[1].encode(), expected.encode())


def check_admin_bearer_token(auth_header: Optional[str]) -> bool:
    return check_bearer_token(auth_header, token=ADMIN_AUTH_TOKEN)


def requires_admin_auth(path: str, method: str) -> bool:
    normalized_path = normalize_path(path)
    normalized_method = str(method or "GET").upper()

    if normalized_path in ADMIN_PATH_EXACT:
        return True
    if any(
        normalized_path == prefix or normalized_path.startswith(f"{prefix}/")
        for prefix in ADMIN_PATH_PREFIXES
    ):
        return True
    if normalized_method == "DELETE" and normalized_path.startswith("/conversations/"):
        return True
    if normalized_path.endswith("/prayer-detect"):
        return True
    return False


def check_ws_auth(websocket: WebSocket) -> bool:
    """Query-param WebSocket auth (?token=). Prefer ``check_ws_auth_message``."""
    if not AUTH_TOKEN:
        return True
    token = websocket.query_params.get("token")
    return isinstance(token, str) and hmac.compare_digest(token.encode(), AUTH_TOKEN.encode())


async def check_ws_auth_message(websocket: WebSocket) -> bool:
    """Post-connect WebSocket auth via first JSON message."""
    import asyncio

    if not AUTH_TOKEN:
        return True

    try:
        first_msg = await asyncio.wait_for(
            websocket.receive_json(),
            timeout=WS_AUTH_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "[WS AUTH] Client did not send auth message within %ds",
            WS_AUTH_TIMEOUT_SECONDS,
        )
        await websocket.close(code=4401, reason="Unauthorized: auth timeout")
        return False
    except Exception:
        await websocket.close(code=4401, reason="Unauthorized: no auth message received")
        return False

    token = first_msg.get("token")
    if isinstance(token, str) and hmac.compare_digest(token.encode(), AUTH_TOKEN.encode()):
        return True

    await websocket.send_json({"type": "error", "detail": "Unauthorized: invalid token"})
    await websocket.close(code=4401, reason="Unauthorized")
    return False
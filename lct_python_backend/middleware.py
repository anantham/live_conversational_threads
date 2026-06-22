"""
P0 Security Middleware

Bearer token auth, rate limiting, and request body size limits.
Designed for "local + live with friends" deployment phase.

Auth policy lives in auth_policy.py; body limits and rate limiting in
their own modules. This file wires middleware classes.
"""

import logging
import os
import time
from typing import Callable

from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from lct_python_backend import auth_policy as auth
from lct_python_backend.body_limits import (
    MAX_BODY_BYTES,
    MAX_JSON_BYTES,
    MAX_UPLOAD_BYTES,
    BodySizeLimitMiddleware,
)
from lct_python_backend.rate_limit import (
    RATE_LIMIT_EXPENSIVE,
    RATE_LIMIT_MUTATE,
    RATE_LIMIT_READ,
    RATE_LIMIT_WINDOW,
    RateLimitMiddleware,
)
from lct_python_backend.url_import_gate import ENABLE_URL_IMPORT, UrlImportGateMiddleware

logger = logging.getLogger("lct_backend")

AUTH_TOKEN = auth.AUTH_TOKEN
ADMIN_AUTH_TOKEN = auth.ADMIN_AUTH_TOKEN
IS_PRODUCTION = auth.IS_PRODUCTION
check_ws_auth = auth.check_ws_auth
check_ws_auth_message = auth.check_ws_auth_message


class AuthMiddleware(BaseHTTPMiddleware):
    """Bearer token auth for HTTP endpoints."""

    async def dispatch(self, request: Request, call_next: Callable):
        path = auth.normalize_path(request.url.path)

        if auth.is_cors_preflight(request.method, request.headers):
            return await call_next(request)

        if auth.is_health(path):
            return await call_next(request)

        if auth.is_audio_download(path):
            return await call_next(request)

        if auth.is_attendee_webhook(path, request.method):
            return await call_next(request)

        if auth.is_public_share(path, request.method):
            return await call_next(request)

        # Subject-review GET (fetch bundle) + decisions POST bypass AUTH_TOKEN;
        # each enforces its own Google-email gate in-handler (ADR-039 P2). The
        # import POST stays gated (see auth.requires_admin_auth).
        if auth.is_subject_review_public(path, request.method):
            return await call_next(request)

        auth_header = request.headers.get("authorization")
        if auth.AUTH_TOKEN:
            if not auth.check_bearer_token(auth_header):
                logger.warning("[AUTH] Rejected request to %s - invalid/missing token", path)
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Invalid or missing authorization token."},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        elif auth.ADMIN_AUTH_TOKEN and auth.requires_admin_auth(path, request.method):
            if not auth.check_admin_bearer_token(auth_header):
                logger.warning("[AUTH] Rejected admin request to %s - invalid/missing admin token", path)
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Invalid or missing admin authorization token."},
                    headers={"WWW-Authenticate": "Bearer"},
                )

        return await call_next(request)


class ServerTimingMiddleware(BaseHTTPMiddleware):
    """Emit a Server-Timing header on every HTTP response."""

    SLOW_REQUEST_THRESHOLD_MS: float = float(os.getenv("SLOW_REQUEST_THRESHOLD_MS", "500"))

    async def dispatch(self, request: Request, call_next: Callable):
        started_at = time.perf_counter()
        request.state.server_timings = []
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0

        parts = []
        stages = getattr(request.state, "server_timings", None) or []
        for name, dur_ms in stages:
            safe_name = "".join(c for c in str(name) if c.isalnum() or c in "-_") or "stage"
            parts.append(f"{safe_name};dur={float(dur_ms):.1f}")
        parts.append(f"total;dur={elapsed_ms:.1f}")
        response.headers["Server-Timing"] = ", ".join(parts)

        if elapsed_ms >= self.SLOW_REQUEST_THRESHOLD_MS:
            logger.info(
                "[SLOW] %s %s -> %s in %.0fms%s",
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
                f" | stages: {', '.join(f'{n}={d:.0f}ms' for n, d in stages)}" if stages else "",
            )

        return response


def configure_p0_security(app):
    """Wire all P0 security middleware onto the FastAPI app."""
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(UrlImportGateMiddleware)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(ServerTimingMiddleware)

    if auth.AUTH_TOKEN:
        token_status = "ENFORCED (all non-health routes)"
    elif auth.ADMIN_AUTH_TOKEN:
        token_status = "ENFORCED (admin routes only)"
    else:
        allow_no_auth = os.getenv("ALLOW_NO_AUTH", "").strip().lower() in {"1", "true", "yes"}
        if auth.IS_PRODUCTION and not allow_no_auth:
            raise RuntimeError(
                "AUTH_TOKEN (or ADMIN_AUTH_TOKEN) must be set when ENVIRONMENT=production. "
                "Set a token, or set ALLOW_NO_AUTH=true to explicitly run without auth."
            )
        token_status = "DISABLED (AUTH_TOKEN / ADMIN_AUTH_TOKEN not set)"
    url_import = "ENABLED" if ENABLE_URL_IMPORT else "DISABLED"
    logger.info("[SECURITY] P0 middleware configured:")
    logger.info("[SECURITY]   Auth: %s", token_status)
    if auth.AUTH_TOKEN and not os.getenv("AUDIO_DOWNLOAD_TOKEN"):
        logger.warning(
            "[SECURITY] AUTH_TOKEN is set but AUDIO_DOWNLOAD_TOKEN is unset — "
            "GET /api/conversations/{id}/audio is UNAUTHENTICATED (the one open "
            "data route; <audio> tags cannot send the bearer header). Set "
            "AUDIO_DOWNLOAD_TOKEN, or migrate private audio to signed URLs (ADR-034 D15)."
        )
    logger.info("[SECURITY]   URL import: %s", url_import)
    logger.info("[SECURITY]   Rate limits: expensive=%d, mutate=%d, read=%d per %ds",
                RATE_LIMIT_EXPENSIVE, RATE_LIMIT_MUTATE, RATE_LIMIT_READ, RATE_LIMIT_WINDOW)
    logger.info("[SECURITY]   Body limits: JSON=%d MB, other=%d MB, uploads=%d MB",
                MAX_JSON_BYTES // (1024 * 1024), MAX_BODY_BYTES // (1024 * 1024),
                MAX_UPLOAD_BYTES // (1024 * 1024))

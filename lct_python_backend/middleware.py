"""
P0 Security Middleware

Bearer token auth, rate limiting, and request body size limits.
Designed for "local + live with friends" deployment phase.

Auth policy (path classification, bearer checks, WebSocket auth) lives in
``auth_policy.py``; this module wires middleware classes.
"""

import logging
import os
import time
from collections import defaultdict
from typing import Callable, Tuple

from fastapi import Request, WebSocket, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from lct_python_backend import auth_policy as auth

logger = logging.getLogger("lct_backend")

# Re-export auth symbols for existing imports (stt_api, attendee_api, tests).
AUTH_TOKEN = auth.AUTH_TOKEN
ADMIN_AUTH_TOKEN = auth.ADMIN_AUTH_TOKEN
IS_PRODUCTION = auth.IS_PRODUCTION
check_ws_auth = auth.check_ws_auth
check_ws_auth_message = auth.check_ws_auth_message

ENABLE_URL_IMPORT: bool = os.getenv("ENABLE_URL_IMPORT", "false").lower() in {
    "1",
    "true",
    "yes",
}

MAX_BODY_BYTES: int = int(os.getenv("MAX_BODY_BYTES", str(50 * 1024 * 1024)))
MAX_JSON_BYTES: int = int(os.getenv("MAX_JSON_BYTES", str(1 * 1024 * 1024)))
MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))

LARGE_UPLOAD_PATHS: set = {
    "/api/import/process-file",
}

RATE_LIMIT_WINDOW: int = 60
RATE_LIMIT_EXPENSIVE: int = int(os.getenv("RATE_LIMIT_EXPENSIVE", "10"))
RATE_LIMIT_MUTATE: int = int(os.getenv("RATE_LIMIT_MUTATE", "60"))
RATE_LIMIT_READ: int = int(os.getenv("RATE_LIMIT_READ", "200"))

EXPENSIVE_PATTERNS: Tuple[str, ...] = (
    "/analyze",
    "/generate",
    "/generate-context-stream",
    "/fact_check_claims",
    "/themes/generate",
)


def _is_expensive(path: str) -> bool:
    return any(pat in path for pat in EXPENSIVE_PATTERNS)


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
    """Emit a ``Server-Timing`` header on every HTTP response."""

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


class UrlImportGateMiddleware(BaseHTTPMiddleware):
    """Blocks /api/import/from-url unless ENABLE_URL_IMPORT=true."""

    async def dispatch(self, request: Request, call_next: Callable):
        path = auth.normalize_path(request.url.path)

        if path == "/api/import/from-url" and not ENABLE_URL_IMPORT:
            logger.warning("[SECURITY] Blocked /api/import/from-url (ENABLE_URL_IMPORT is false)")
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={
                    "detail": (
                        "URL import is disabled. "
                        "Set ENABLE_URL_IMPORT=true to enable (SSRF risk — only for trusted networks)."
                    )
                },
            )

        return await call_next(request)


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests with bodies exceeding configured limits."""

    async def dispatch(self, request: Request, call_next: Callable):
        content_length = request.headers.get("content-length")
        content_type = request.headers.get("content-type", "")

        if content_length is not None:
            try:
                length = int(content_length)
            except ValueError:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"detail": "Invalid Content-Length header."},
                )

            is_json = "application/json" in content_type
            normalized_path = request.url.path.rstrip("/")
            is_large_upload = normalized_path in LARGE_UPLOAD_PATHS
            if is_json:
                limit = MAX_JSON_BYTES
            elif is_large_upload:
                limit = MAX_UPLOAD_BYTES
            else:
                limit = MAX_BODY_BYTES

            if length > limit:
                limit_mb = limit / (1024 * 1024)
                logger.warning(
                    "[SECURITY] Rejected oversized request to %s (%d bytes, limit %.1f MB)",
                    request.url.path,
                    length,
                    limit_mb,
                )
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={
                        "detail": f"Request body too large. Limit: {limit_mb:.1f} MB."
                    },
                )

        return await call_next(request)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """In-memory per-IP rate limiting with tiered limits."""

    def __init__(self, app: ASGIApp, **kwargs):
        super().__init__(app, **kwargs)
        self._requests: dict = defaultdict(list)

    def _clean_old_entries(self, ip: str, now: float):
        cutoff = now - RATE_LIMIT_WINDOW
        self._requests[ip] = [
            (ts, tier) for ts, tier in self._requests[ip] if ts > cutoff
        ]

    def _count_tier(self, ip: str, tier: str) -> int:
        return sum(1 for _, t in self._requests[ip] if t == tier)

    async def dispatch(self, request: Request, call_next: Callable):
        path = auth.normalize_path(request.url.path)
        method = request.method

        if auth.is_health(path) or auth.is_cors_preflight(request.method, request.headers):
            return await call_next(request)

        if auth.is_attendee_webhook(path, method):
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"
        now = time.time()
        self._clean_old_entries(ip, now)

        if _is_expensive(path):
            tier = "expensive"
            limit = RATE_LIMIT_EXPENSIVE
        elif auth.is_mutating(method):
            tier = "mutate"
            limit = RATE_LIMIT_MUTATE
        else:
            tier = "read"
            limit = RATE_LIMIT_READ

        count = self._count_tier(ip, tier)
        if count >= limit:
            logger.warning(
                "[RATE LIMIT] %s exceeded %s tier limit (%d/%d) on %s %s",
                ip, tier, count, limit, method, path,
            )
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={
                    "detail": f"Rate limit exceeded ({tier} tier: {limit} requests per {RATE_LIMIT_WINDOW}s)."
                },
                headers={"Retry-After": str(RATE_LIMIT_WINDOW)},
            )

        self._requests[ip].append((now, tier))
        return await call_next(request)


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
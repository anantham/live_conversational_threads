"""
P0 Security Middleware

Bearer token auth, rate limiting, and request body size limits.
Designed for "local + live with friends" deployment phase.

When AUTH_TOKEN env var is set, all non-health endpoints require
Authorization: Bearer <token>. When unset, auth is not enforced (dev mode).
"""

import logging
import os
import time
from collections import defaultdict
from typing import Callable, Optional, Set, Tuple

from fastapi import Request, WebSocket, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("lct_backend")

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

AUTH_TOKEN: Optional[str] = os.getenv("AUTH_TOKEN")

# Paths that never require auth (exact match after stripping trailing slash)
HEALTH_PATHS: Set[str] = {
    "/health",
    "/api/import/health",
    "/api/bookmarks/health",
}

# Env-gated endpoints (disabled by default)
ENABLE_URL_IMPORT: bool = os.getenv("ENABLE_URL_IMPORT", "false").lower() in {
    "1",
    "true",
    "yes",
}

# Body size limits (bytes)
MAX_BODY_BYTES: int = int(os.getenv("MAX_BODY_BYTES", str(50 * 1024 * 1024)))  # 50 MB default
MAX_JSON_BYTES: int = int(os.getenv("MAX_JSON_BYTES", str(1 * 1024 * 1024)))    # 1 MB default
MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))  # 500 MB for file uploads

# Routes that accept large file uploads (use MAX_UPLOAD_BYTES instead of MAX_BODY_BYTES)
LARGE_UPLOAD_PATHS: set = {
    "/api/import/process-file",
}

# Rate limit configuration (requests per window)
RATE_LIMIT_WINDOW: int = 60  # seconds

# Per-tier limits within the window
RATE_LIMIT_EXPENSIVE: int = int(os.getenv("RATE_LIMIT_EXPENSIVE", "10"))
RATE_LIMIT_MUTATE: int = int(os.getenv("RATE_LIMIT_MUTATE", "60"))
RATE_LIMIT_READ: int = int(os.getenv("RATE_LIMIT_READ", "200"))

# Patterns that identify expensive (LLM-calling) endpoints
EXPENSIVE_PATTERNS: Tuple[str, ...] = (
    "/analyze",
    "/generate",
    "/generate-context-stream",
    "/fact_check_claims",
    "/generate_formalism",
    "/themes/generate",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_path(path: str) -> str:
    """Strip trailing slash for consistent matching."""
    return path.rstrip("/") if path != "/" else path


def _is_health(path: str) -> bool:
    return _normalize_path(path) in HEALTH_PATHS


def _is_expensive(path: str) -> bool:
    return any(pat in path for pat in EXPENSIVE_PATTERNS)


def _is_mutating(method: str) -> bool:
    return method in {"POST", "PUT", "DELETE", "PATCH"}


def _is_cors_preflight(request: Request) -> bool:
    return request.method == "OPTIONS" and "access-control-request-method" in request.headers


def _check_bearer_token(auth_header: Optional[str]) -> bool:
    """Validate Authorization header against AUTH_TOKEN."""
    if not AUTH_TOKEN:
        return True  # Auth not enforced when token unset
    if not auth_header:
        return False
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return parts[1] == AUTH_TOKEN


# ---------------------------------------------------------------------------
# Auth Middleware (HTTP)
# ---------------------------------------------------------------------------

class AuthMiddleware(BaseHTTPMiddleware):
    """
    Bearer token auth for HTTP endpoints.

    When AUTH_TOKEN is set, rejects requests without a valid
    Authorization: Bearer <token> header (except health endpoints).
    """

    async def dispatch(self, request: Request, call_next: Callable):
        path = _normalize_path(request.url.path)

        # Let browser CORS preflight pass to CORS middleware without auth.
        if _is_cors_preflight(request):
            return await call_next(request)

        if _is_health(path):
            return await call_next(request)

        auth_header = request.headers.get("authorization")
        if not _check_bearer_token(auth_header):
            logger.warning("[AUTH] Rejected request to %s - invalid/missing token", path)
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": "Invalid or missing authorization token."},
                headers={"WWW-Authenticate": "Bearer"},
            )

        return await call_next(request)


# ---------------------------------------------------------------------------
# WebSocket Auth
# ---------------------------------------------------------------------------

def check_ws_auth(websocket: WebSocket) -> bool:
    """
    Check WebSocket auth via query param ?token=<AUTH_TOKEN>.

    Returns True if auth passes (or AUTH_TOKEN not configured).
    Call this before websocket.accept().
    """
    if not AUTH_TOKEN:
        return True
    token = websocket.query_params.get("token")
    return token == AUTH_TOKEN


# ---------------------------------------------------------------------------
# URL Import Gate
# ---------------------------------------------------------------------------

class UrlImportGateMiddleware(BaseHTTPMiddleware):
    """
    Blocks /api/import/from-url unless ENABLE_URL_IMPORT=true.

    Mitigates SSRF risk from requests.get(user_url) in import_api.py.
    """

    async def dispatch(self, request: Request, call_next: Callable):
        path = _normalize_path(request.url.path)

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


# ---------------------------------------------------------------------------
# Body Size Limit Middleware
# ---------------------------------------------------------------------------

class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """
    Reject requests with bodies exceeding configured limits.

    JSON content types are limited to MAX_JSON_BYTES.
    All other content types are limited to MAX_BODY_BYTES.
    """

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
            is_large_upload = request.url.path in LARGE_UPLOAD_PATHS
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


# ---------------------------------------------------------------------------
# Rate Limiting Middleware
# ---------------------------------------------------------------------------

class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    In-memory per-IP rate limiting with tiered limits.

    Tiers:
    - Expensive (LLM-calling endpoints): RATE_LIMIT_EXPENSIVE/min
    - Mutating (POST/PUT/DELETE/PATCH): RATE_LIMIT_MUTATE/min
    - Read (GET): RATE_LIMIT_READ/min
    - Health: unlimited

    For production with multiple workers, replace with Redis-based limiter.
    """

    def __init__(self, app: ASGIApp, **kwargs):
        super().__init__(app, **kwargs)
        # {ip: [(timestamp, tier)]}
        self._requests: dict = defaultdict(list)

    def _clean_old_entries(self, ip: str, now: float):
        cutoff = now - RATE_LIMIT_WINDOW
        self._requests[ip] = [
            (ts, tier) for ts, tier in self._requests[ip] if ts > cutoff
        ]

    def _count_tier(self, ip: str, tier: str) -> int:
        return sum(1 for _, t in self._requests[ip] if t == tier)

    async def dispatch(self, request: Request, call_next: Callable):
        path = _normalize_path(request.url.path)
        method = request.method

        if _is_health(path) or _is_cors_preflight(request):
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"
        now = time.time()
        self._clean_old_entries(ip, now)

        # Determine tier and limit
        if _is_expensive(path):
            tier = "expensive"
            limit = RATE_LIMIT_EXPENSIVE
        elif _is_mutating(method):
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


# ---------------------------------------------------------------------------
# Wiring helper
# ---------------------------------------------------------------------------

def configure_p0_security(app):
    """
    Wire all P0 security middleware onto the FastAPI app.

    Call this in backend.py after creating the app:
        from lct_python_backend.middleware import configure_p0_security
        configure_p0_security(lct_app)

    Middleware executes in reverse registration order (last added = outermost).
    Order: body limits -> rate limits -> url gate -> auth (auth is outermost).
    """
    # Innermost first
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(UrlImportGateMiddleware)
    app.add_middleware(AuthMiddleware)

    token_status = "ENFORCED" if AUTH_TOKEN else "DISABLED (AUTH_TOKEN not set)"
    url_import = "ENABLED" if ENABLE_URL_IMPORT else "DISABLED"
    logger.info("[SECURITY] P0 middleware configured:")
    logger.info("[SECURITY]   Auth: %s", token_status)
    logger.info("[SECURITY]   URL import: %s", url_import)
    logger.info("[SECURITY]   Rate limits: expensive=%d, mutate=%d, read=%d per %ds",
                RATE_LIMIT_EXPENSIVE, RATE_LIMIT_MUTATE, RATE_LIMIT_READ, RATE_LIMIT_WINDOW)
    logger.info("[SECURITY]   Body limits: JSON=%d MB, other=%d MB, uploads=%d MB",
                MAX_JSON_BYTES // (1024 * 1024), MAX_BODY_BYTES // (1024 * 1024),
                MAX_UPLOAD_BYTES // (1024 * 1024))

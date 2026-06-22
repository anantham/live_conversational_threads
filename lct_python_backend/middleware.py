"""
P0 Security Middleware

Bearer token auth, rate limiting, and request body size limits.
Designed for "local + live with friends" deployment phase.

Auth supports two deployment modes:
- AUTH_TOKEN: enforce bearer auth on all non-health endpoints
- ADMIN_AUTH_TOKEN: when AUTH_TOKEN is unset, enforce bearer auth only on
  admin/sensitive HTTP routes while keeping public trial flows anonymous
"""

import hmac
import logging
import os
import re
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
ADMIN_AUTH_TOKEN: Optional[str] = os.getenv("ADMIN_AUTH_TOKEN")
IS_PRODUCTION: bool = os.getenv("ENVIRONMENT", "development").strip().lower() == "production"

# Paths that never require auth (exact match after stripping trailing slash)
HEALTH_PATHS: Set[str] = {
    "/health",
    "/api/import/health",
    "/api/bookmarks/health",
}

# Share-link endpoints enforce their own auth (Google ID token + per-share
# email allowlist; see share_api.py). The fetch endpoint is invoked by
# recipients who don't have the global AUTH_TOKEN, so it must bypass this
# middleware. Owner-side share endpoints (POST/DELETE/GET-list) live under
# /api/conversations/{id}/share and stay on the main AUTH_TOKEN path.
PUBLIC_PATH_PREFIXES: Tuple[str, ...] = (
    "/api/share/",
)

# Attendee delivers webhooks authenticated by an HMAC X-Webhook-Signature (NOT
# the bearer AUTH_TOKEN), verified inside attendee_api._verify_signature. It also
# fires once per finalized utterance, so it must bypass both bearer auth and the
# per-IP mutate rate limit.
ATTENDEE_WEBHOOK_PATH: str = "/api/attendee/webhook"

ADMIN_PATH_PREFIXES: Tuple[str, ...] = (
    "/api/settings",
    "/api/analytics",
    "/api/costs",
    "/api/cost-tracking",
    "/api/bookmarks",
    "/api/prompts",
    "/api/graph",
    # Backend catalog powers Settings + status chips and triggers server-side
    # probes; treat it like the other settings/admin surfaces.
    "/api/backend-catalog",
)
ADMIN_PATH_EXACT: Set[str] = {
    "/conversations",
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


def _is_public_share(path: str, method: str = "GET") -> bool:
    """Public share GETs (recipient fetch + audio) bypass AUTH_TOKEN — they enforce
    their own per-share Google gate. ONLY GET is exempt: owner-side mutations under
    /api/share/ (notably DELETE revoke) MUST stay on the auth path."""
    if (method or "").upper() != "GET":
        return False
    norm = _normalize_path(path)
    return any(norm.startswith(prefix.rstrip("/")) for prefix in PUBLIC_PATH_PREFIXES)


# Subject-side privacy review (ADR-039 P2): a conversation subject reviews the
# AI's redactions of their OWN words via an email-gated page. Their browser holds
# only a Google ID token (no AUTH_TOKEN), so the GET (fetch the bundle) and the
# decisions POST must bypass bearer auth — each enforces its own in-handler Google
# gate (verified email == the bundle's subject_email; see subject_review_api).
# The token segment is a secrets.token_urlsafe value (no '/'), so a single
# non-'import' path segment matches the GET, and '.../decisions' matches the POST.
# CRITICAL: /api/subject-review/import is NOT exempt (it is IndrasNet -> LCT and
# stays AUTH_TOKEN-gated) — the GET pattern explicitly excludes the 'import' token.
_SUBJECT_REVIEW_GET_RE = re.compile(r"^/api/subject-review/(?!import$)[^/]+$")
_SUBJECT_REVIEW_DECISIONS_RE = re.compile(r"^/api/subject-review/[^/]+/decisions$")


def _is_subject_review_public(path: str, method: str = "GET") -> bool:
    """Exempt ONLY the subject's GET (fetch bundle) and decisions POST from
    AUTH_TOKEN; the import POST stays gated. Each exempted handler enforces its
    own Google-email gate."""
    norm = _normalize_path(path)
    m = (method or "").upper()
    if m == "GET":
        return bool(_SUBJECT_REVIEW_GET_RE.match(norm))
    if m == "POST":
        return bool(_SUBJECT_REVIEW_DECISIONS_RE.match(norm))
    return False


def _is_attendee_webhook(path: str, method: str = "POST") -> bool:
    """Attendee webhook POST — HMAC-authenticated in-handler; bypasses bearer
    auth and rate limiting. ONLY POST to the exact webhook path."""
    if (method or "").upper() != "POST":
        return False
    return _normalize_path(path) == ATTENDEE_WEBHOOK_PATH


def _is_audio_download(path: str) -> bool:
    """Audio download URLs are opened via plain <a href=...> which cannot
    send Authorization headers. The endpoint enforces its own query-string
    AUDIO_DOWNLOAD_TOKEN check in factcheck_api.download_audio."""
    norm = _normalize_path(path)
    return norm.startswith("/api/conversations/") and norm.endswith("/audio")


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
    return hmac.compare_digest(parts[1].encode(), AUTH_TOKEN.encode())


def _check_admin_bearer_token(auth_header: Optional[str]) -> bool:
    """Validate Authorization header against ADMIN_AUTH_TOKEN."""
    if not ADMIN_AUTH_TOKEN:
        return True
    if not auth_header:
        return False
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return hmac.compare_digest(parts[1].encode(), ADMIN_AUTH_TOKEN.encode())


def _requires_admin_auth(path: str, method: str) -> bool:
    normalized_path = _normalize_path(path)
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
    # Prayer detection returns IndrasNet private-memory results; gate it like the
    # other admin surfaces regardless of the conversation-scoped path prefix.
    if normalized_path.endswith("/prayer-detect"):
        return True
    # Subject-review import is a server-to-server (IndrasNet -> LCT) endpoint that
    # mints review bundles + a server-side relay; it must fail CLOSED in the
    # ADMIN_AUTH_TOKEN-only mode too (it is NOT in PUBLIC_PATH_PREFIXES, so under
    # AUTH_TOKEN it is already gated; this covers the admin-only deployment).
    if normalized_path == "/api/subject-review/import":
        return True
    return False


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

        if _is_audio_download(path):
            return await call_next(request)

        if _is_attendee_webhook(path, request.method):
            # HMAC-signed webhook; auth enforced in attendee_api._verify_signature.
            return await call_next(request)

        if _is_public_share(path, request.method):
            # Share-fetch (GET only) enforces its own Google ID token check per
            # share's email allowlist. AUTH_TOKEN does not apply to recipients.
            # DELETE/other methods under /api/share/ fall through to auth below.
            return await call_next(request)

        if _is_subject_review_public(path, request.method):
            # Subject-review GET + decisions POST enforce their own Google-email
            # gate in-handler (subject_review_api). The import POST is NOT matched
            # here and stays AUTH_TOKEN-gated.
            return await call_next(request)

        auth_header = request.headers.get("authorization")
        if AUTH_TOKEN:
            if not _check_bearer_token(auth_header):
                logger.warning("[AUTH] Rejected request to %s - invalid/missing token", path)
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Invalid or missing authorization token."},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        elif ADMIN_AUTH_TOKEN and _requires_admin_auth(path, request.method):
            if not _check_admin_bearer_token(auth_header):
                logger.warning("[AUTH] Rejected admin request to %s - invalid/missing admin token", path)
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Invalid or missing admin authorization token."},
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

    DEPRECATED: prefer post-connect auth via ``check_ws_auth_message``
    to avoid exposing the token in URLs, logs, and browser history.
    Kept for backward compatibility during transition.
    """
    if not AUTH_TOKEN:
        return True
    token = websocket.query_params.get("token")
    return isinstance(token, str) and hmac.compare_digest(token.encode(), AUTH_TOKEN.encode())


WS_AUTH_TIMEOUT_SECONDS = 10


async def check_ws_auth_message(websocket: WebSocket) -> bool:
    """
    Authenticate a WebSocket connection via a post-connect auth message.

    Call this *after* ``websocket.accept()``.  If ``AUTH_TOKEN`` is not
    configured, returns ``True`` immediately (dev mode).

    Otherwise waits up to ``WS_AUTH_TIMEOUT_SECONDS`` for the first JSON
    message.  Accepts either:
    - ``{"type": "auth", "token": "<token>"}`` — dedicated auth frame
    - Any message with a ``token`` field matching AUTH_TOKEN (backward compat
      with query-param clients that embed the token in session_meta)

    On failure or timeout, sends an error frame and closes with code ``4401``.
    """
    import asyncio

    if not AUTH_TOKEN:
        return True

    try:
        first_msg = await asyncio.wait_for(
            websocket.receive_json(),
            timeout=WS_AUTH_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("[WS AUTH] Client did not send auth message within %ds", WS_AUTH_TIMEOUT_SECONDS)
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


# ---------------------------------------------------------------------------
# URL Import Gate
# ---------------------------------------------------------------------------

class ServerTimingMiddleware(BaseHTTPMiddleware):
    """Emit a ``Server-Timing`` header on every HTTP response.

    The browser's DevTools Network panel renders the value as a colored
    bar next to each request, so per-request backend duration is visible
    without leaving the browser. Format follows the W3C Server-Timing
    spec: ``Server-Timing: total;dur=<float ms>``.

    Slow requests (above ``SLOW_REQUEST_THRESHOLD_MS``) are also logged at
    INFO so they're easy to spot in tailed logs.

    Optional per-stage timings can be attached by handlers via
    ``request.state.server_timings`` — a list of ``(name, ms)`` tuples
    that get formatted into the same header (e.g. ``db;dur=120,
    graph;dur=180, total;dur=320``).
    """

    SLOW_REQUEST_THRESHOLD_MS: float = float(os.getenv("SLOW_REQUEST_THRESHOLD_MS", "500"))

    async def dispatch(self, request: Request, call_next: Callable):
        # Use perf_counter for monotonic sub-millisecond resolution; time.time()
        # can jump on clock sync.
        started_at = time.perf_counter()
        # Initialise the per-stage bucket so handlers can opportunistically
        # add detail without first checking if the key exists.
        request.state.server_timings = []
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0

        # Compose the header: stages first (if any), then total.
        parts = []
        stages = getattr(request.state, "server_timings", None) or []
        for name, dur_ms in stages:
            # Sanitize name — Server-Timing names must match `token` syntax.
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

        if _is_attendee_webhook(path, method):
            # Per-utterance webhook from the local Attendee instance — exempt.
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
    Order (inner -> outer): body limits -> rate limits -> url gate -> auth ->
    server-timing. Server-Timing wraps everything so the recorded duration
    reflects total backend cost incl. auth and rate-limit checks.
    """
    # Innermost first
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(UrlImportGateMiddleware)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(ServerTimingMiddleware)

    if AUTH_TOKEN:
        token_status = "ENFORCED (all non-health routes)"
    elif ADMIN_AUTH_TOKEN:
        token_status = "ENFORCED (admin routes only)"
    else:
        allow_no_auth = os.getenv("ALLOW_NO_AUTH", "").strip().lower() in {"1", "true", "yes"}
        if IS_PRODUCTION and not allow_no_auth:
            raise RuntimeError(
                "AUTH_TOKEN (or ADMIN_AUTH_TOKEN) must be set when ENVIRONMENT=production. "
                "Set a token, or set ALLOW_NO_AUTH=true to explicitly run without auth."
            )
        token_status = "DISABLED (AUTH_TOKEN / ADMIN_AUTH_TOKEN not set)"
    url_import = "ENABLED" if ENABLE_URL_IMPORT else "DISABLED"
    logger.info("[SECURITY] P0 middleware configured:")
    logger.info("[SECURITY]   Auth: %s", token_status)
    if AUTH_TOKEN and not os.getenv("AUDIO_DOWNLOAD_TOKEN"):
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

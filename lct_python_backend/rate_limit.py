"""In-memory per-IP rate limiting for P0 security middleware."""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from typing import Callable, Tuple

from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from lct_python_backend import auth_policy as auth

logger = logging.getLogger("lct_backend")

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


def is_expensive_path(path: str) -> bool:
    return any(pat in path for pat in EXPENSIVE_PATTERNS)


def resolve_rate_limit_tier(path: str, method: str) -> tuple[str, int]:
    """Return (tier_name, requests_per_window) for a path and HTTP method."""
    if is_expensive_path(path):
        return "expensive", RATE_LIMIT_EXPENSIVE
    if auth.is_mutating(method):
        return "mutate", RATE_LIMIT_MUTATE
    return "read", RATE_LIMIT_READ


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

        tier, limit = resolve_rate_limit_tier(path, method)

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
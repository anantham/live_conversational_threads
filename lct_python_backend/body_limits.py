"""Request body size enforcement for P0 security middleware."""

from __future__ import annotations

import logging
import os
from typing import Callable

from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("lct_backend")

MAX_BODY_BYTES: int = int(os.getenv("MAX_BODY_BYTES", str(50 * 1024 * 1024)))
MAX_JSON_BYTES: int = int(os.getenv("MAX_JSON_BYTES", str(1 * 1024 * 1024)))
MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))

LARGE_UPLOAD_PATHS: set[str] = {
    "/api/import/process-file",
}


def resolve_body_byte_limit(*, path: str, content_type: str) -> int:
    """Return the applicable body-size cap for a request path and content type."""
    normalized_path = path.rstrip("/")
    if "application/json" in content_type:
        return MAX_JSON_BYTES
    if normalized_path in LARGE_UPLOAD_PATHS:
        return MAX_UPLOAD_BYTES
    return MAX_BODY_BYTES


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

            limit = resolve_body_byte_limit(
                path=request.url.path,
                content_type=content_type,
            )

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
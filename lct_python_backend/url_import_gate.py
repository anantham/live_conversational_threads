"""URL-import SSRF gate for P0 security middleware."""

from __future__ import annotations

import logging
import os
from typing import Callable

from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from lct_python_backend import auth_policy as auth

logger = logging.getLogger("lct_backend")

ENABLE_URL_IMPORT: bool = os.getenv("ENABLE_URL_IMPORT", "false").lower() in {
    "1",
    "true",
    "yes",
}


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
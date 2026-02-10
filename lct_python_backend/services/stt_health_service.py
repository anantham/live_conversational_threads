"""STT provider health probe utilities."""

import json
import logging
import time
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request as UrlRequest, urlopen

logger = logging.getLogger(__name__)


def derive_health_url(ws_url: str) -> str:
    """Convert a WebSocket URL to an HTTP health-check URL on /health."""
    if not ws_url:
        return ""
    parsed = urlparse(str(ws_url).strip())
    if not parsed.netloc:
        return ""

    if parsed.scheme in {"wss", "https"}:
        scheme = "https"
    elif parsed.scheme in {"ws", "http"}:
        scheme = "http"
    else:
        return ""

    return urlunparse((scheme, parsed.netloc, "/health", "", "", ""))


def probe_health_url(health_url: str, timeout_seconds: float) -> Dict[str, Any]:
    """Synchronous HTTP probe to a health endpoint. Returns a result dict."""
    start = time.perf_counter()
    status_code: Optional[int] = None
    ok = False
    response_preview: Any = None
    error: Optional[str] = None

    try:
        req = UrlRequest(health_url, headers={"Accept": "application/json,text/plain,*/*"})
        with urlopen(req, timeout=timeout_seconds) as response:
            status_code = int(getattr(response, "status", response.getcode()))
            raw_body = response.read(4096)
            text = raw_body.decode("utf-8", errors="replace").strip()
            content_type = response.headers.get("Content-Type", "")
            if "application/json" in content_type:
                try:
                    response_preview = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    response_preview = text[:500]
            else:
                response_preview = text[:500]
            ok = 200 <= status_code < 300
    except HTTPError as exc:
        status_code = int(exc.code)
        body = exc.read(2048).decode("utf-8", errors="replace").strip()
        response_preview = body[:500] if body else None
        error = f"HTTP {status_code}"
    except URLError as exc:
        error = f"Connection error: {exc.reason}"
    except Exception as exc:  # pylint: disable=broad-except
        error = f"{type(exc).__name__}: {exc}"

    latency_ms = round((time.perf_counter() - start) * 1000, 2)
    return {
        "ok": ok,
        "status_code": status_code,
        "latency_ms": latency_ms,
        "response_preview": response_preview,
        "error": error,
    }

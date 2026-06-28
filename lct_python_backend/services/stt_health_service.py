"""STT provider health probe utilities."""

import json
import logging
import ssl
import time
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request as UrlRequest, urlopen

logger = logging.getLogger(__name__)


def _build_https_context() -> Optional[ssl.SSLContext]:
    """Verify TLS against certifi's modern CA bundle, not the OS trust store.

    On Windows a bare ``urlopen`` verifies against the system certificate
    store, which still carries an EXPIRED Let's Encrypt cross-signed root (the
    old DST Root CA X3 path). OpenSSL 3.0 builds the chain through that expired
    cert and rejects an otherwise-valid Let's Encrypt leaf with "certificate
    has expired" — even though curl, the browser, and the live STT transport
    (all certifi / modern ISRG Root X1) accept the same host fine. That made a
    healthy Tailscale STT route (e.g. the M5 parakeet shim) show as a dead
    route on the home status pill. Pinning to certifi makes this probe agree
    with every other client. Falls back to default verification (``None`` =
    urlopen's default context) if certifi is unavailable — never disables
    verification.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001 — certifi missing/unreadable: keep default trust store
        logger.warning("[stt-health] certifi unavailable; falling back to default TLS trust store")
        return None


_HTTPS_CONTEXT = _build_https_context()


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


def derive_health_url_from_http_url(http_url: str) -> str:
    """Convert an HTTP transcription URL to a provider health-check URL on /health."""
    if not http_url:
        return ""
    parsed = urlparse(str(http_url).strip())
    if not parsed.netloc:
        return ""
    if parsed.scheme not in {"http", "https"}:
        return ""
    return urlunparse((parsed.scheme, parsed.netloc, "/health", "", "", ""))


def probe_health_url(health_url: str, timeout_seconds: float) -> Dict[str, Any]:
    """Synchronous HTTP probe to a health endpoint. Returns a result dict."""
    start = time.perf_counter()
    status_code: Optional[int] = None
    ok = False
    response_preview: Any = None
    error: Optional[str] = None

    try:
        # Local-only guard: probe_health_url imports urlopen by value at module
        # load (before the lifespan chokepoint installs), so the global urllib
        # patch does NOT reach this binding. Guard here directly so a Modal /
        # cloud health probe fails closed under LCT_LOCAL_ONLY. A local provider
        # health URL (loopback/Tailscale/LAN) still passes.
        from lct_python_backend.services.egress_guard import assert_local_egress
        assert_local_egress(health_url, purpose="STT health probe")

        req = UrlRequest(health_url, headers={"Accept": "application/json,text/plain,*/*"})
        # context pins TLS verification to certifi (see _build_https_context);
        # urlopen ignores it for http:// URLs, and context=None means "default".
        with urlopen(req, timeout=timeout_seconds, context=_HTTPS_CONTEXT) as response:
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

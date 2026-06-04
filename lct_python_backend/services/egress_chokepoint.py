"""Network-layer egress chokepoint — make ``LCT_LOCAL_ONLY`` truly trustworthy.

The per-call-site ``assert_local_egress`` in ``egress_guard`` is leaky by
construction: every outbound cloud call must individually remember to call it,
and two codex reviews still found ~12 unguarded paths between them. This module
moves the guard BELOW the call sites to the transport layer so it is
**fail-closed by construction** — a new cloud call added anywhere is blocked by
default whether or not its author wired a per-site guard.

Leverage: every HTTP path in this codebase — direct ``httpx`` AND the OpenAI
SDK AND the modern ``google-genai`` SDK — funnels through
``httpx.Client.send`` / ``httpx.AsyncClient.send``. Wrapping those two methods
once covers ~35 of ~38 egress sites. ``websockets.connect`` and
``urllib.request.urlopen`` are the only non-httpx transports and get their own
small wrappers.

Install once at process startup (FastAPI ``lifespan``) and at the top of any
local-only batch/test harness. Idempotent: re-calling is a no-op.

This is the LOAD-BEARING layer; the existing per-site ``assert_local_egress``
calls remain as defense-in-depth + cleaner fail-fast messages. See
``docs/adr/ADR-034-egress-chokepoint-proposal.md``.
"""

from __future__ import annotations

import logging

from lct_python_backend.services.egress_guard import assert_local_egress

logger = logging.getLogger("lct_backend")

_installed = False
# Saved originals so the chokepoint can be cleanly removed (test isolation).
_originals: dict = {}


def is_installed() -> bool:
    return _installed


def install_egress_chokepoint() -> None:
    """Idempotently wrap httpx / websockets / urllib with the egress guard.

    No-op when called more than once (safe under reload / repeated test setup).
    The guard itself is a no-op when ``LCT_LOCAL_ONLY`` is off, so installing
    the chokepoint unconditionally at startup is safe for the cloud/public
    profile too.
    """
    global _installed
    if _installed:
        return

    _wrap_httpx()
    _wrap_websockets()
    _wrap_urllib()

    _installed = True
    logger.info("[egress-chokepoint] installed (httpx + websockets + urllib)")


def uninstall_egress_chokepoint() -> None:
    """Restore the original transports. Primarily for test isolation — the
    server installs once at startup and never uninstalls."""
    global _installed
    if not _installed:
        return

    import urllib.request as _ur

    if "httpx_sync" in _originals:
        import httpx
        httpx.Client.send = _originals["httpx_sync"]
        httpx.AsyncClient.send = _originals["httpx_async"]
    if "websockets_connect" in _originals:
        import websockets
        websockets.connect = _originals["websockets_connect"]
    if "urlopen" in _originals:
        _ur.urlopen = _originals["urlopen"]

    _originals.clear()
    _installed = False
    logger.info("[egress-chokepoint] uninstalled")


# --- httpx (covers direct httpx + OpenAI SDK + modern google-genai SDK) ------

def _wrap_httpx() -> None:
    try:
        import httpx
    except Exception:  # pragma: no cover - httpx is a hard dep, defensive only
        logger.warning("[egress-chokepoint] httpx not importable; HTTP not guarded")
        return

    if getattr(httpx.Client.send, "_lct_egress_wrapped", False):
        return

    _orig_sync_send = httpx.Client.send
    _orig_async_send = httpx.AsyncClient.send
    _originals["httpx_sync"] = _orig_sync_send
    _originals["httpx_async"] = _orig_async_send

    def _guarded_sync_send(self, request, *args, **kwargs):
        assert_local_egress(str(request.url), purpose="httpx")
        return _orig_sync_send(self, request, *args, **kwargs)

    async def _guarded_async_send(self, request, *args, **kwargs):
        assert_local_egress(str(request.url), purpose="httpx-async")
        return await _orig_async_send(self, request, *args, **kwargs)

    _guarded_sync_send._lct_egress_wrapped = True  # type: ignore[attr-defined]
    _guarded_async_send._lct_egress_wrapped = True  # type: ignore[attr-defined]

    httpx.Client.send = _guarded_sync_send  # type: ignore[assignment]
    httpx.AsyncClient.send = _guarded_async_send  # type: ignore[assignment]


# --- websockets (OpenAI / backend realtime STT) ------------------------------

def _wrap_websockets() -> None:
    try:
        import websockets
    except Exception:
        return

    connect = getattr(websockets, "connect", None)
    if connect is None or getattr(connect, "_lct_egress_wrapped", False):
        return

    _originals["websockets_connect"] = connect

    def _guarded_connect(uri, *args, **kwargs):
        assert_local_egress(str(uri), purpose="websocket")
        return connect(uri, *args, **kwargs)

    _guarded_connect._lct_egress_wrapped = True  # type: ignore[attr-defined]
    websockets.connect = _guarded_connect  # type: ignore[assignment]


# --- urllib (STT health probe) -----------------------------------------------

def _wrap_urllib() -> None:
    import urllib.request as _ur

    if getattr(_ur.urlopen, "_lct_egress_wrapped", False):
        return

    _orig_urlopen = _ur.urlopen
    _originals["urlopen"] = _orig_urlopen

    def _guarded_urlopen(url, *args, **kwargs):
        # url may be a str or a urllib Request
        target = getattr(url, "full_url", None) or (url if isinstance(url, str) else str(url))
        assert_local_egress(str(target), purpose="urllib")
        return _orig_urlopen(url, *args, **kwargs)

    _guarded_urlopen._lct_egress_wrapped = True  # type: ignore[attr-defined]
    _ur.urlopen = _guarded_urlopen  # type: ignore[assignment]

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
from lct_python_backend.services.privacy_boundary import (
    UnverifiedEgressBlocked,
    assert_audio_egress_allowed,
    assert_body_clean,
    egress_requires_leak_verify,
    url_is_local_infra,
)

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
    # Restore every websockets connect we patched (top-level + submodules).
    for key, orig in list(_originals.items()):
        if key == "websockets_connect":
            import websockets
            websockets.connect = orig
        elif key.endswith(".connect"):
            try:
                import importlib

                modname = key[: -len(".connect")]
                setattr(importlib.import_module(modname), "connect", orig)
            except Exception:
                pass
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
        url = str(request.url)
        # need_name (E3/E4) always implies a non-local frontier host, so the
        # outer guard is just "is this destination non-local?".
        nonlocal_dest = not url_is_local_infra(url)
        need_name = egress_requires_leak_verify(url)
        if nonlocal_dest or need_name:
            ct = request.headers.get("content-type", "")
            # ADR-038 audio backstop (codex round-2/4/5): audio/* + multipart are
            # audio by declaration; every OTHER non-local body is materialized once
            # and identified by file SIGNATURE so a mislabeled audio body can't slip.
            declared_audio = nonlocal_dest and _positive_audio_ct(ct)
            if declared_audio:
                assert_audio_egress_allowed(url, purpose="httpx audio upload")
            # The audio gate and the E3/E4 name scan are AND, not XOR (codex
            # round-6): a multipart/audio body to a frontier host can ALSO carry
            # real names in form fields (e.g. known_speaker_names) and must be
            # leak-verified even after a cloud-audio opt-in.
            if need_name or (nonlocal_dest and not declared_audio):
                body = _materialize_body_sync(request, url)
                if nonlocal_dest and not declared_audio and _has_audio_magic(bytes(body[:512])):
                    assert_audio_egress_allowed(url, purpose="httpx audio upload")
                if need_name:
                    assert_body_clean(body, url)
        assert_local_egress(url, purpose="httpx")
        return _orig_sync_send(self, request, *args, **kwargs)

    async def _guarded_async_send(self, request, *args, **kwargs):
        url = str(request.url)
        nonlocal_dest = not url_is_local_infra(url)
        need_name = egress_requires_leak_verify(url)
        if nonlocal_dest or need_name:
            ct = request.headers.get("content-type", "")
            declared_audio = nonlocal_dest and _positive_audio_ct(ct)
            if declared_audio:
                assert_audio_egress_allowed(url, purpose="httpx audio upload")
            if need_name or (nonlocal_dest and not declared_audio):
                body = await _materialize_body_async(request, url)
                if nonlocal_dest and not declared_audio and _has_audio_magic(bytes(body[:512])):
                    assert_audio_egress_allowed(url, purpose="httpx audio upload")
                if need_name:
                    assert_body_clean(body, url)
        assert_local_egress(url, purpose="httpx-async")
        return await _orig_async_send(self, request, *args, **kwargs)

    _guarded_sync_send._lct_egress_wrapped = True  # type: ignore[attr-defined]
    _guarded_async_send._lct_egress_wrapped = True  # type: ignore[attr-defined]

    httpx.Client.send = _guarded_sync_send  # type: ignore[assignment]
    httpx.AsyncClient.send = _guarded_async_send  # type: ignore[assignment]


def _has_audio_magic(buf: bytes) -> bool:
    """Identify audio by file SIGNATURE, regardless of declared content-type or
    filename (the import pipeline can save an audio upload as ``.bin`` +
    ``application/octet-stream`` — codex round-4)."""
    if not buf:
        return False
    if b"RIFF" in buf and b"WAVE" in buf:   # WAV (require WAVE; bare RIFF is AVI/WebP)
        return True
    if b"OggS" in buf or b"fLaC" in buf:    # OGG, FLAC
        return True
    if b"ftyp" in buf[:64]:                 # MP4 / M4A container
        return True
    if buf[:3] == b"ID3":                   # MP3 with an ID3 tag
        return True
    return False


def _positive_audio_ct(ct: str) -> bool:
    """Content-types that ARE audio by declaration alone — an ``audio/*`` body, or
    ANY multipart upload (LCT's only non-local multipart is STT; a part can be
    octet-stream / extensionless, so we do not trust the part's declared type)."""
    ct = (ct or "").lower()
    return ct.startswith("audio/") or ct.startswith("multipart/")


def _make_replayable(request, body: bytes) -> None:
    """After consuming a streaming body to scan it, replace the request's stream
    with a replayable ByteStream so the REAL send transmits the same bytes (not an
    exhausted one-shot generator). httpx's ByteStream is iterable both sync and
    async, so it serves Client and AsyncClient. If we cannot guarantee a
    replayable body (httpx internal moved), FAIL CLOSED — block rather than risk
    sending an inconsistent request (codex review, Finding 2)."""
    try:
        from httpx._content import ByteStream

        request.stream = ByteStream(body)
        request._content = body
    except Exception as exc:
        raise UnverifiedEgressBlocked(
            "refusing E3/E4 send: cannot install a replayable body for leak-verify "
            f"({type(exc).__name__}: {exc})"
        ) from exc


def _materialize_body_sync(request, url: str) -> bytes:
    """Return the exact outbound body bytes for leak-verify, or FAIL CLOSED.

    ``request.content`` raises ``httpx.RequestNotRead`` for streamed/generator
    bodies; we ``read()`` to materialize, then make the request replayable so the
    real send is unaffected. A body that genuinely cannot be replayed is REFUSED
    for E3/E4 rather than passed unscanned (codex blocker 1)."""
    import httpx

    try:
        return request.content
    except httpx.RequestNotRead:
        pass
    try:
        body = request.read()
    except Exception as exc:  # one-shot/async stream on a sync path, etc.
        raise UnverifiedEgressBlocked(
            f"refusing E3/E4 send to {request.url.host!r}: request body could not "
            f"be materialized for leak-verify ({type(exc).__name__})"
        ) from exc
    _make_replayable(request, body)
    return body


async def _materialize_body_async(request, url: str) -> bytes:
    import httpx

    try:
        return request.content
    except httpx.RequestNotRead:
        pass
    try:
        body = await request.aread()
    except Exception as exc:
        raise UnverifiedEgressBlocked(
            f"refusing E3/E4 send to {request.url.host!r}: request body could not "
            f"be materialized for leak-verify ({type(exc).__name__})"
        ) from exc
    _make_replayable(request, body)
    return body


# --- websockets (OpenAI / backend realtime STT) ------------------------------

def _wrap_websockets() -> None:
    try:
        import websockets
    except Exception:
        return

    # Patch the top-level ``websockets.connect`` AND the submodule connects
    # (``websockets.asyncio.client``, ``websockets.legacy.client``,
    # ``websockets.client``). google-genai LIVE binds the submodule form by value
    # (``from websockets.asyncio.client import connect as ws_connect``), so a
    # top-level-only patch is bypassable (codex blocker 5). Patching the submodule
    # attribute closes that for any consumer that imports it AFTER install — which
    # is why ``bootstrap_egress()`` must run before those imports. A consumer that
    # bound the name BEFORE install still escapes (documented residual). Audio over
    # google-genai live is ALSO covered by the audio hard-gate.
    targets: list[tuple[str, object, str]] = []
    top = getattr(websockets, "connect", None)
    if top is not None:
        targets.append(("websockets_connect", websockets, "connect"))
    for modname in ("websockets.asyncio.client", "websockets.legacy.client", "websockets.client"):
        try:
            import importlib

            mod = importlib.import_module(modname)
        except Exception:
            continue
        if getattr(mod, "connect", None) is not None:
            targets.append((modname + ".connect", mod, "connect"))

    for key, mod, attr in targets:
        orig = getattr(mod, attr)
        if getattr(orig, "_lct_egress_wrapped", False):
            continue
        _originals.setdefault(key, orig)

        def _make_guard(_orig):
            def _guarded_connect(uri, *args, **kwargs):
                assert_local_egress(str(uri), purpose="websocket")
                # ADR-038 audio backstop (codex round-2): LCT's only cloud
                # websockets carry audio (realtime STT, backend realtime,
                # google-genai live). Require the audio opt-in for any non-local
                # ws so LCT_LOCAL_ONLY=0 doesn't leak raw voice — centrally,
                # covering every ws site at once.
                if not url_is_local_infra(str(uri)):
                    assert_audio_egress_allowed(str(uri), purpose="websocket audio")
                return _orig(uri, *args, **kwargs)

            _guarded_connect._lct_egress_wrapped = True  # type: ignore[attr-defined]
            return _guarded_connect

        setattr(mod, attr, _make_guard(orig))


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

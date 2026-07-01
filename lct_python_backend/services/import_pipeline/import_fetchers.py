"""File and URL fetch helpers for transcript import endpoints."""

import fnmatch
import os
import re
import tempfile
from typing import Optional, Tuple
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, UploadFile

from ..egress_guard import import_egress_allow
from .import_validation import assert_url_resolves_to_public_host

MAX_URL_IMPORT_BYTES = int(os.getenv("MAX_URL_IMPORT_BYTES", str(2 * 1024 * 1024)))

# Google Docs export is fetched SSRF-safely: egress is permitted only for these
# hosts and only inside import_egress_allow(); every redirect hop is re-validated.
GDOC_EGRESS_ALLOW_HOSTS = ("docs.google.com", "*.googleusercontent.com")
GDOC_MAX_REDIRECTS = 4

_GDOC_DOC_ID_RE = re.compile(r"^https://docs\.google\.com/document/d/([A-Za-z0-9_-]+)")


async def download_url_text(url: str) -> str:
    """Download URL content as text with bounded size and strict redirect policy."""
    # Defense in depth: even if the upstream caller forgot to run
    # validate_import_url, refuse to fetch from internal hosts. This
    # also catches public hostnames that resolve to internal IPs.
    assert_url_resolves_to_public_host(url)
    timeout = httpx.Timeout(30.0, connect=10.0, read=30.0)
    total_bytes = 0
    content_chunks = []

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            async with client.stream("GET", url) as response:
                if 300 <= response.status_code < 400:
                    raise HTTPException(
                        status_code=400,
                        detail="Redirect responses are not allowed for URL import. Use the final direct URL.",
                    )

                response.raise_for_status()
                response_encoding = response.encoding or "utf-8"

                async for chunk in response.aiter_bytes():
                    total_bytes += len(chunk)
                    if total_bytes > MAX_URL_IMPORT_BYTES:
                        limit_mb = MAX_URL_IMPORT_BYTES / (1024 * 1024)
                        raise HTTPException(
                            status_code=400,
                            detail=f"URL content too large. Limit: {limit_mb:.1f} MB.",
                        )
                    content_chunks.append(chunk)

    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code if exc.response is not None else 400
        raise HTTPException(
            status_code=400,
            detail=f"Failed to fetch URL (status {status_code}).",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(exc)}") from exc

    content_bytes = b"".join(content_chunks)
    return content_bytes.decode(response_encoding, errors="replace")


def gdoc_export_url(url: str) -> Optional[str]:
    """If ``url`` is a Google Docs *document* URL, return its plain-text export URL; else None."""
    match = _GDOC_DOC_ID_RE.match((url or "").strip())
    if not match:
        return None
    return f"https://docs.google.com/document/d/{match.group(1)}/export?format=txt"


def _assert_gdoc_hop_allowed(url: str) -> None:
    """Per-hop SSRF gate for the gdoc fetch: the URL must (a) resolve to a public host
    and (b) match the narrow gdoc allowlist. Applied to the export URL AND every
    redirect target, so a redirect to an internal or off-allowlist host is refused.
    """
    assert_url_resolves_to_public_host(url)  # blocks internal IPs / public-DNS→internal
    host = (urlsplit(url).hostname or "").strip().lower()
    if not any(fnmatch.fnmatch(host, glob) for glob in GDOC_EGRESS_ALLOW_HOSTS):
        raise HTTPException(
            status_code=400,
            detail=f"gdoc fetch redirected off the allowlist (host {host!r}).",
        )


async def download_gdoc_text(gdoc_url: str, *, _transport=None) -> str:
    """Fetch a Google Docs document as plain text via its export URL, SSRF-safely.

    Unlike ``download_url_text`` (which refuses ALL redirects), Google's export URL
    302-redirects to a random ``*.googleusercontent.com`` host — so this follows
    redirects, but re-validates EVERY hop (public-host + narrow allowlist) and permits
    egress only within ``import_egress_allow()`` so the allowlist never leaks to any
    other outbound call. ``_transport`` is a test-only seam for injecting a MockTransport.
    """
    export_url = gdoc_export_url(gdoc_url)
    if not export_url:
        raise HTTPException(status_code=400, detail="Not a Google Docs document URL.")

    timeout = httpx.Timeout(30.0, connect=10.0, read=30.0)
    client_kwargs = {"follow_redirects": False, "timeout": timeout}
    if _transport is not None:
        client_kwargs["transport"] = _transport
    current_url = export_url

    try:
        with import_egress_allow(GDOC_EGRESS_ALLOW_HOSTS):
            async with httpx.AsyncClient(**client_kwargs) as client:
                for _hop in range(GDOC_MAX_REDIRECTS + 1):
                    _assert_gdoc_hop_allowed(current_url)
                    async with client.stream("GET", current_url) as response:
                        if 300 <= response.status_code < 400:
                            location = response.headers.get("location")
                            if not location:
                                raise HTTPException(
                                    status_code=400,
                                    detail="gdoc export redirect had no Location header.",
                                )
                            current_url = str(httpx.URL(current_url).join(location))
                            continue

                        response.raise_for_status()
                        content_type = (
                            (response.headers.get("content-type") or "")
                            .split(";", 1)[0]
                            .strip()
                            .lower()
                        )
                        # export?format=txt returns text/plain; reject anything else
                        # (e.g. a text/html login/error page) even from an allowlisted host.
                        if content_type and not content_type.startswith("text/plain"):
                            raise HTTPException(
                                status_code=400,
                                detail=f"gdoc export returned unexpected content-type {content_type!r}.",
                            )
                        response_encoding = response.encoding or "utf-8"
                        total_bytes = 0
                        content_chunks = []
                        async for chunk in response.aiter_bytes():
                            total_bytes += len(chunk)
                            if total_bytes > MAX_URL_IMPORT_BYTES:
                                limit_mb = MAX_URL_IMPORT_BYTES / (1024 * 1024)
                                raise HTTPException(
                                    status_code=400,
                                    detail=f"gdoc content too large. Limit: {limit_mb:.1f} MB.",
                                )
                            content_chunks.append(chunk)
                        return b"".join(content_chunks).decode(response_encoding, errors="replace")

                raise HTTPException(
                    status_code=400,
                    detail="Too many redirects fetching the gdoc export.",
                )
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code if exc.response is not None else 400
        raise HTTPException(
            status_code=400, detail=f"Failed to fetch gdoc (status {status_code})."
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch gdoc: {str(exc)}") from exc


async def save_upload_to_temp_file(upload_file: UploadFile, suffix: str) -> Tuple[str, int]:
    """Persist an uploaded file to a temporary path and return (path, byte_size)."""
    content = await upload_file.read()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_file.write(content)
        temp_path = temp_file.name

    return temp_path, len(content)

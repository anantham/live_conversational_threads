"""Validation helpers for transcript import endpoints."""

import ipaddress
import os
import socket
from typing import List, Optional
from urllib.parse import urlsplit

from fastapi import HTTPException

TRUE_ENV_VALUES = {"1", "true", "yes"}
DISALLOWED_IMPORT_HOST_SUFFIXES = (".local", ".internal", ".localhost")
SUPPORTED_TRANSCRIPT_EXTENSIONS = {".pdf", ".txt", ".text"}


def is_url_import_enabled() -> bool:
    """Return whether URL import is enabled via environment variable."""
    return os.getenv("ENABLE_URL_IMPORT", "false").lower() in TRUE_ENV_VALUES


def _is_disallowed_import_host(hostname: str) -> bool:
    normalized = hostname.strip().lower().rstrip(".")
    if not normalized:
        return True

    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True

    if normalized.endswith(DISALLOWED_IMPORT_HOST_SUFFIXES):
        return True

    ip_candidate = normalized[1:-1] if normalized.startswith("[") and normalized.endswith("]") else normalized
    try:
        ip_addr = ipaddress.ip_address(ip_candidate)
    except ValueError:
        return False

    return (
        ip_addr.is_private
        or ip_addr.is_loopback
        or ip_addr.is_link_local
        or ip_addr.is_multicast
        or ip_addr.is_reserved
        or ip_addr.is_unspecified
    )


def validate_import_url(raw_url: str) -> str:
    """Validate URL import target and return a normalized URL string."""
    parsed = urlsplit((raw_url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="URL must use http:// or https://")

    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="URL must include a valid host")

    hostname = parsed.hostname or ""
    if _is_disallowed_import_host(hostname):
        raise HTTPException(
            status_code=400,
            detail="URL host is not allowed for import (local/private network targets are blocked)",
        )

    return parsed.geturl()


def validate_transcript_filename(filename: Optional[str]) -> str:
    """Validate transcript filename and return normalized extension."""
    if not filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    from pathlib import Path

    file_ext = Path(filename).suffix.lower()
    if file_ext not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {file_ext}. Only PDF and TXT are supported.",
        )
    return file_ext


def _ip_is_internal(ip: ipaddress._BaseAddress) -> bool:
    return bool(
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def assert_url_resolves_to_public_host(url: str) -> None:
    """Raise HTTPException if the URL points at a non-public address.

    Complementary to ``validate_import_url``: that function blocks
    obvious literal-IP / hostname strings. This function additionally
    resolves the hostname and rejects if any returned address is
    internal (loopback / RFC1918 / link-local / IMDS). Catches the
    "public DNS → internal IP" attack class.

    Falls back silently to letting the actual fetch surface DNS errors
    when resolution itself fails — the goal is SSRF prevention, not
    error masking.
    """
    parsed = urlsplit((url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(
            status_code=400,
            detail=f"Only http/https URLs allowed (got {parsed.scheme!r}).",
        )
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail="URL missing host.")

    # Strip [] from IPv6 literals
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        ip = ipaddress.ip_address(candidate)
        if _ip_is_internal(ip):
            raise HTTPException(
                status_code=400,
                detail="URL host is internal/private (loopback, RFC1918, link-local).",
            )
        return
    except ValueError:
        pass

    # Hostname — resolve and check every returned address
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return
    for _family, _type, _proto, _canon, sockaddr in infos:
        try:
            resolved = ipaddress.ip_address(sockaddr[0])
        except (ValueError, IndexError):
            continue
        if _ip_is_internal(resolved):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"URL host {host!r} resolves to an internal address — refusing fetch."
                ),
            )


def get_supported_import_formats(url_import_enabled: Optional[bool] = None) -> List[str]:
    """Return supported import format labels for health/capability responses."""
    enabled = is_url_import_enabled() if url_import_enabled is None else url_import_enabled
    supported_formats = ["pdf", "txt", "text"]
    if enabled:
        supported_formats.append("url")
    return supported_formats

"""STT provider candidate resolution for the bulk upload pipeline."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from lct_python_backend.services.transcription_utils import (
    STT_PROVIDER_ORDER,
    STT_UPLOAD_LOCAL_FIRST,
    STT_UPLOAD_REMOTE_FALLBACK,
    _coerce_str,
    _to_bool,
)


def _is_local_http_url(raw_url: str) -> bool:
    if not raw_url:
        return False
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"}:
        return True
    return host.endswith(".local")


def _resolve_audio_provider_candidates(
    *,
    settings: Dict[str, Any],
    provider_override: Optional[str],
) -> List[Dict[str, str]]:
    """Build an ordered list of provider candidates to try for audio transcription.

    Returns dicts with keys: provider, http_url, reason.
    The first candidate is attempted first; subsequent entries are fallbacks.
    """
    provider_http_urls = settings.get("provider_http_urls")
    provider_url_map = provider_http_urls if isinstance(provider_http_urls, dict) else {}
    configured_provider = _coerce_str(settings.get("provider")).lower()
    override_provider = _coerce_str(provider_override).lower()
    fallback_provider = _coerce_str(settings.get("fallback_provider")).lower()
    external_fallback_http_url = _coerce_str(settings.get("external_fallback_http_url"))
    local_first_enabled = _to_bool(settings.get("upload_local_first"), STT_UPLOAD_LOCAL_FIRST)
    fallback_enabled = _to_bool(settings.get("upload_remote_fallback"), STT_UPLOAD_REMOTE_FALLBACK)

    def provider_url(provider_name: str) -> str:
        normalized = _coerce_str(provider_name).lower()
        if normalized and normalized in provider_url_map:
            return _coerce_str(provider_url_map.get(normalized))
        return ""

    candidates: List[Dict[str, str]] = []
    seen: set[Tuple[str, str]] = set()

    def add_candidate(provider_name: str, http_url: str, reason: str) -> None:
        normalized_provider = _coerce_str(provider_name).lower() or "whisper"
        normalized_url = _coerce_str(http_url)
        if not normalized_url:
            return
        key = (normalized_provider, normalized_url)
        if key in seen:
            return
        seen.add(key)
        candidates.append({"provider": normalized_provider, "http_url": normalized_url, "reason": reason})

    if override_provider:
        add_candidate(
            override_provider,
            provider_url(override_provider) or _coerce_str(settings.get("http_url")),
            "override",
        )
    else:
        primary_added = False
        if local_first_enabled:
            for provider_name in STT_PROVIDER_ORDER:
                local_url = provider_url(provider_name)
                if local_url and _is_local_http_url(local_url):
                    add_candidate(provider_name, local_url, "local_first")
                    primary_added = True
                    break
        if not primary_added:
            add_candidate(
                configured_provider or "whisper",
                provider_url(configured_provider) or _coerce_str(settings.get("http_url")),
                "configured",
            )
            primary_added = len(candidates) > 0
        if not primary_added:
            for provider_name in STT_PROVIDER_ORDER:
                add_candidate(provider_name, provider_url(provider_name), "available")
                if candidates:
                    primary_added = True
                    break

    if fallback_enabled:
        if fallback_provider:
            add_candidate(fallback_provider, provider_url(fallback_provider), "fallback_provider")
        whisper_url = provider_url("whisper")
        if whisper_url and not _is_local_http_url(whisper_url):
            add_candidate("whisper", whisper_url, "fallback_whisper")
        if external_fallback_http_url:
            add_candidate("external", external_fallback_http_url, "fallback_external")
        for provider_name in STT_PROVIDER_ORDER:
            candidate_url = provider_url(provider_name)
            if candidate_url and not _is_local_http_url(candidate_url):
                add_candidate(provider_name, candidate_url, "fallback_remote")

    if not candidates:
        add_candidate(
            configured_provider or override_provider or "whisper",
            _coerce_str(settings.get("http_url")),
            "legacy_http_url",
        )
    return candidates

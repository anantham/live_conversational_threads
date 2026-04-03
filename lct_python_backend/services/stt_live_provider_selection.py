"""Candidate resolution for live websocket STT fallback routing."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from lct_python_backend.services.coercion_helpers import coerce_str, to_bool
from lct_python_backend.services.stt_config import (
    STT_CLOUD_PROVIDER_IDS,
    STT_PROVIDER_IDS,
    _normalize_provider,
    build_cloud_provider_api_url,
    normalize_live_fallback_priority,
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


def resolve_live_stt_candidates(
    *,
    settings: Dict[str, Any],
    provider_override: Optional[str],
) -> List[Dict[str, Any]]:
    """Resolve ordered live-STT candidates for websocket transcription."""
    provider_http_urls = settings.get("provider_http_urls")
    provider_http_map = provider_http_urls if isinstance(provider_http_urls, dict) else {}
    configured_provider = _normalize_provider(settings.get("provider"))
    normalized_override = coerce_str(provider_override).lower()
    cloud_override_provider = (
        normalized_override if normalized_override in STT_CLOUD_PROVIDER_IDS else ""
    )
    selected_provider = _normalize_provider(
        configured_provider if cloud_override_provider else (provider_override or configured_provider)
    )
    configured_http_url = coerce_str(
        provider_http_map.get(selected_provider) or settings.get("http_url")
    )
    local_only = to_bool(settings.get("local_only"), True)
    live_cloud_fallback_enabled = to_bool(settings.get("live_cloud_fallback_enabled"), False)
    live_require_diarization = to_bool(settings.get("live_require_diarization"), True)
    live_allow_text_only_fallback = to_bool(
        settings.get("live_allow_text_only_fallback"),
        False,
    )
    external_fallback_http_url = coerce_str(settings.get("external_fallback_http_url"))
    cloud_providers = (
        settings.get("cloud_fallback_providers")
        if isinstance(settings.get("cloud_fallback_providers"), dict)
        else {}
    )

    candidates: List[Dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    fallback_priority = normalize_live_fallback_priority(settings.get("live_fallback_priority"))

    def add_candidate(candidate: Dict[str, Any]) -> None:
        provider = coerce_str(candidate.get("provider")).lower() or "whisper"
        transport = coerce_str(candidate.get("transport")).lower() or "backend_http"
        endpoint = coerce_str(candidate.get("http_url") or candidate.get("base_url"))
        if not endpoint:
            return
        key = (provider, transport, endpoint)
        if key in seen_keys:
            return
        seen_keys.add(key)
        candidates.append(candidate)

    primary_candidate = {
        "route_id": "configured_provider",
        "provider": selected_provider,
        "transport": "backend_http",
        "http_url": configured_http_url,
        "reason": "configured_provider",
        "supports_diarization": selected_provider == "whisper",
        "degraded": False,
    }

    if local_only:
        add_candidate(primary_candidate)
        return candidates

    fallback_candidates: Dict[str, Dict[str, Any]] = {}

    whisper_http_url = coerce_str(provider_http_map.get("whisper"))
    if selected_provider != "whisper" and whisper_http_url and not _is_local_http_url(whisper_http_url):
        fallback_candidates["remote_whisper"] = {
            "route_id": "remote_whisper",
            "provider": "whisper",
            "transport": "backend_http",
            "http_url": whisper_http_url,
            "reason": "fallback_remote_whisper",
            "supports_diarization": True,
            "degraded": False,
        }

    if external_fallback_http_url:
        fallback_candidates["external_http"] = {
            "route_id": "external_http",
            "provider": "external",
            "transport": "backend_http",
            "http_url": external_fallback_http_url,
            "reason": "fallback_external_http",
            "supports_diarization": False,
            "degraded": True,
        }

    if live_cloud_fallback_enabled:
        openai_provider = cloud_providers.get("openai_audio")
        if isinstance(openai_provider, dict):
            openai_api_key = coerce_str(openai_provider.get("api_key"))
            openai_base_url = coerce_str(openai_provider.get("base_url"))
            openai_model = coerce_str(openai_provider.get("model"))
            openai_diarize_model = coerce_str(openai_provider.get("diarize_model"))
            if (
                to_bool(openai_provider.get("enabled"), False)
                and openai_api_key
                and openai_base_url
                and openai_model
                and (openai_diarize_model or not live_require_diarization)
            ):
                fallback_candidates["openai_audio"] = {
                    "route_id": "openai_audio",
                    "provider": "openai_audio",
                    "transport": "openai_audio",
                    "base_url": openai_base_url,
                    "http_url": build_cloud_provider_api_url("openai_audio", openai_base_url),
                    "api_key": openai_api_key,
                    "model": openai_model,
                    "diarize_model": openai_diarize_model,
                    "reason": "fallback_openai_audio",
                    "supports_diarization": bool(openai_diarize_model),
                    "supports_realtime_streaming": True,
                    "degraded": False,
                    "request_diarization": False,
                }

        openrouter_provider = cloud_providers.get("openrouter_audio")
        if isinstance(openrouter_provider, dict) and (live_allow_text_only_fallback or not live_require_diarization):
            openrouter_api_key = coerce_str(openrouter_provider.get("api_key"))
            openrouter_base_url = coerce_str(openrouter_provider.get("base_url"))
            openrouter_model = coerce_str(openrouter_provider.get("model"))
            if (
                to_bool(openrouter_provider.get("enabled"), False)
                and openrouter_api_key
                and openrouter_base_url
                and openrouter_model
            ):
                fallback_candidates["openrouter_audio"] = {
                    "route_id": "openrouter_audio",
                    "provider": "openrouter_audio",
                    "transport": "openrouter_audio",
                    "base_url": openrouter_base_url,
                    "http_url": build_cloud_provider_api_url("openrouter_audio", openrouter_base_url),
                    "api_key": openrouter_api_key,
                    "model": openrouter_model,
                    "reason": "fallback_openrouter_audio",
                    "supports_diarization": False,
                    "degraded": True,
                }

    if cloud_override_provider:
        add_candidate(fallback_candidates.get(cloud_override_provider) or {})
        add_candidate(primary_candidate)
        for route_id in fallback_priority:
            if route_id == cloud_override_provider:
                continue
            candidate = fallback_candidates.get(route_id)
            if candidate:
                add_candidate(candidate)
        return candidates

    prefer_openai_before_remote_whisper = (
        selected_provider == "whisper"
        and configured_http_url
        and not _is_local_http_url(configured_http_url)
        and "openai_audio" in fallback_priority
        and "openai_audio" in fallback_candidates
    )

    if prefer_openai_before_remote_whisper:
        add_candidate(fallback_candidates["openai_audio"])

    add_candidate(primary_candidate)

    for route_id in fallback_priority:
        if prefer_openai_before_remote_whisper and route_id == "openai_audio":
            continue
        candidate = fallback_candidates.get(route_id)
        if candidate:
            add_candidate(candidate)

    return candidates


def build_live_stt_background_refinement_candidate(
    *,
    settings: Dict[str, Any],
    primary_candidate: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Return a non-blocking background diarization candidate for the live route."""
    candidate = primary_candidate if isinstance(primary_candidate, dict) else {}
    primary_provider = coerce_str(candidate.get("provider")).lower()
    primary_transport = coerce_str(candidate.get("transport")).lower()
    if primary_provider != "openai_audio" or primary_transport != "openai_audio":
        return None
    if not to_bool(settings.get("live_require_diarization"), True):
        return None

    cloud_providers = (
        settings.get("cloud_fallback_providers")
        if isinstance(settings.get("cloud_fallback_providers"), dict)
        else {}
    )
    openai_provider = cloud_providers.get("openai_audio")
    if not isinstance(openai_provider, dict):
        return None

    api_key = coerce_str(openai_provider.get("api_key"))
    base_url = coerce_str(openai_provider.get("base_url"))
    diarize_model = coerce_str(openai_provider.get("diarize_model"))
    if not (
        to_bool(openai_provider.get("enabled"), False)
        and api_key
        and base_url
        and diarize_model
    ):
        return None

    return {
        "route_id": "openai_audio_diarize_background",
        "provider": "openai_audio",
        "transport": "openai_audio",
        "base_url": base_url,
        "http_url": build_cloud_provider_api_url("openai_audio", base_url),
        "api_key": api_key,
        "model": diarize_model,
        "reason": "background_openai_diarize",
        "supports_diarization": True,
        "supports_realtime_streaming": False,
        "degraded": False,
        "request_diarization": True,
    }

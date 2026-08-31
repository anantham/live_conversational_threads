"""Candidate resolution for live websocket STT fallback routing."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from lct_python_backend.services.coercion_helpers import coerce_str, to_bool
from .stt_authority import (
    VALIDATED_BYOK_SCOPE,
    resolve_local_authority_candidates,
    validated_byok_provider,
)
from .stt_config import (
    build_cloud_provider_api_url,
)

def resolve_live_stt_candidates(
    *,
    settings: Dict[str, Any],
    provider_override: Optional[str],
) -> List[Dict[str, Any]]:
    """Resolve live STT from explicit authority records only.

    Saved provider choices describe preference, not egress authority. Local
    records are ordered by the owner-controlled environment configuration. A
    cloud route is considered only when ``byok_session_store`` minted the
    validated session marker for the exact requested provider.
    """
    cloud_providers = (
        settings.get("cloud_fallback_providers")
        if isinstance(settings.get("cloud_fallback_providers"), dict)
        else {}
    )
    candidates: List[Dict[str, Any]] = []

    granted_provider = validated_byok_provider(settings, provider_override)
    if granted_provider:
        provider = cloud_providers.get(granted_provider)
        if isinstance(provider, dict):
            api_key = coerce_str(provider.get("api_key"))
            base_url = coerce_str(provider.get("base_url"))
            model = coerce_str(provider.get("model"))
            if to_bool(provider.get("enabled"), False) and api_key and base_url and model:
                candidates.append({
                    "route_id": f"byok_{granted_provider}_live",
                    "authority_scope": VALIDATED_BYOK_SCOPE,
                    "provider": granted_provider,
                    "transport": granted_provider,
                    "base_url": base_url,
                    "http_url": build_cloud_provider_api_url(granted_provider, base_url),
                    "api_key": api_key,
                    "model": model,
                    "diarize_model": coerce_str(provider.get("diarize_model")),
                    "reason": "validated_session_byok",
                    "supports_diarization": bool(coerce_str(provider.get("diarize_model"))),
                    "supports_realtime_streaming": granted_provider == "openai_audio",
                    "degraded": granted_provider == "openrouter_audio",
                    "request_diarization": False,
                })

    for candidate in resolve_local_authority_candidates(settings):
        local_candidate = dict(candidate)
        if local_candidate.get("provider") == "whisper":
            ws_url = coerce_str(local_candidate.get("ws_url"))
            if ws_url:
                local_candidate["ws_url"] = ws_url
                local_candidate["supports_realtime_streaming"] = True
        candidates.append(local_candidate)
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
    primary_http_url = coerce_str(candidate.get("http_url"))

    # If primary is already diarizing, we don't need a separate background refinement loop.
    # OpenAI realtime reuses the "openai_audio" route family for low-latency captions, but
    # that primary route is request_diarization=False and still benefits from a slower
    # background diarized upload pass.
    if (
        primary_provider == "whisper"
        and primary_http_url
        and to_bool(settings.get("live_require_diarization"), True)
    ):
        return {
            "route_id": "whisper_diarize_background",
            "authority_id": coerce_str(candidate.get("authority_id")),
            "authority_scope": coerce_str(candidate.get("authority_scope")),
            "provider": "whisper",
            "transport": "backend_http",
            "http_url": primary_http_url,
            "ws_url": coerce_str(candidate.get("ws_url")),
            "model": coerce_str(candidate.get("model")),
            "reason": "background_whisper_diarize",
            "supports_diarization": True,
            "supports_realtime_streaming": False,
            "degraded": bool(candidate.get("degraded")),
            "request_diarization": True,
        }

    if not to_bool(settings.get("live_require_diarization"), True):
        return None

    if (
        to_bool(candidate.get("supports_diarization"), False)
        and to_bool(candidate.get("request_diarization"), False)
    ):
        return None

    primary_authority_id = coerce_str(candidate.get("authority_id"))
    for local_candidate in resolve_local_authority_candidates(settings):
        if coerce_str(local_candidate.get("authority_id")) == primary_authority_id:
            continue
        if not to_bool(local_candidate.get("supports_diarization"), False):
            continue
        return {
            **local_candidate,
            "route_id": f"{local_candidate['route_id']}_diarize_background",
            "reason": f"background_{local_candidate['reason']}",
            "supports_realtime_streaming": False,
            "request_diarization": True,
        }

    if (
        primary_provider != "openai_audio"
        or primary_transport != "openai_audio"
        or coerce_str(candidate.get("authority_scope")) != VALIDATED_BYOK_SCOPE
    ):
        return None

    diarize_model = coerce_str(candidate.get("diarize_model"))
    if not diarize_model:
        return None

    return {
        "route_id": "openai_audio_diarize_background",
        "authority_scope": VALIDATED_BYOK_SCOPE,
        "provider": "openai_audio",
        "transport": "openai_audio",
        "base_url": coerce_str(candidate.get("base_url")),
        "http_url": coerce_str(candidate.get("http_url")),
        "api_key": coerce_str(candidate.get("api_key")),
        "model": diarize_model,
        "reason": "background_openai_diarize",
        "supports_diarization": True,
        "supports_realtime_streaming": False,
        "degraded": False,
        "request_diarization": True,
    }

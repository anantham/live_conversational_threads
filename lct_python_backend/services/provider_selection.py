"""Explicit STT authority resolution for the bulk upload pipeline."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from lct_python_backend.services.coercion_helpers import coerce_str, to_bool
from lct_python_backend.services.stt.stt_authority import (
    VALIDATED_BYOK_SCOPE,
    resolve_local_authority_candidates,
    validated_byok_provider,
)
from lct_python_backend.services.stt.stt_config import build_cloud_provider_api_url


def resolve_import_audio_candidates(
    *,
    settings: Dict[str, Any],
    provider_override: Optional[str],
) -> List[Dict[str, Any]]:
    """Resolve import STT from validated BYOK plus ordered local authorities."""
    candidates: List[Dict[str, Any]] = []
    cloud_providers = (
        settings.get("cloud_fallback_providers")
        if isinstance(settings.get("cloud_fallback_providers"), dict)
        else {}
    )
    granted_provider = validated_byok_provider(settings, provider_override)
    if granted_provider:
        provider = cloud_providers.get(granted_provider)
        if isinstance(provider, dict):
            api_key = coerce_str(provider.get("api_key"))
            base_url = coerce_str(provider.get("base_url"))
            model = coerce_str(provider.get("model"))
            diarize_model = coerce_str(provider.get("diarize_model"))
            cloud_ready = (
                to_bool(provider.get("enabled"), False)
                and api_key
                and base_url
                and model
                and (granted_provider != "openai_audio" or diarize_model)
            )
            if cloud_ready:
                candidates.append({
                    "route_id": f"byok_{granted_provider}_import",
                    "authority_scope": VALIDATED_BYOK_SCOPE,
                    "provider": granted_provider,
                    "transport": granted_provider,
                    "base_url": base_url,
                    "http_url": build_cloud_provider_api_url(granted_provider, base_url),
                    "api_key": api_key,
                    "model": diarize_model if granted_provider == "openai_audio" else model,
                    "diarize_model": diarize_model,
                    "reason": "validated_session_byok",
                    "supports_diarization": bool(diarize_model),
                    "supports_realtime_streaming": False,
                    "degraded": granted_provider == "openrouter_audio",
                    "request_diarization": granted_provider == "openai_audio",
                })

    candidates.extend(resolve_local_authority_candidates(settings))
    return candidates

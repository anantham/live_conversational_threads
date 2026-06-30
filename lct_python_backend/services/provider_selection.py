"""STT provider candidate resolution for the bulk upload pipeline."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from lct_python_backend.services.coercion_helpers import coerce_str, to_bool
from lct_python_backend.services.stt.stt_config import (
    STT_CLOUD_PROVIDER_IDS,
    build_cloud_provider_api_url,
    normalize_live_fallback_priority,
)
from lct_python_backend.services.transcript.transcription_utils import (
    STT_PROVIDER_ORDER,
    STT_UPLOAD_LOCAL_FIRST,
    STT_UPLOAD_REMOTE_FALLBACK,
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
    configured_provider = coerce_str(settings.get("provider")).lower()
    override_provider = coerce_str(provider_override).lower()
    fallback_provider = coerce_str(settings.get("fallback_provider")).lower()
    external_fallback_http_url = coerce_str(settings.get("external_fallback_http_url"))
    local_first_enabled = to_bool(settings.get("upload_local_first"), STT_UPLOAD_LOCAL_FIRST)
    fallback_enabled = to_bool(settings.get("upload_remote_fallback"), STT_UPLOAD_REMOTE_FALLBACK)

    def provider_url(provider_name: str) -> str:
        normalized = coerce_str(provider_name).lower()
        if normalized and normalized in provider_url_map:
            return coerce_str(provider_url_map.get(normalized))
        return ""

    candidates: List[Dict[str, str]] = []
    seen: set[Tuple[str, str]] = set()

    def add_candidate(provider_name: str, http_url: str, reason: str) -> None:
        normalized_provider = coerce_str(provider_name).lower() or "whisper"
        normalized_url = coerce_str(http_url)
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
            provider_url(override_provider) or coerce_str(settings.get("http_url")),
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
                provider_url(configured_provider) or coerce_str(settings.get("http_url")),
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
            coerce_str(settings.get("http_url")),
            "legacy_http_url",
        )
    return candidates


def resolve_import_audio_candidates(
    *,
    settings: Dict[str, Any],
    provider_override: Optional[str],
) -> List[Dict[str, Any]]:
    """Resolve ordered import/upload STT candidates.

    Routing honors ``upload_local_first`` (default ``STT_UPLOAD_LOCAL_FIRST``,
    env-overridable, currently True): when it is enabled and a local provider
    URL is configured, the local backend is the primary candidate for uploads.
    Batch transcription is not latency-bound, so local is preferred for the
    privacy/offline goal; cloud (OpenAI diarized) remains reachable as a
    fallback via ``upload_remote_fallback`` / ``live_fallback_priority``.

    When ``upload_local_first`` is disabled, uploads instead prefer the OpenAI
    diarized cloud path for final transcript quality before the local/remote
    backend-http chain. ``local_only`` removes cloud candidates entirely, and
    an explicit ``provider_override`` wins over both.
    """
    provider_http_urls = settings.get("provider_http_urls")
    provider_url_map = provider_http_urls if isinstance(provider_http_urls, dict) else {}
    configured_provider = coerce_str(settings.get("provider")).lower()
    override_provider = coerce_str(provider_override).lower()
    fallback_provider = coerce_str(settings.get("fallback_provider")).lower()
    external_fallback_http_url = coerce_str(settings.get("external_fallback_http_url"))
    local_only = to_bool(settings.get("local_only"), False)
    local_first_enabled = to_bool(settings.get("upload_local_first"), STT_UPLOAD_LOCAL_FIRST)
    fallback_enabled = to_bool(settings.get("upload_remote_fallback"), STT_UPLOAD_REMOTE_FALLBACK)
    cloud_fallback_enabled = to_bool(settings.get("live_cloud_fallback_enabled"), False)
    allow_text_only_fallback = to_bool(settings.get("live_allow_text_only_fallback"), False)
    fallback_priority = normalize_live_fallback_priority(settings.get("live_fallback_priority"))
    cloud_providers = (
        settings.get("cloud_fallback_providers")
        if isinstance(settings.get("cloud_fallback_providers"), dict)
        else {}
    )

    def provider_url(provider_name: str) -> str:
        normalized = coerce_str(provider_name).lower()
        if normalized and normalized in provider_url_map:
            return coerce_str(provider_url_map.get(normalized))
        return ""

    candidates: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str, str]] = set()

    def add_candidate(candidate: Dict[str, Any]) -> None:
        provider = coerce_str(candidate.get("provider")).lower() or "whisper"
        transport = coerce_str(candidate.get("transport")).lower() or "backend_http"
        endpoint = coerce_str(candidate.get("http_url") or candidate.get("base_url"))
        if not endpoint:
            return
        key = (provider, transport, endpoint)
        if key in seen:
            return
        seen.add(key)
        candidates.append(candidate)

    def build_backend_http_candidate(provider_name: str, reason: str) -> Optional[Dict[str, Any]]:
        normalized_provider = coerce_str(provider_name).lower() or "whisper"
        http_url = provider_url(normalized_provider)
        if not http_url:
            return None
        return {
            "route_id": reason,
            "provider": normalized_provider,
            "transport": "backend_http",
            "http_url": http_url,
            "reason": reason,
            "supports_diarization": normalized_provider == "whisper",
            "degraded": False,
        }

    def build_openai_import_candidate() -> Optional[Dict[str, Any]]:
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
            "route_id": "openai_audio_import_diarized",
            "provider": "openai_audio",
            "transport": "openai_audio",
            "base_url": base_url,
            "http_url": build_cloud_provider_api_url("openai_audio", base_url),
            "api_key": api_key,
            "model": diarize_model,
            "reason": "import_openai_audio_diarized",
            "supports_diarization": True,
            "supports_realtime_streaming": False,
            "degraded": False,
            "request_diarization": True,
        }

    def build_openrouter_import_candidate() -> Optional[Dict[str, Any]]:
        openrouter_provider = cloud_providers.get("openrouter_audio")
        if not isinstance(openrouter_provider, dict) or not allow_text_only_fallback:
            return None
        api_key = coerce_str(openrouter_provider.get("api_key"))
        base_url = coerce_str(openrouter_provider.get("base_url"))
        model = coerce_str(openrouter_provider.get("model"))
        if not (
            to_bool(openrouter_provider.get("enabled"), False)
            and api_key
            and base_url
            and model
        ):
            return None
        return {
            "route_id": "openrouter_audio_import_text",
            "provider": "openrouter_audio",
            "transport": "openrouter_audio",
            "base_url": base_url,
            "http_url": build_cloud_provider_api_url("openrouter_audio", base_url),
            "api_key": api_key,
            "model": model,
            "reason": "import_openrouter_audio_text",
            "supports_diarization": False,
            "supports_realtime_streaming": False,
            "degraded": True,
            "request_diarization": False,
        }

    fallback_candidates: Dict[str, Dict[str, Any]] = {}
    whisper_http_url = provider_url("whisper")
    if whisper_http_url and not _is_local_http_url(whisper_http_url):
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
    if cloud_fallback_enabled and not local_only:
        openai_candidate = build_openai_import_candidate()
        if openai_candidate:
            fallback_candidates["openai_audio"] = openai_candidate
        openrouter_candidate = build_openrouter_import_candidate()
        if openrouter_candidate:
            fallback_candidates["openrouter_audio"] = openrouter_candidate

    if override_provider in STT_CLOUD_PROVIDER_IDS:
        add_candidate(
            fallback_candidates.get(override_provider)
            or (build_openai_import_candidate() if override_provider == "openai_audio" else build_openrouter_import_candidate())
            or {}
        )
    else:
        primary_added = False
        # Try local first when upload_local_first is enabled — before cloud
        # primary. Previously the cloud-primary block (now below) would set
        # primary_added=True and short-circuit the local_first block,
        # making upload_local_first a no-op whenever OpenAI was configured.
        # For the offline/privacy goal, local should win for uploads
        # (latency is not the binding constraint for batch); OpenAI remains
        # reachable via the `fallback_enabled` block at end of function.
        if local_first_enabled and not override_provider:
            for provider_name in STT_PROVIDER_ORDER:
                local_url = provider_url(provider_name)
                if local_url and _is_local_http_url(local_url):
                    add_candidate(
                        build_backend_http_candidate(provider_name, "local_first") or {}
                    )
                    if len(candidates) > 0:
                        primary_added = True
                        break

        cloud_primary_allowed = not override_provider and not local_only
        if not primary_added and cloud_primary_allowed:
            openai_candidate = fallback_candidates.get("openai_audio")
            if openai_candidate:
                add_candidate(openai_candidate)
                primary_added = True

        if not primary_added and override_provider:
            add_candidate(
                build_backend_http_candidate(override_provider, "override") or {}
            )
            primary_added = len(candidates) > 0

        if not primary_added:
            add_candidate(
                build_backend_http_candidate(
                    configured_provider or "whisper",
                    "configured",
                )
                or {
                    "route_id": "legacy_http_url",
                    "provider": configured_provider or "whisper",
                    "transport": "backend_http",
                    "http_url": coerce_str(settings.get("http_url")),
                    "reason": "legacy_http_url",
                    "supports_diarization": (configured_provider or "whisper") == "whisper",
                    "degraded": False,
                }
            )

    if fallback_enabled:
        if fallback_provider:
            add_candidate(build_backend_http_candidate(fallback_provider, "fallback_provider") or {})
        for route_id in fallback_priority:
            candidate = fallback_candidates.get(route_id)
            if candidate:
                add_candidate(candidate)
        for provider_name in STT_PROVIDER_ORDER:
            candidate_url = provider_url(provider_name)
            if candidate_url and not _is_local_http_url(candidate_url):
                add_candidate(
                    build_backend_http_candidate(provider_name, "fallback_remote") or {}
                )

    return [candidate for candidate in candidates if candidate]

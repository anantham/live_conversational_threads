import os
from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlparse, urlunparse

STT_CONFIG_KEY = "stt_config"
STT_PROVIDER_IDS = ("senko", "parakeet", "whisper", "ofc")
STT_CLOUD_PROVIDER_IDS = ("openai_audio", "openrouter_audio")
STT_LIVE_FALLBACK_ROUTE_IDS = (
    "remote_whisper",
    "external_http",
    "openai_audio",
    "openrouter_audio",
)
DEFAULT_STT_LIVE_FALLBACK_PRIORITY = list(STT_LIVE_FALLBACK_ROUTE_IDS)
DEFAULT_STT_PROVIDER = "whisper"
DEFAULT_STT_HTTP_URL = "http://localhost:5092/v1/audio/transcriptions"
# IndrasNet orchestrator endpoint (routes local WhisperX first, then Modal fallback).
DEFAULT_STT_WHISPER_HTTP_URL = "http://100.81.65.74:7777/api/transcribe"
DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com"
DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-transcribe-diarize"
DEFAULT_OPENROUTER_AUDIO_BASE_URL = "https://openrouter.ai/api"
DEFAULT_OPENROUTER_AUDIO_MODEL = "google/gemini-2.5-flash"


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    value_str = str(value).strip().lower()
    return value_str in {"1", "true", "yes", "on"}


def _normalize_provider(value: Any) -> str:
    provider = str(value or "").strip().lower()
    if provider in STT_PROVIDER_IDS:
        return provider
    return DEFAULT_STT_PROVIDER


def _normalize_cloud_provider_id(value: Any) -> str:
    provider_id = str(value or "").strip().lower()
    if provider_id in STT_CLOUD_PROVIDER_IDS:
        return provider_id
    return "openai_audio"


def normalize_live_fallback_priority(raw_priority: Any) -> list[str]:
    if isinstance(raw_priority, str):
        raw_items = [item.strip() for item in raw_priority.split(",")]
    elif isinstance(raw_priority, (list, tuple)):
        raw_items = [str(item or "").strip() for item in raw_priority]
    else:
        raw_items = []

    normalized: list[str] = []
    for item in raw_items:
        route_id = str(item or "").strip().lower()
        if not route_id or route_id not in STT_LIVE_FALLBACK_ROUTE_IDS or route_id in normalized:
            continue
        normalized.append(route_id)

    for route_id in DEFAULT_STT_LIVE_FALLBACK_PRIORITY:
        if route_id not in normalized:
            normalized.append(route_id)
    return normalized


def _to_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _coerce_url(value: Any) -> str:
    raw = _to_str(value)
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""
    return urlunparse((scheme, netloc, path, "", "", "")).rstrip("/")


def _strip_cloud_endpoint_suffix(provider_id: str, path: str) -> str:
    normalized = str(path or "").rstrip("/")
    if provider_id == "openrouter_audio":
        suffixes = (
            "/api/v1/chat/completions",
            "/v1/chat/completions",
            "/chat/completions",
            "/api/v1",
            "/v1",
        )
    else:
        suffixes = (
            "/v1/audio/transcriptions",
            "/audio/transcriptions",
            "/v1",
        )
    for suffix in suffixes:
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
            break
    return normalized.rstrip("/")


def normalize_cloud_provider_base_url(provider_id: Any, base_url: Any) -> str:
    normalized_provider_id = _normalize_cloud_provider_id(provider_id)
    coerced = _coerce_url(base_url)
    if not coerced:
        return ""

    parsed = urlparse(coerced)
    path = _strip_cloud_endpoint_suffix(normalized_provider_id, parsed.path)
    if normalized_provider_id == "openrouter_audio":
        if parsed.netloc.lower() == "openrouter.ai" and not path:
            path = "/api"
    else:
        if parsed.netloc.lower() == "api.openai.com":
            path = ""
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", "")).rstrip("/")


def build_cloud_provider_api_url(provider_id: Any, base_url: Any) -> str:
    normalized_provider_id = _normalize_cloud_provider_id(provider_id)
    normalized_base_url = normalize_cloud_provider_base_url(normalized_provider_id, base_url)
    if not normalized_base_url:
        return ""
    if normalized_provider_id == "openrouter_audio":
        return f"{normalized_base_url}/v1/chat/completions"
    return f"{normalized_base_url}/v1/audio/transcriptions"


def _cloud_provider_defaults() -> Dict[str, Dict[str, Any]]:
    return {
        "openai_audio": {
            "id": "openai_audio",
            "name": "OpenAI Audio",
            "enabled": bool(_to_str(os.getenv("OPENAI_API_KEY", ""))),
            "base_url": normalize_cloud_provider_base_url(
                "openai_audio",
                os.getenv("STT_OPENAI_AUDIO_BASE_URL", DEFAULT_OPENAI_AUDIO_BASE_URL),
            ),
            "model": _to_str(os.getenv("STT_OPENAI_AUDIO_MODEL", DEFAULT_OPENAI_AUDIO_MODEL)),
            "api_key": _to_str(os.getenv("OPENAI_API_KEY", "")),
            "supports_diarization": True,
            "degraded": False,
        },
        "openrouter_audio": {
            "id": "openrouter_audio",
            "name": "OpenRouter Audio",
            "enabled": bool(_to_str(os.getenv("OPENROUTER_API_KEY", ""))),
            "base_url": normalize_cloud_provider_base_url(
                "openrouter_audio",
                os.getenv("STT_OPENROUTER_AUDIO_BASE_URL", DEFAULT_OPENROUTER_AUDIO_BASE_URL),
            ),
            "model": _to_str(os.getenv("STT_OPENROUTER_AUDIO_MODEL", DEFAULT_OPENROUTER_AUDIO_MODEL)),
            "api_key": _to_str(os.getenv("OPENROUTER_API_KEY", "")),
            "supports_diarization": False,
            "degraded": True,
        },
    }


def normalize_cloud_provider_record(
    provider_id: Any,
    raw_provider: Any,
    existing_provider: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    normalized_provider_id = _normalize_cloud_provider_id(provider_id)
    defaults = _cloud_provider_defaults()[normalized_provider_id]
    existing = dict(existing_provider or defaults)
    raw = dict(raw_provider) if isinstance(raw_provider, Mapping) else {}

    provider: Dict[str, Any] = {
        "id": normalized_provider_id,
        "name": _to_str(raw.get("name") or existing.get("name") or defaults.get("name")),
        "enabled": _to_bool(raw.get("enabled", existing.get("enabled", defaults.get("enabled")))),
        "base_url": normalize_cloud_provider_base_url(
            normalized_provider_id,
            raw.get("base_url", existing.get("base_url", defaults.get("base_url"))),
        ),
        "model": _to_str(raw.get("model") or existing.get("model") or defaults.get("model")),
        "supports_diarization": bool(defaults.get("supports_diarization")),
        "degraded": bool(defaults.get("degraded")),
    }

    clear_api_key = _to_bool(raw.get("clear_api_key", False))
    incoming_api_key = raw.get("api_key")
    if clear_api_key:
        provider["api_key"] = ""
    elif incoming_api_key is not None:
        provider["api_key"] = _to_str(incoming_api_key)
    else:
        provider["api_key"] = _to_str(existing.get("api_key"))

    return provider


def _merge_cloud_provider_configs(
    raw_providers: Any,
    base_providers: Mapping[str, Mapping[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    raw_map = dict(raw_providers) if isinstance(raw_providers, Mapping) else {}
    merged: Dict[str, Dict[str, Any]] = {}
    for provider_id in STT_CLOUD_PROVIDER_IDS:
        merged[provider_id] = normalize_cloud_provider_record(
            provider_id,
            raw_map.get(provider_id),
            base_providers.get(provider_id),
        )
    return merged


def _sanitize_cloud_provider_for_client(provider: Mapping[str, Any]) -> Dict[str, Any]:
    sanitized = dict(provider)
    api_key = _to_str(sanitized.get("api_key"))
    sanitized["api_key"] = ""
    sanitized["has_api_key"] = bool(api_key)
    sanitized["base_url"] = normalize_cloud_provider_base_url(
        sanitized.get("id"),
        sanitized.get("base_url"),
    )
    return sanitized


def sanitize_stt_config_for_client(config: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(config or {})
    raw_cloud_providers = sanitized.get("cloud_fallback_providers")
    defaults = _cloud_provider_defaults()
    cloud_providers = _merge_cloud_provider_configs(raw_cloud_providers, defaults)
    sanitized["cloud_fallback_providers"] = {
        provider_id: _sanitize_cloud_provider_for_client(provider)
        for provider_id, provider in cloud_providers.items()
    }
    sanitized["live_fallback_priority"] = normalize_live_fallback_priority(
        sanitized.get("live_fallback_priority")
    )
    return sanitized


def _build_provider_urls(default_ws_url: str) -> Dict[str, str]:
    return {
        "senko": _to_str(os.getenv("DEFAULT_STT_SENKO_WS_URL", default_ws_url)),
        "parakeet": _to_str(os.getenv("DEFAULT_STT_PARAKEET_WS_URL", default_ws_url)),
        "whisper": _to_str(os.getenv("DEFAULT_STT_WHISPER_WS_URL", default_ws_url)),
        "ofc": _to_str(os.getenv("DEFAULT_STT_OFC_WS_URL", default_ws_url)),
    }


def _build_provider_http_urls(default_http_url: str) -> Dict[str, str]:
    return {
        "senko": _to_str(os.getenv("DEFAULT_STT_SENKO_HTTP_URL", default_http_url)),
        "parakeet": _to_str(os.getenv("DEFAULT_STT_PARAKEET_HTTP_URL", default_http_url)),
        "whisper": _to_str(os.getenv("DEFAULT_STT_WHISPER_HTTP_URL", DEFAULT_STT_WHISPER_HTTP_URL)),
        "ofc": _to_str(os.getenv("DEFAULT_STT_OFC_HTTP_URL", default_http_url)),
    }


def _merge_provider_urls(raw_urls: Any, base_urls: Mapping[str, str]) -> Dict[str, str]:
    merged = {provider: _to_str(base_urls.get(provider, "")) for provider in STT_PROVIDER_IDS}
    if not isinstance(raw_urls, Mapping):
        return merged

    for provider, url in raw_urls.items():
        normalized_provider = _to_str(provider).lower()
        if normalized_provider in STT_PROVIDER_IDS:
            merged[normalized_provider] = _to_str(url)
    return merged


def get_env_stt_defaults() -> Dict[str, Any]:
    legacy_ws_url = _to_str(os.getenv("DEFAULT_STT_WS_URL", "ws://localhost:43001/stream"))
    default_http_url = _to_str(os.getenv("DEFAULT_STT_HTTP_URL", DEFAULT_STT_HTTP_URL))
    provider = _normalize_provider(os.getenv("DEFAULT_STT_PROVIDER", DEFAULT_STT_PROVIDER))
    provider_urls = _build_provider_urls(legacy_ws_url)
    provider_http_urls = _build_provider_http_urls(default_http_url)
    return {
        "provider": provider,
        "provider_urls": provider_urls,
        "provider_http_urls": provider_http_urls,
        "ws_url": provider_urls.get(provider) or legacy_ws_url,
        "http_url": provider_http_urls.get(provider) or default_http_url,
        "local_only": _to_bool(os.getenv("STT_LOCAL_ONLY", "true")),
        "external_fallback_ws_url": _to_str(os.getenv("STT_EXTERNAL_FALLBACK_WS_URL", "")),
        "external_fallback_http_url": _to_str(os.getenv("STT_EXTERNAL_FALLBACK_HTTP_URL", "")),
        "live_cloud_fallback_enabled": _to_bool(
            os.getenv("STT_LIVE_CLOUD_FALLBACK_ENABLED", "false")
        ),
        "live_require_diarization": _to_bool(
            os.getenv("STT_LIVE_REQUIRE_DIARIZATION", "true")
        ),
        "live_allow_text_only_fallback": _to_bool(
            os.getenv("STT_LIVE_ALLOW_TEXT_ONLY_FALLBACK", "false")
        ),
        "live_fallback_priority": normalize_live_fallback_priority(
            os.getenv(
                "STT_LIVE_FALLBACK_PRIORITY",
                ",".join(DEFAULT_STT_LIVE_FALLBACK_PRIORITY),
            )
        ),
        "cloud_fallback_providers": _cloud_provider_defaults(),
        "store_audio": _to_bool(os.getenv("STT_STORE_AUDIO_DEFAULT", "false")),
        "chunk_endpoint": os.getenv(
            "STT_AUDIO_CHUNK_ENDPOINT",
            "/api/conversations/{conversation_id}/audio/chunk",
        ),
        "complete_endpoint": os.getenv(
            "STT_AUDIO_COMPLETE_ENDPOINT",
            "/api/conversations/{conversation_id}/audio/complete",
        ),
        "http_chunk_seconds": _to_str(os.getenv("STT_HTTP_CHUNK_SECONDS", "1.2")),
        "http_timeout_seconds": _to_str(os.getenv("STT_HTTP_TIMEOUT_SECONDS", "30")),
        "http_model": _to_str(os.getenv("STT_HTTP_MODEL", "")),
        "http_language": _to_str(os.getenv("STT_HTTP_LANGUAGE", "")),
        "sample_rate_hz": _to_str(os.getenv("STT_SAMPLE_RATE_HZ", "16000")),
        "retention": os.getenv("STT_RETENTION_POLICY", "forever"),
        "audio_recordings_dir": os.getenv(
            "AUDIO_RECORDINGS_DIR",
            "./lct_python_backend/recordings",
        ),
        "download_token": os.getenv("AUDIO_DOWNLOAD_TOKEN"),
        "debug": _to_bool(os.getenv("STT_DEBUG", "false")),
    }


def merge_stt_config(overrides: Dict[str, Any]) -> Dict[str, Any]:
    config = get_env_stt_defaults()
    if not overrides or not isinstance(overrides, Mapping):
        return config

    provider = _normalize_provider(overrides.get("provider", config.get("provider")))
    provider_urls = _merge_provider_urls(overrides.get("provider_urls"), config.get("provider_urls", {}))
    provider_http_urls = _merge_provider_urls(
        overrides.get("provider_http_urls"),
        config.get("provider_http_urls", {}),
    )
    cloud_fallback_providers = _merge_cloud_provider_configs(
        overrides.get("cloud_fallback_providers"),
        config.get("cloud_fallback_providers", {}),
    )
    live_fallback_priority = normalize_live_fallback_priority(
        overrides.get("live_fallback_priority", config.get("live_fallback_priority"))
    )
    legacy_ws_url = _to_str(overrides.get("ws_url"))
    legacy_http_url = _to_str(overrides.get("http_url"))
    if legacy_ws_url:
        provider_urls[provider] = legacy_ws_url
    if legacy_http_url:
        provider_http_urls[provider] = legacy_http_url

    sanitized: Dict[str, Any] = {}
    for key, value in overrides.items():
        if key in {
            "store_audio",
            "debug",
            "local_only",
            "live_cloud_fallback_enabled",
            "live_require_diarization",
            "live_allow_text_only_fallback",
        }:
            sanitized[key] = _to_bool(value)
        elif key in {
            "provider",
            "provider_urls",
            "ws_url",
            "provider_http_urls",
            "http_url",
            "cloud_fallback_providers",
            "live_fallback_priority",
        }:
            continue
        else:
            sanitized[key] = value

    sanitized["provider"] = provider
    sanitized["provider_urls"] = provider_urls
    sanitized["provider_http_urls"] = provider_http_urls
    sanitized["cloud_fallback_providers"] = cloud_fallback_providers
    sanitized["live_fallback_priority"] = live_fallback_priority
    config.update(sanitized)

    active_provider_url = _to_str(provider_urls.get(provider))
    if not active_provider_url and config.get("local_only") is False:
        active_provider_url = _to_str(config.get("external_fallback_ws_url"))
    if not active_provider_url:
        active_provider_url = _to_str(config.get("ws_url"))
    config["ws_url"] = active_provider_url

    active_provider_http_url = _to_str(provider_http_urls.get(provider))
    if not active_provider_http_url and config.get("local_only") is False:
        active_provider_http_url = _to_str(config.get("external_fallback_http_url"))
    if not active_provider_http_url:
        active_provider_http_url = _to_str(config.get("http_url"))
    config["http_url"] = active_provider_http_url
    return config

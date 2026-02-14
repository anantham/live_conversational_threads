import os
from typing import Any, Dict, Mapping

STT_CONFIG_KEY = "stt_config"
STT_PROVIDER_IDS = ("senko", "parakeet", "whisper", "ofc")
DEFAULT_STT_PROVIDER = "whisper"


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


def _to_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


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
        "whisper": _to_str(os.getenv("DEFAULT_STT_WHISPER_HTTP_URL", default_http_url)),
        "ofc": _to_str(os.getenv("DEFAULT_STT_OFC_HTTP_URL", default_http_url)),
    }


def _merge_provider_urls(raw_urls: Any, base_urls: Mapping[str, str]) -> Dict[str, str]:
    merged = {provider: _to_str(base_urls.get(provider, "")) for provider in STT_PROVIDER_IDS}
    if not isinstance(raw_urls, dict):
        return merged

    for provider, url in raw_urls.items():
        normalized_provider = _to_str(provider).lower()
        if normalized_provider in STT_PROVIDER_IDS:
            merged[normalized_provider] = _to_str(url)
    return merged


def get_env_stt_defaults() -> Dict[str, Any]:
    legacy_ws_url = _to_str(os.getenv("DEFAULT_STT_WS_URL", "ws://localhost:43001/stream"))
    default_http_url = _to_str(
        os.getenv("DEFAULT_STT_HTTP_URL", "http://localhost:5092/v1/audio/transcriptions")
    )
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
        "store_audio": _to_bool(os.getenv("STT_STORE_AUDIO_DEFAULT", "false")),
        "chunk_endpoint": os.getenv("STT_AUDIO_CHUNK_ENDPOINT", "/api/conversations/{conversation_id}/audio/chunk"),
        "complete_endpoint": os.getenv("STT_AUDIO_COMPLETE_ENDPOINT", "/api/conversations/{conversation_id}/audio/complete"),
        "http_chunk_seconds": _to_str(os.getenv("STT_HTTP_CHUNK_SECONDS", "1.2")),
        "http_timeout_seconds": _to_str(os.getenv("STT_HTTP_TIMEOUT_SECONDS", "30")),
        "http_model": _to_str(os.getenv("STT_HTTP_MODEL", "")),
        "http_language": _to_str(os.getenv("STT_HTTP_LANGUAGE", "")),
        "sample_rate_hz": _to_str(os.getenv("STT_SAMPLE_RATE_HZ", "16000")),
        "retention": os.getenv("STT_RETENTION_POLICY", "forever"),
        "audio_recordings_dir": os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings"),
        "download_token": os.getenv("AUDIO_DOWNLOAD_TOKEN"),
        "debug": _to_bool(os.getenv("STT_DEBUG", "false")),
    }


def merge_stt_config(overrides: Dict[str, Any]) -> Dict[str, Any]:
    config = get_env_stt_defaults()
    if not overrides or not isinstance(overrides, dict):
        return config

    provider = _normalize_provider(overrides.get("provider", config.get("provider")))
    provider_urls = _merge_provider_urls(overrides.get("provider_urls"), config.get("provider_urls", {}))
    provider_http_urls = _merge_provider_urls(
        overrides.get("provider_http_urls"), config.get("provider_http_urls", {})
    )
    legacy_ws_url = _to_str(overrides.get("ws_url"))
    legacy_http_url = _to_str(overrides.get("http_url"))
    if legacy_ws_url:
        provider_urls[provider] = legacy_ws_url
    if legacy_http_url:
        provider_http_urls[provider] = legacy_http_url

    sanitized: Dict[str, Any] = {}
    for key, value in overrides.items():
        if key in {"store_audio", "debug", "local_only"}:
            sanitized[key] = _to_bool(value)
        elif key in {"provider", "provider_urls", "ws_url", "provider_http_urls", "http_url"}:
            continue
        else:
            sanitized[key] = value

    sanitized["provider"] = provider
    sanitized["provider_urls"] = provider_urls
    sanitized["provider_http_urls"] = provider_http_urls
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

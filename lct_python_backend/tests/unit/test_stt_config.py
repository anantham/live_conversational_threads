from lct_python_backend.services.stt.stt_config import (
    DEFAULT_STT_LIVE_FALLBACK_PRIORITY,
    build_cloud_provider_api_url,
    get_env_stt_defaults,
    merge_stt_config,
    normalize_cloud_provider_base_url,
    normalize_live_fallback_priority,
    sanitize_stt_config_for_client,
)


def test_env_defaults_respect_auth(monkeypatch):
    monkeypatch.setenv("DEFAULT_STT_PROVIDER", "parakeet")
    monkeypatch.setenv("DEFAULT_STT_WS_URL", "ws://localhost:5555/stream")
    monkeypatch.setenv("DEFAULT_STT_PARAKEET_WS_URL", "ws://localhost:5092/stream")
    monkeypatch.setenv("DEFAULT_STT_WHISPER_WS_URL", "ws://localhost:43001/stream")
    monkeypatch.setenv("DEFAULT_STT_HTTP_URL", "http://localhost:5092/v1/audio/transcriptions")
    monkeypatch.delenv("DEFAULT_STT_WHISPER_HTTP_URL", raising=False)
    monkeypatch.setenv(
        "DEFAULT_STT_PARAKEET_HTTP_URL",
        "http://localhost:5092/v1/audio/transcriptions",
    )
    monkeypatch.setenv("STT_STORE_AUDIO_DEFAULT", "1")
    monkeypatch.setenv("STT_LOCAL_ONLY", "true")
    monkeypatch.setenv(
        "STT_M5_HTTP_URL",
        "https://m5.example.test/v1/audio/transcriptions",
    )
    monkeypatch.setenv("STT_ASUS_HTTP_URL", "http://asus.example.test/api/transcribe")
    defaults = get_env_stt_defaults()

    assert defaults["provider"] == "parakeet"
    assert defaults["ws_url"] == "ws://localhost:5092/stream"
    assert defaults["provider_urls"]["parakeet"] == "ws://localhost:5092/stream"
    assert defaults["provider_urls"]["whisper"] == "ws://localhost:43001/stream"
    assert defaults["provider_http_urls"]["parakeet"] == "http://localhost:5092/v1/audio/transcriptions"
    assert defaults["provider_http_urls"]["whisper"] == "http://100.81.65.74:7777/api/transcribe"
    assert defaults["http_url"] == "http://localhost:5092/v1/audio/transcriptions"
    assert defaults["store_audio"] is True
    assert defaults["local_only"] is True
    assert defaults["live_fallback_priority"] == DEFAULT_STT_LIVE_FALLBACK_PRIORITY
    assert [authority["id"] for authority in defaults["local_authorities"]] == [
        "m5",
        "asus",
    ]
    assert defaults["local_authorities"][0]["http_url"] == (
        "https://m5.example.test/v1/audio/transcriptions"
    )
    assert defaults["local_authorities"][1]["http_url"] == (
        "http://asus.example.test/api/transcribe"
    )


def test_merge_overrides_converts_booleans_and_preserves_provider_map():
    overrides = {
        "store_audio": "1",
        "local_only": "0",
        "provider": "senko",
        "provider_urls": {
            "senko": "ws://127.0.0.1:3211/stream",
            "parakeet": "ws://127.0.0.1:5092/stream",
        },
        "provider_http_urls": {
            "senko": "http://127.0.0.1:3211/v1/audio/transcriptions",
            "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
        },
        "external_fallback_ws_url": "wss://example.com/stt",
    }
    merged = merge_stt_config(overrides)

    assert merged["store_audio"] is True
    assert merged["local_only"] is False
    assert merged["provider"] == "senko"
    assert merged["provider_urls"]["senko"] == "ws://127.0.0.1:3211/stream"
    assert merged["provider_urls"]["parakeet"] == "ws://127.0.0.1:5092/stream"
    assert merged["provider_http_urls"]["senko"] == "http://127.0.0.1:3211/v1/audio/transcriptions"
    assert merged["provider_http_urls"]["parakeet"] == "http://127.0.0.1:5092/v1/audio/transcriptions"
    assert merged["ws_url"] == "ws://127.0.0.1:3211/stream"
    assert merged["http_url"] == "http://127.0.0.1:3211/v1/audio/transcriptions"


def test_merge_cannot_replace_environment_authority_or_mint_byok(monkeypatch):
    monkeypatch.setenv(
        "STT_M5_HTTP_URL",
        "https://m5.example.test/v1/audio/transcriptions",
    )
    merged = merge_stt_config(
        {
            "local_authorities": [
                {
                    "id": "spoofed",
                    "enabled": True,
                    "provider": "whisper",
                    "http_url": "https://attacker.example/transcribe",
                }
            ],
            "_validated_stt_byok_provider": "openai_audio",
        }
    )

    assert merged["local_authorities"][0]["id"] == "m5"
    assert merged["local_authorities"][0]["http_url"] == (
        "https://m5.example.test/v1/audio/transcriptions"
    )
    assert "_validated_stt_byok_provider" not in merged


def test_merge_legacy_ws_url_updates_selected_provider_slot():
    overrides = {
        "provider": "whisper",
        "provider_urls": {"whisper": "ws://localhost:43001/stream"},
        "provider_http_urls": {"whisper": "http://localhost:8000/v1/audio/transcriptions"},
        "ws_url": "ws://localhost:45000/stream",
        "http_url": "http://localhost:45000/v1/audio/transcriptions",
    }
    merged = merge_stt_config(overrides)

    assert merged["provider"] == "whisper"
    assert merged["provider_urls"]["whisper"] == "ws://localhost:45000/stream"
    assert merged["provider_http_urls"]["whisper"] == "http://localhost:45000/v1/audio/transcriptions"
    assert merged["ws_url"] == "ws://localhost:45000/stream"
    assert merged["http_url"] == "http://localhost:45000/v1/audio/transcriptions"


def test_cloud_provider_url_normalization_builds_canonical_api_endpoints():
    openai_base = normalize_cloud_provider_base_url(
        "openai_audio",
        "https://api.openai.com/v1/audio/transcriptions",
    )
    openrouter_base = normalize_cloud_provider_base_url(
        "openrouter_audio",
        "https://openrouter.ai/api/v1/chat/completions",
    )

    assert openai_base == "https://api.openai.com"
    assert openrouter_base == "https://openrouter.ai/api"
    assert build_cloud_provider_api_url("openai_audio", openai_base) == (
        "https://api.openai.com/v1/audio/transcriptions"
    )
    assert build_cloud_provider_api_url("openrouter_audio", openrouter_base) == (
        "https://openrouter.ai/api/v1/chat/completions"
    )


def test_sanitize_stt_config_for_client_masks_cloud_api_keys():
    sanitized = sanitize_stt_config_for_client(
        {
            "provider": "whisper",
            "cloud_fallback_providers": {
                "openai_audio": {
                    "id": "openai_audio",
                    "name": "OpenAI Audio",
                    "enabled": True,
                    "base_url": "https://api.openai.com/v1/audio/transcriptions",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                },
                "openrouter_audio": {
                    "id": "openrouter_audio",
                    "name": "OpenRouter Audio",
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api/v1/chat/completions",
                    "model": "google/gemini-2.5-flash",
                    "api_key": "or-secret",
                },
            },
        }
    )

    openai_provider = sanitized["cloud_fallback_providers"]["openai_audio"]
    openrouter_provider = sanitized["cloud_fallback_providers"]["openrouter_audio"]

    assert openai_provider["api_key"] == ""
    assert openai_provider["has_api_key"] is True
    assert openai_provider["base_url"] == "https://api.openai.com"
    assert openai_provider["model"] == "gpt-4o-mini-transcribe"
    assert openai_provider["diarize_model"] == "gpt-4o-transcribe-diarize"
    assert openrouter_provider["api_key"] == ""
    assert openrouter_provider["has_api_key"] is True
    assert openrouter_provider["base_url"] == "https://openrouter.ai/api"

    # download_token must also be masked
    assert sanitized["download_token"] == ""
    assert sanitized["has_download_token"] is False


def test_sanitize_stt_config_for_client_masks_download_token():
    sanitized = sanitize_stt_config_for_client(
        {"provider": "whisper", "download_token": "secret-bearer-token"}
    )
    assert sanitized["download_token"] == ""
    assert sanitized["has_download_token"] is True


def test_normalize_live_fallback_priority_dedupes_and_appends_missing_defaults():
    normalized = normalize_live_fallback_priority([
        "openai_audio",
        "external_http",
        "openai_audio",
        "invalid_route",
    ])

    assert normalized == [
        "openai_audio",
        "external_http",
        "remote_whisper",
        "openrouter_audio",
    ]


def test_merge_overrides_normalizes_live_fallback_priority():
    merged = merge_stt_config(
        {
            "live_fallback_priority": ["openai_audio", "remote_whisper"],
        }
    )

    assert merged["live_fallback_priority"] == [
        "openai_audio",
        "remote_whisper",
        "external_http",
        "openrouter_audio",
    ]

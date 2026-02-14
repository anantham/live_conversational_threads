from lct_python_backend.services.stt_config import (
    get_env_stt_defaults,
    merge_stt_config,
)


def test_env_defaults_respect_auth(monkeypatch):
    monkeypatch.setenv("DEFAULT_STT_PROVIDER", "parakeet")
    monkeypatch.setenv("DEFAULT_STT_WS_URL", "ws://localhost:5555/stream")
    monkeypatch.setenv("DEFAULT_STT_PARAKEET_WS_URL", "ws://localhost:5092/stream")
    monkeypatch.setenv("DEFAULT_STT_WHISPER_WS_URL", "ws://localhost:43001/stream")
    monkeypatch.setenv("DEFAULT_STT_HTTP_URL", "http://localhost:5092/v1/audio/transcriptions")
    monkeypatch.setenv(
        "DEFAULT_STT_PARAKEET_HTTP_URL",
        "http://localhost:5092/v1/audio/transcriptions",
    )
    monkeypatch.setenv("STT_STORE_AUDIO_DEFAULT", "1")
    monkeypatch.setenv("STT_LOCAL_ONLY", "true")
    defaults = get_env_stt_defaults()

    assert defaults["provider"] == "parakeet"
    assert defaults["ws_url"] == "ws://localhost:5092/stream"
    assert defaults["provider_urls"]["parakeet"] == "ws://localhost:5092/stream"
    assert defaults["provider_urls"]["whisper"] == "ws://localhost:43001/stream"
    assert defaults["provider_http_urls"]["parakeet"] == "http://localhost:5092/v1/audio/transcriptions"
    assert defaults["http_url"] == "http://localhost:5092/v1/audio/transcriptions"
    assert defaults["store_audio"] is True
    assert defaults["local_only"] is True


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

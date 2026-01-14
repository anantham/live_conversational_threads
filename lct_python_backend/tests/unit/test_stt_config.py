import os

from lct_python_backend.services.stt_config import (
    get_env_stt_defaults,
    merge_stt_config,
)


def test_env_defaults_respect_auth(monkeypatch):
    monkeypatch.setenv("DEFAULT_STT_PROVIDER", "parakeet")
    monkeypatch.setenv("DEFAULT_STT_WS_URL", "ws://localhost:5555/stream")
    monkeypatch.setenv("STT_STORE_AUDIO_DEFAULT", "1")
    defaults = get_env_stt_defaults()

    assert defaults["provider"] == "parakeet"
    assert defaults["ws_url"] == "ws://localhost:5555/stream"
    assert defaults["store_audio"] is True


def test_merge_overrides_converts_booleans():
    overrides = {
        "store_audio": "true",
        "provider": "whisper",
        "ws_url": "ws://127.0.0.1:43001/stream",
    }
    merged = merge_stt_config(overrides)

    assert merged["store_audio"] is True
    assert merged["provider"] == "whisper"
    assert merged["ws_url"] == "ws://127.0.0.1:43001/stream"

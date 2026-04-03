import asyncio
from unittest.mock import AsyncMock

from lct_python_backend.services import byok_session_store as byok


def setup_function():
    byok._BYOK_SESSIONS.clear()


def test_create_byok_session_returns_opaque_token_and_overlay(monkeypatch):
    monkeypatch.setattr(byok, "validate_byok_api_key", AsyncMock(return_value=None))

    payload = asyncio.run(
        byok.create_byok_session(
            provider="openai_audio",
            api_key="sk-test-secret",
            scopes=["stt_live"],
            ttl_seconds=900,
        )
    )

    assert payload["provider"] == "openai_audio"
    assert payload["scopes"] == ["stt_live"]
    assert payload["byok_session_token"]
    assert "sk-test-secret" not in str(payload)

    resolved = byok.resolve_byok_session(
        payload["byok_session_token"],
        required_scope=byok.BYOK_SCOPE_STT_LIVE,
    )
    assert resolved["provider"] == "openai_audio"
    assert resolved["api_key"] == "sk-test-secret"

    runtime_settings = byok.build_runtime_stt_settings_for_byok(
        {
            "local_only": True,
            "live_cloud_fallback_enabled": False,
            "cloud_fallback_providers": {},
        },
        resolved,
    )
    openai_provider = runtime_settings["cloud_fallback_providers"]["openai_audio"]
    assert runtime_settings["local_only"] is False
    assert runtime_settings["live_cloud_fallback_enabled"] is True
    assert openai_provider["enabled"] is True
    assert openai_provider["api_key"] == "sk-test-secret"

from types import SimpleNamespace

import pytest

from lct_python_backend.services.stt.stt_settings_service import (
    load_stt_settings,
    load_stt_settings_for_client,
    save_stt_settings,
)


LEGACY_MODAL_WHISPER_URL = "https://adityaarpitha--whisperx-server-serve.modal.run/v1/audio/transcriptions"
INDRAS_NET_WHISPER_URL = "http://100.81.65.74:7777/api/transcribe"


class _DummyExecuteResult:
    def __init__(self, setting):
        self._setting = setting

    def scalar_one_or_none(self):
        return self._setting


class _DummySession:
    def __init__(self, setting):
        self._setting = setting
        self.commit_calls = 0
        self.rollback_calls = 0
        self.added = []

    async def execute(self, _statement):
        return _DummyExecuteResult(self._setting)

    async def commit(self):
        self.commit_calls += 1

    async def rollback(self):
        self.rollback_calls += 1

    def add(self, value):
        self.added.append(value)
        self._setting = value


@pytest.mark.asyncio
async def test_load_stt_settings_normalizes_legacy_modal_whisper_override(monkeypatch):
    monkeypatch.setenv("DEFAULT_STT_WHISPER_HTTP_URL", INDRAS_NET_WHISPER_URL)
    setting = SimpleNamespace(
        value={
            "provider": "whisper",
            "provider_http_urls": {"whisper": LEGACY_MODAL_WHISPER_URL},
            "http_url": LEGACY_MODAL_WHISPER_URL,
        },
        updated_at=None,
    )
    session = _DummySession(setting)

    merged = await load_stt_settings(session)

    assert session.commit_calls == 1
    assert session.rollback_calls == 0
    assert setting.value["provider_http_urls"]["whisper"] == INDRAS_NET_WHISPER_URL
    assert setting.value["http_url"] == INDRAS_NET_WHISPER_URL
    assert merged["provider_http_urls"]["whisper"] == INDRAS_NET_WHISPER_URL
    assert merged["http_url"] == INDRAS_NET_WHISPER_URL


@pytest.mark.asyncio
async def test_load_stt_settings_keeps_non_legacy_whisper_override(monkeypatch):
    custom_whisper_url = "http://192.168.0.10:7777/api/transcribe"
    monkeypatch.setenv("DEFAULT_STT_WHISPER_HTTP_URL", INDRAS_NET_WHISPER_URL)
    setting = SimpleNamespace(
        value={
            "provider": "whisper",
            "provider_http_urls": {"whisper": custom_whisper_url},
            "http_url": custom_whisper_url,
        },
        updated_at=None,
    )
    session = _DummySession(setting)

    merged = await load_stt_settings(session)

    assert session.commit_calls == 0
    assert session.rollback_calls == 0
    assert setting.value["provider_http_urls"]["whisper"] == custom_whisper_url
    assert merged["provider_http_urls"]["whisper"] == custom_whisper_url
    assert merged["http_url"] == custom_whisper_url


@pytest.mark.asyncio
async def test_load_stt_settings_uses_defaults_when_db_setting_missing(monkeypatch):
    monkeypatch.setenv("DEFAULT_STT_WHISPER_HTTP_URL", INDRAS_NET_WHISPER_URL)
    session = _DummySession(setting=None)

    merged = await load_stt_settings(session)

    assert session.commit_calls == 0
    assert merged["provider_http_urls"]["whisper"] == INDRAS_NET_WHISPER_URL


@pytest.mark.asyncio
async def test_load_stt_settings_for_client_masks_cloud_api_keys(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "env-openai-secret")
    setting = SimpleNamespace(
        value={
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com/v1/audio/transcriptions",
                    "model": "gpt-4o-transcribe-diarize",
                    "api_key": "db-openai-secret",
                }
            }
        },
        updated_at=None,
    )
    session = _DummySession(setting)

    merged = await load_stt_settings_for_client(session)

    provider = merged["cloud_fallback_providers"]["openai_audio"]
    assert provider["api_key"] == ""
    assert provider["has_api_key"] is True
    assert provider["base_url"] == "https://api.openai.com"
    assert provider["model"] == "gpt-4o-mini-transcribe"
    assert provider["diarize_model"] == "gpt-4o-transcribe-diarize"


@pytest.mark.asyncio
async def test_save_stt_settings_preserves_existing_cloud_api_key_when_blank(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    setting = SimpleNamespace(
        value={
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-transcribe-diarize",
                    "api_key": "db-openai-secret",
                }
            }
        },
        updated_at=None,
    )
    session = _DummySession(setting)

    merged = await save_stt_settings(
        session,
        {
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "",
                }
            }
        },
        include_secrets=True,
    )

    provider = merged["cloud_fallback_providers"]["openai_audio"]
    assert session.commit_calls == 1
    assert provider["api_key"] == "db-openai-secret"
    assert setting.value["cloud_fallback_providers"]["openai_audio"]["api_key"] == "db-openai-secret"
    assert provider["model"] == "gpt-4o-mini-transcribe"
    assert provider["diarize_model"] == "gpt-4o-transcribe-diarize"


@pytest.mark.asyncio
async def test_save_stt_settings_can_clear_cloud_api_key_and_shadow_env_default(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "env-openai-secret")
    session = _DummySession(setting=None)

    merged = await save_stt_settings(
        session,
        {
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "clear_api_key": True,
                }
            }
        },
        include_secrets=True,
    )

    provider = merged["cloud_fallback_providers"]["openai_audio"]
    assert session.commit_calls == 1
    assert provider["api_key"] == ""
    assert session.added[0].value["cloud_fallback_providers"]["openai_audio"]["api_key"] == ""
    assert provider["model"] == "gpt-4o-mini-transcribe"
    assert provider["diarize_model"] == "gpt-4o-transcribe-diarize"

from types import SimpleNamespace

import pytest

from lct_python_backend.services import llm_config


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeSession:
    def __init__(self, existing=None):
        self.existing = existing
        self.added = None
        self.committed = False

    async def execute(self, _statement):
        return _FakeResult(self.existing)

    def add(self, value):
        self.added = value
        self.existing = value

    async def commit(self):
        self.committed = True


def test_build_provider_api_url_normalizes_common_roots():
    assert (
        llm_config.build_provider_api_url(
            "https://openrouter.ai/api/v1",
            "openrouter",
            "chat/completions",
        )
        == "https://openrouter.ai/api/v1/chat/completions"
    )
    assert (
        llm_config.build_provider_api_url(
            "https://api.openai.com/v1",
            "openai",
            "chat/completions",
        )
        == "https://api.openai.com/v1/chat/completions"
    )
    assert (
        llm_config.build_provider_api_url(
            "http://localhost:1234/v1/models",
            "openai_compatible",
            "models",
        )
        == "http://localhost:1234/v1/models"
    )


@pytest.mark.asyncio
async def test_load_llm_providers_masks_api_keys_from_defaults(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-secret")

    config = await llm_config.load_llm_providers(session=None, include_secrets=False)

    openrouter = next(
        provider
        for provider in config["providers"]
        if provider["id"] == "openrouter_gemini"
    )
    assert openrouter["api_key"] == ""
    assert openrouter["has_api_key"] is True
    assert openrouter["base_url"] == "https://openrouter.ai/api"


@pytest.mark.asyncio
async def test_load_llm_providers_inherits_env_secret_for_matching_provider(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-secret")
    existing = SimpleNamespace(
        value={
            "providers": [
                {
                    "id": "openrouter_gemini",
                    "name": "OpenRouter",
                    "type": "openrouter",
                    "base_url": "https://openrouter.ai/api/v1",
                    "model": "google/gemini-2.5-flash",
                    "enabled": True,
                    "timeout_seconds": 60,
                }
            ]
        }
    )

    config = await llm_config.load_llm_providers(_FakeSession(existing), include_secrets=True)

    provider = config["providers"][0]
    assert provider["api_key"] == "env-secret"
    assert provider["base_url"] == "https://openrouter.ai/api"


@pytest.mark.asyncio
async def test_save_llm_providers_preserves_existing_api_key_when_payload_omits_it():
    existing = SimpleNamespace(
        value={
            "providers": [
                {
                    "id": "openai_primary",
                    "name": "OpenAI",
                    "type": "openai",
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4.1-mini",
                    "api_key": "stored-secret",
                    "enabled": True,
                    "timeout_seconds": 60,
                }
            ]
        },
        updated_at=None,
    )
    session = _FakeSession(existing)

    response = await llm_config.save_llm_providers(
        session,
        {
            "providers": [
                {
                    "id": "openai_primary",
                    "name": "OpenAI",
                    "type": "openai",
                    "base_url": "https://api.openai.com/v1",
                    "model": "gpt-4.1-mini",
                    "api_key": "",
                    "has_api_key": True,
                    "enabled": True,
                    "timeout_seconds": 60,
                }
            ]
        },
    )

    stored_provider = existing.value["providers"][0]
    assert stored_provider["api_key"] == "stored-secret"
    assert stored_provider["base_url"] == "https://api.openai.com"
    assert response["providers"][0]["has_api_key"] is True


@pytest.mark.asyncio
async def test_save_llm_providers_can_clear_api_key_and_shadow_env_default(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-secret")
    session = _FakeSession()

    response = await llm_config.save_llm_providers(
        session,
        {
            "providers": [
                {
                    "id": "openrouter_gemini",
                    "name": "OpenRouter",
                    "type": "openrouter",
                    "base_url": "https://openrouter.ai/api/v1",
                    "model": "google/gemini-2.5-flash",
                    "enabled": True,
                    "timeout_seconds": 60,
                    "clear_api_key": True,
                }
            ]
        },
    )

    assert session.added.value["providers"][0]["api_key"] == ""
    assert response["providers"][0]["has_api_key"] is False

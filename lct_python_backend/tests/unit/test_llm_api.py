import pytest
from fastapi import HTTPException

from lct_python_backend import llm_api


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

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
async def test_read_llm_model_options_online_uses_fallback(monkeypatch):
    async def _fake_read_llm_settings(session=None):
        return {"mode": "online", "base_url": "http://localhost:1234"}

    async def _fake_fetch_online_models():
        return []

    monkeypatch.setattr(llm_api, "read_llm_settings", _fake_read_llm_settings)
    monkeypatch.setattr(llm_api, "_fetch_online_gemini_models", _fake_fetch_online_models)

    response = await llm_api.read_llm_model_options(mode="online", session=_FakeSession())
    assert response["mode"] == "online"
    assert response["provider"] == "gemini"
    assert response["source"] == "fallback"
    assert "gemini-3-flash-preview" in response["models"]


@pytest.mark.asyncio
async def test_read_llm_model_options_local_from_api(monkeypatch):
    async def _fake_read_llm_settings(session=None):
        return {"mode": "local", "base_url": "http://100.81.65.74:1234"}

    async def _fake_fetch_local_models(_base_url):
        return ["glm-4.6v-flash", "qwen/qwen3-vl-8b"]

    monkeypatch.setattr(llm_api, "read_llm_settings", _fake_read_llm_settings)
    monkeypatch.setattr(llm_api, "_fetch_local_models", _fake_fetch_local_models)

    response = await llm_api.read_llm_model_options(mode="local", session=_FakeSession())
    assert response["mode"] == "local"
    assert response["provider"] == "local"
    assert response["source"] == "local_api"
    assert response["models"] == ["glm-4.6v-flash", "qwen/qwen3-vl-8b"]


@pytest.mark.asyncio
async def test_update_llm_settings_rejects_invalid_online_model(monkeypatch):
    async def _fake_fetch_online_models():
        return ["gemini-3-flash-preview", "gemini-2.5-flash"]

    monkeypatch.setattr(llm_api, "_fetch_online_gemini_models", _fake_fetch_online_models)

    with pytest.raises(HTTPException) as exc:
        await llm_api.update_llm_settings(
            {"mode": "online", "chat_model": "not-a-valid-model"},
            session=_FakeSession(),
        )

    assert exc.value.status_code == 400
    assert "Invalid online chat_model" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_update_llm_settings_normalizes_online_model(monkeypatch):
    async def _fake_fetch_online_models():
        return ["gemini-2.0-flash"]

    monkeypatch.setattr(llm_api, "_fetch_online_gemini_models", _fake_fetch_online_models)

    session = _FakeSession()
    response = await llm_api.update_llm_settings(
        {"mode": "online", "chat_model": "models/gemini-2.0-flash"},
        session=session,
    )

    assert response["mode"] == "online"
    assert response["chat_model"] == "gemini-2.0-flash"
    assert session.committed is True

"""Tests for the LLM gateway (ADR-030 §D5).

The gateway exposes capability-sensitive substitution policy. Chat
substitutions are accepted with a warning; embedding substitutions are
rejected and the gateway falls through to the next provider. These
tests focus on the embedding-side strict-matching logic and the
capability-driven require_json behaviour for chat — both are the
*new* parts of D5; the underlying chat_with_provider_fallback is
already covered by the existing local_llm_client tests.
"""

from __future__ import annotations

import asyncio

import pytest

from lct_python_backend.services.llm_gateway import (
    Capability,
    LlmGateway,
    _embed_with_provider_fallback,
    _embed_model_for,
    _provider_supports_embed,
    gateway,
)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Capability enum + gateway construction
# ---------------------------------------------------------------------------


def test_capability_enum_values_are_canonical():
    assert Capability.CHAT.value == "chat"
    assert Capability.CHAT_JSON_OBJECT.value == "chat_json_object"
    assert Capability.CHAT_JSON_SCHEMA.value == "chat_json_schema"
    assert Capability.EMBED.value == "embed"


def test_gateway_singleton_returns_same_instance():
    a = gateway()
    b = gateway()
    assert a is b
    assert isinstance(a, LlmGateway)


# ---------------------------------------------------------------------------
# Embed provider helpers
# ---------------------------------------------------------------------------


def test_provider_supports_embed_for_openai_compatible_type():
    assert _provider_supports_embed({"type": "openai_compatible"}) is True
    assert _provider_supports_embed({"type": "openai"}) is True


def test_provider_supports_embed_for_explicit_embedding_model_field():
    assert _provider_supports_embed({"type": "anything", "embedding_model": "x"}) is True


def test_provider_does_not_support_embed_for_openrouter_without_model():
    assert _provider_supports_embed({"type": "openrouter"}) is False


def test_embed_model_resolves_explicit_field_first():
    assert _embed_model_for({"embedding_model": "custom-embed-7b"}) == "custom-embed-7b"


# ---------------------------------------------------------------------------
# Embed strict-match policy via mocked HTTP
# ---------------------------------------------------------------------------


class _FakeAsyncClient:
    """httpx.AsyncClient lookalike that returns the configured response."""

    def __init__(self, status_code, body, *, raises=None):
        self._status = status_code
        self._body = body
        self._raises = raises

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, url, json=None, headers=None):
        if self._raises is not None:
            raise self._raises
        return _FakeResponse(self._status, self._body)


class _FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = ""

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError(
                "boom", request=None, response=type("R", (), {"status_code": self.status_code, "text": ""})()
            )

    def json(self):
        return self._body


def test_embed_falls_through_when_provider_substitutes_model(monkeypatch):
    """Critical D5 invariant: embedding-space mismatch is unrecoverable;
    the gateway must NOT silently accept a substituted model."""

    # First provider responds with a different model than requested.
    # Second provider matches and provides usable vectors.
    responses = [
        _FakeAsyncClient(200, {
            "model": "wrong-model",
            "data": [{"embedding": [0.1] * 1536}],
        }),
        _FakeAsyncClient(200, {
            "model": "expected-model",
            "data": [{"embedding": [0.9] * 1536}],
        }),
    ]
    response_iter = iter(responses)

    def fake_async_client_factory(*_args, **_kwargs):
        return next(response_iter)

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.httpx.AsyncClient",
        fake_async_client_factory,
    )

    providers = [
        {
            "id": "wrong",
            "name": "Wrong",
            "type": "openai_compatible",
            "base_url": "http://wrong.example",
            "embedding_model": "expected-model",
            "model": "expected-model",
            "enabled": True,
            "timeout_seconds": 5,
        },
        {
            "id": "right",
            "name": "Right",
            "type": "openai_compatible",
            "base_url": "http://right.example",
            "embedding_model": "expected-model",
            "model": "expected-model",
            "enabled": True,
            "timeout_seconds": 5,
        },
    ]

    result = _run(
        _embed_with_provider_fallback(
            text="hello",
            providers=providers,
            encoding_format="float",
        )
    )

    assert result.provider_id == "right"
    assert result.model == "expected-model"
    assert result.data == [0.9] * 1536
    assert result.attempt_number == 2


def test_embed_accepts_when_served_model_matches_request(monkeypatch):
    response = _FakeAsyncClient(200, {
        "model": "the-right-model",
        "data": [{"embedding": [0.5] * 4}],
    })
    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.httpx.AsyncClient",
        lambda *a, **k: response,
    )
    providers = [{
        "id": "p1",
        "name": "P1",
        "type": "openai_compatible",
        "base_url": "http://p1.example",
        "embedding_model": "the-right-model",
        "enabled": True,
    }]

    result = _run(_embed_with_provider_fallback(
        text="hello",
        providers=providers,
        encoding_format="float",
    ))

    assert result.data == [0.5] * 4
    assert result.model == "the-right-model"


def test_embed_batch_returns_list_of_vectors(monkeypatch):
    response = _FakeAsyncClient(200, {
        "model": "m",
        "data": [
            {"embedding": [0.1, 0.2]},
            {"embedding": [0.3, 0.4]},
            {"embedding": [0.5, 0.6]},
        ],
    })
    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.httpx.AsyncClient",
        lambda *a, **k: response,
    )
    providers = [{
        "id": "p1", "name": "P1", "type": "openai_compatible",
        "base_url": "http://p1.example", "embedding_model": "m", "enabled": True,
    }]

    result = _run(_embed_with_provider_fallback(
        text=["a", "b", "c"],
        providers=providers,
        encoding_format="float",
    ))

    assert result.data == [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]


def test_embed_falls_through_on_http_error(monkeypatch):
    responses = [
        _FakeAsyncClient(500, {}),
        _FakeAsyncClient(200, {"model": "m", "data": [{"embedding": [1.0]}]}),
    ]
    response_iter = iter(responses)
    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.httpx.AsyncClient",
        lambda *a, **k: next(response_iter),
    )
    providers = [
        {"id": "broken", "name": "B", "type": "openai_compatible",
         "base_url": "http://broken.example", "embedding_model": "m", "enabled": True},
        {"id": "ok", "name": "OK", "type": "openai_compatible",
         "base_url": "http://ok.example", "embedding_model": "m", "enabled": True},
    ]

    result = _run(_embed_with_provider_fallback(
        text="hi",
        providers=providers,
        encoding_format="float",
    ))

    assert result.provider_id == "ok"
    assert result.data == [1.0]


def test_embed_raises_when_all_providers_fail(monkeypatch):
    response = _FakeAsyncClient(500, {})
    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.httpx.AsyncClient",
        lambda *a, **k: response,
    )
    providers = [{"id": "p1", "name": "P1", "type": "openai_compatible",
                  "base_url": "http://p1.example", "embedding_model": "m", "enabled": True}]

    with pytest.raises(RuntimeError, match="All embedding providers failed"):
        _run(_embed_with_provider_fallback(
            text="hi",
            providers=providers,
            encoding_format="float",
        ))


def test_embed_raises_when_no_providers_support_embed():
    providers = [{"id": "p1", "name": "P1", "type": "openrouter",
                  "base_url": "http://p1.example", "enabled": True}]

    with pytest.raises(RuntimeError, match="No enabled embedding providers"):
        _run(_embed_with_provider_fallback(
            text="hi",
            providers=providers,
            encoding_format="float",
        ))


# ---------------------------------------------------------------------------
# Embedding_provider_id removal verified
# ---------------------------------------------------------------------------


def test_get_env_providers_defaults_no_longer_carries_embedding_provider_id():
    """ADR-030 §B4: dead field removed."""
    from lct_python_backend.services.llm_config import get_env_providers_defaults
    defaults = get_env_providers_defaults()
    assert "embedding_provider_id" not in defaults


# ---------------------------------------------------------------------------
# ProviderResult prompt-metadata fields (ADR-030 §D7)
# ---------------------------------------------------------------------------


def test_provider_result_carries_prompt_metadata_when_set():
    from lct_python_backend.services.local_llm_client import ProviderResult
    pr = ProviderResult(
        data={"x": 1},
        provider_id="p",
        provider_name="P",
        model="m",
        base_url="http://p.example",
        provider_type="openai_compatible",
        prompt_name="detect_claims_three_layer",
        prompt_version="v3",
    )
    assert pr.prompt_name == "detect_claims_three_layer"
    assert pr.prompt_version == "v3"


def test_provider_result_prompt_metadata_defaults_to_none_for_back_compat():
    from lct_python_backend.services.local_llm_client import ProviderResult
    pr = ProviderResult(
        data={},
        provider_id="p",
        provider_name="P",
        model="m",
        base_url="http://p.example",
        provider_type="openai_compatible",
    )
    assert pr.prompt_name is None
    assert pr.prompt_version is None


def test_gateway_chat_threads_prompt_metadata_through_to_provider_result(monkeypatch):
    """Gateway.chat must pass prompt_name + prompt_version to the
    underlying fallback so telemetry attribution survives the call."""
    captured = {}

    async def fake_fallback(messages, **kwargs):
        from lct_python_backend.services.local_llm_client import ProviderResult
        captured.update(kwargs)
        return ProviderResult(
            data={"ok": True},
            provider_id="p",
            provider_name="P",
            model="m",
            base_url="http://p.example",
            provider_type="openai_compatible",
            prompt_name=kwargs.get("prompt_name"),
            prompt_version=kwargs.get("prompt_version"),
        )

    monkeypatch.setattr(
        "lct_python_backend.services.llm_gateway.chat_with_provider_fallback",
        fake_fallback,
    )

    g = LlmGateway()
    result = _run(g.chat(
        messages=[{"role": "user", "content": "hi"}],
        capability=Capability.CHAT_JSON_OBJECT,
        prompt_name="detect_claims_three_layer",
        prompt_version="v3",
    ))

    assert captured["prompt_name"] == "detect_claims_three_layer"
    assert captured["prompt_version"] == "v3"
    assert captured["require_json"] is True
    assert result.prompt_name == "detect_claims_three_layer"
    assert result.prompt_version == "v3"

"""Test intent:
- A budgeted request must not silently change reasoning/format on rejection.
- Prior legacy capability failures must not change a strict request.
- Explicit reasoning policy changes invalidate interpretation recovery identity.
Synthetic HTTP transport only; no model, network or transcript is used.
"""
import json

import httpx
import pytest

from lct_python_backend.services import local_llm_client as client
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope


def provider():
    return dict(id='local', model='test-model', type='openai_compatible',
                base_url='http://127.0.0.1:11434', trust_scope='owner_private', context_tokens=12000)


def contract(**kwargs):
    return InferenceEnvelope(system_prompt='Instructions', providers=[provider() | kwargs],
        privacy={'local_llm_ok': True, 'external_llm_ok': False},
        output_tokens=100, headroom_tokens=100,
        count_messages=lambda messages: 30, tokenizer_id='synthetic-v1')


@pytest.mark.parametrize('remembered_unsupported', [False, True])
def test_strict_rejection_never_retries_a_different_contract(monkeypatch, remembered_unsupported):
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        return httpx.Response(400, json={'error': 'unsupported format'})
    original = httpx.Client
    monkeypatch.setattr(client.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handle)))
    monkeypatch.setenv('LCT_LLM_CACHE', '0')
    monkeypatch.setenv('LLM_RETRY_BACKOFF_INITIAL_S', '0')
    monkeypatch.setattr(client, '_JSON_OBJECT_UNSUPPORTED_BASE_URLS',
                        {provider()['base_url']} if remembered_unsupported else set())
    with pytest.raises(RuntimeError, match='HTTP 400'):
        contract(reasoning_effort='none').complete_json('Synthetic source')
    assert len(calls) == 1
    assert calls[0]['reasoning_effort'] == 'none'
    assert calls[0]['response_format'] == {'type': 'json_object'}


def test_reasoning_choice_changes_recovery_identity():
    assert contract(reasoning_effort='none').fingerprint != contract(reasoning_effort='high').fingerprint


def test_transient_retry_keeps_the_strict_payload(monkeypatch):
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            raise httpx.ConnectError('Connection failed', request=request)
        return httpx.Response(400, json={'error': 'unsupported format'})
    original = httpx.Client
    monkeypatch.setattr(client.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handle)))
    monkeypatch.setenv('LCT_LLM_CACHE', '0')
    monkeypatch.setenv('LLM_RETRY_BACKOFF_INITIAL_S', '0.001')
    monkeypatch.setenv('LLM_RETRY_BACKOFF_MAX_ATTEMPTS', '1')
    monkeypatch.setattr(client, '_JSON_OBJECT_UNSUPPORTED_BASE_URLS', set())
    with pytest.raises(RuntimeError, match='HTTP 400'):
        contract(reasoning_effort='none').complete_json('Synthetic source')
    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert calls[1]['reasoning_effort'] == 'none'


def test_legacy_client_keeps_its_existing_format_fallback(monkeypatch):
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return httpx.Response(400, json={'error': 'unsupported format'})
        return httpx.Response(200, json={'model': 'test-model', 'choices': [
            {'message': {'content': '{"ok":true}'}, 'finish_reason': 'stop'}]})
    original = httpx.Client
    monkeypatch.setattr(client.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handle)))
    monkeypatch.setenv('LCT_LLM_CACHE', '0')
    monkeypatch.setattr(client, '_JSON_OBJECT_UNSUPPORTED_BASE_URLS', set())
    result = client.chat_with_provider_fallback_sync(
        messages=[{'role': 'user', 'content': 'Synthetic'}], providers=[provider()])
    assert result.data == {'ok': True}
    assert len(calls) == 2
    assert 'response_format' not in calls[1]


def test_one_counter_cannot_cover_different_reasoning_modes():
    with pytest.raises(ValueError, match='reasoning'):
        InferenceEnvelope(system_prompt='Instructions',
            providers=[provider() | {'reasoning_effort': 'none'},
                       provider() | {'id': 'other', 'reasoning_effort': 'high'}],
            privacy={'local_llm_ok': True, 'external_llm_ok': False},
            output_tokens=100, headroom_tokens=100,
            count_messages=lambda messages: 30, tokenizer_id='synthetic-v1')

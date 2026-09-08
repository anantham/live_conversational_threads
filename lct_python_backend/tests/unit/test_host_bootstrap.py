"""Intent: explicit host config binds capacity/counter/routes without egress.

Off means no dependency/config access. Invalid settings fail closed. Provider
changes after startup reject before model use. Native parity remains separately
covered by measured counter tests, not by this synthetic encoder substitute.
"""
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
import pytest
from lct_python_backend.services.transcript import host_bootstrap as host


@pytest.fixture
def configured(tmp_path, monkeypatch):
    class Counter:
        tokenizer_id = 'synthetic-host-counter'
        def __call__(self, messages):
            return len(json.dumps(messages))
    monkeypatch.setattr(host, '_native_counter', lambda path: Counter())
    config = {'version': 'qwen_ollama_0333_v1', 'context_limits': {'local': 32768},
        'embedding_provider_ids': ['local'], 'tokenizer_path': '/synthetic/tokenizer',
        'budgets': {'output_tokens': 8192}, 'temperature': 0}
    provider = {'id': 'local', 'model': 'qwen3.8:27b-mlx', 'trust_scope': 'owner_private',
        'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
        'embedding_model': 'synthetic-embedding', 'reasoning_effort': 'none'}
    def load(*, settings=None, providers=None):
        path = tmp_path / 'host.json'
        path.write_text(json.dumps(config if settings is None else settings))
        return host.load_host_runtime(session_factory=lambda: None,
            providers=[provider] if providers is None else providers, environ={host.ENV_KEY: str(path)})
    return config, provider, load


def test_off_needs_no_counter_or_providers(monkeypatch):
    def forbidden(*args):
        pytest.fail('off must not load a counter')
    monkeypatch.setattr(host, '_native_counter', forbidden)
    assert host.load_host_runtime(session_factory=None, providers=None, environ={}) is None


def test_valid_host_configuration(configured):
    config, provider, load = configured
    runtime = load()
    assert runtime.context_limits == {'local': 32768}
    assert runtime.embedding_provider_ids == ('local',)
    assert runtime.budgets.output_tokens == 8192
    assert runtime.tokenizer_id == 'synthetic-host-counter'
    config['context_limits']['local'] = 1
    provider['model'] = 'changed'
    assert runtime.context_limits['local'] == 32768
    assert runtime.provider_contracts['local']['model'] == 'qwen3.8:27b-mlx'
    with pytest.raises(ValueError, match='provider changed'):
        runtime.build(providers=[provider])
    with pytest.raises(ValueError, match='provider changed'):
        runtime.build_aggregation(providers=[provider])


@pytest.mark.parametrize('change', [
    {'privacy': {'external_llm_ok': True}}, {'version': 'unknown'},
    {'context_limits': {'local': True}}, {'context_limits': {}},
    {'embedding_provider_ids': ['local', 'local']}, {'embedding_provider_ids': []},
])
def test_invalid_config_rejected(configured, change):
    config, _, load = configured
    with pytest.raises(ValueError):
        load(settings={**config, **change})


@pytest.mark.parametrize('change', [
    {'id': 'other'}, {'trust_scope': 'external'}, {'enabled': False},
    {'model': 'different'}, {'reasoning_effort': 'high'}, {'embedding_model': ''},
])
def test_unverified_provider_rejected(configured, change):
    _, provider, load = configured
    with pytest.raises(ValueError):
        load(providers=[{**provider, **change}])


@pytest.mark.asyncio
async def test_startup_off_does_not_touch_database(monkeypatch):
    monkeypatch.delenv(host.ENV_KEY, raising=False)
    app = SimpleNamespace(state=SimpleNamespace(interleaved_runtime='old'))
    await host.configure_host_runtime(app)
    assert app.state.interleaved_runtime is None


@pytest.mark.asyncio
async def test_startup_installs_configured_runtime(configured, monkeypatch, tmp_path):
    from lct_python_backend import db_session
    from lct_python_backend.services import llm_config
    config, provider, _ = configured
    path = tmp_path / 'startup.json'
    path.write_text(json.dumps(config))
    monkeypatch.setenv(host.ENV_KEY, str(path))
    @asynccontextmanager
    async def sessions():
        yield object()
    async def providers(db, *, include_secrets):
        assert include_secrets is True
        return {'providers': [provider]}
    monkeypatch.setattr(db_session, 'get_sessionmaker', lambda: sessions, raising=False)
    monkeypatch.setattr(llm_config, 'load_llm_providers', providers)
    app = SimpleNamespace(state=SimpleNamespace())
    await host.configure_host_runtime(app)
    assert isinstance(app.state.interleaved_runtime, host.HostRuntime)
    assert app.state.interleaved_runtime.session_factory is sessions
    assert app.state.interleaved_runtime.tokenizer_id == 'synthetic-host-counter'

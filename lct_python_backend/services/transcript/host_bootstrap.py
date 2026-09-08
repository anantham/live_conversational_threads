"""Explicit server-file configuration for the measured local Qwen runtime.

Does not install dependencies, infer capacity, grant consent or contact models.
Deployers must separately verify serving-host parity before setting the env path.
No configuration means no activation; a bad configured file is a startup error.
"""
import copy
import json
import os
from dataclasses import dataclass, field
from importlib.metadata import version
from pathlib import Path

from .interleaved_runtime import InterleavedRuntimeConfig, RuntimeBudgets
from .qwen_message_counter import PinnedQwenMessageCounter

ENV_KEY = 'LCT_INTERLEAVED_RUNTIME_CONFIG'
TOKENIZER_SHA = '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3'
CONTRACT_FIELDS = ('model', 'model_revision', 'type', 'base_url', 'trust_scope',
                   'reasoning_effort', 'embedding_model', 'embedding_model_revision')


@dataclass(frozen=True)
class HostRuntime(InterleavedRuntimeConfig):
    provider_contracts: dict = field(default_factory=dict)

    def _check_providers(self, providers):
        for provider in providers:
            identity = provider.get('id')
            if identity in self.provider_contracts:
                actual = {key: provider.get(key) for key in CONTRACT_FIELDS}
                if actual != self.provider_contracts[identity]:
                    raise ValueError('Configured provider changed; revalidate host runtime before inference')

    def build(self, *, providers, **kwargs):
        self._check_providers(providers)
        return super().build(providers=providers, **kwargs)

    def build_aggregation(self, *, providers, **kwargs):
        self._check_providers(providers)
        return super().build_aggregation(providers=providers, **kwargs)


def _native_counter(path):
    # Import lazily: off hosts must not require or install this engine.
    engine = version('tokenizers')
    if engine != '0.23.0rc0':
        raise ValueError('Verified host counter requires tokenizers==0.23.0rc0; no automatic installation')
    from tokenizers import Tokenizer
    def factory(raw):
        encoder = Tokenizer.from_str(raw)
        return lambda text: encoder.encode(text, add_special_tokens=False).ids
    return PinnedQwenMessageCounter(path=path, expected_sha256=TOKENIZER_SHA,
        tokenizer_factory=factory, engine_id='tokenizers==' + engine,
        model='qwen3.8:27b-mlx', server_version='0.33.3', reasoning_effort='none')


def load_host_runtime(*, session_factory, providers, environ=None):
    env = os.environ if environ is None else environ
    path = env.get(ENV_KEY)
    if not path:
        return None
    raw = Path(path).read_bytes()
    if len(raw) > 16384:
        raise ValueError('Host runtime configuration exceeds 16 KiB')
    config = json.loads(raw)
    required = {'version', 'context_limits', 'embedding_provider_ids', 'tokenizer_path', 'budgets', 'temperature'}
    if not isinstance(config, dict) or set(config) != required or config['version'] != 'qwen_ollama_0333_v1':
        raise ValueError('Unsupported host runtime configuration schema')
    limits, embedding = config['context_limits'], config['embedding_provider_ids']
    if (not isinstance(limits, dict) or not limits or any(
            not isinstance(key, str) or not key.strip() or type(value) is not int or value <= 0
            for key, value in limits.items())):
        raise ValueError('Explicit positive context limits are required')
    if (not isinstance(embedding, list) or not embedding or any(
            not isinstance(key, str) or not key.strip() for key in embedding)
            or len(set(embedding)) != len(embedding)):
        raise ValueError('Explicit distinct embedding provider IDs are required')
    selected = set(limits) | set(embedding)
    routes = [p for p in providers if p.get('id') in selected]
    if len(routes) != len(selected) or {p['id'] for p in routes} != selected:
        raise ValueError('Configured provider IDs must resolve uniquely')
    for provider in routes:
        if provider.get('enabled') is False or provider.get('trust_scope') != 'owner_private':
            raise ValueError('This host counter configuration supports enabled private routes only')
        if provider['id'] in limits and (
                provider.get('model') != 'qwen3.8:27b-mlx'
                or provider.get('type', 'openai_compatible') != 'openai_compatible'
                or provider.get('reasoning_effort', 'none') != 'none'):
            raise ValueError('Provider does not match measured Qwen counter protocol')
        if provider['id'] in embedding and not provider.get('embedding_model'):
            raise ValueError('Configured embedding route needs an explicit model')
    counter = _native_counter(config['tokenizer_path'])
    return HostRuntime(session_factory=session_factory, context_limits=copy.deepcopy(limits),
        embedding_provider_ids=tuple(embedding), budgets=RuntimeBudgets(**config['budgets']),
        temperature=config['temperature'], count_messages=counter, tokenizer_id=counter.tokenizer_id,
        provider_contracts={p['id']: {key: copy.deepcopy(p.get(key)) for key in CONTRACT_FIELDS} for p in routes})


async def configure_host_runtime(app):
    if not os.environ.get(ENV_KEY):
        app.state.interleaved_runtime = None
        return
    from lct_python_backend.db_session import get_sessionmaker
    from lct_python_backend.services.llm_config import load_llm_providers
    sessions = get_sessionmaker()
    async with sessions() as db:
        config = await load_llm_providers(db, include_secrets=True)
    app.state.interleaved_runtime = load_host_runtime(
        session_factory=sessions, providers=config['providers'])

"""One explicit runtime contract for live and imported persisted utterances."""
import pytest
import json
from pathlib import Path

from lct_python_backend.services.transcript.interleaved_runtime import build_interleaved_processor, RuntimeBudgets
from lct_python_backend.services.transcript.interleaved_prompt import INTERLEAVED_SYSTEM_PROMPT


def test_sampling_temperature_is_explicit_and_changes_recovery_identity():
    """Model comparisons must not silently inherit a different sampling policy."""
    from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
    for invalid in (True, '0', float('nan'), -1, 3):
        with pytest.raises(ValueError, match='temperature'):
            InterleavedRuntimeConfig(object(), {}, (), temperature=invalid)
    assert build(temperature=0).interpretation_policy_fingerprint != build(temperature=0.3).interpretation_policy_fingerprint


def test_runtime_sampling_reaches_generation_transport(monkeypatch):
    from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
    calls = []
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync',
                        lambda **kwargs: calls.append(kwargs))
    config = InterleavedRuntimeConfig(object(), {'chat': 32768}, (), temperature=0)
    runner = config.build_aggregation(conversation_id='11111111-1111-4111-8111-111111111111',
        owner_id='owner', providers=[{'id': 'chat', 'model': 'synthetic', 'trust_scope': 'owner_private'}],
        privacy={'local_llm_ok': True})
    runner.envelope.complete_json('{}')
    assert calls[0]['temperature'] == 0


def test_host_counter_reaches_aggregation_and_inspection():
    from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
    measured = []
    def counter(messages):
        measured.append(messages)
        return 40 + sum(len(m['content']) for m in messages)
    config = InterleavedRuntimeConfig(object(), {'chat': 32768}, ('chat',),
        count_messages=counter, tokenizer_id='synthetic-chat-v1')
    scope = dict(conversation_id='11111111-1111-4111-8111-111111111111', owner_id='owner',
        providers=[{'id': 'chat', 'model': 'synthetic', 'embedding_model': 'synthetic-embedding',
                    'trust_scope': 'owner_private'}], privacy={'local_llm_ok': True})
    aggregate = config.build_aggregation(**scope)
    relations = config.build_reconciliation(**scope)
    for envelope in (aggregate.envelope, relations.envelope, relations.inspection.envelope):
        result = envelope.validate('sample')
        assert measured[-1][-1] == {'role': 'user', 'content': 'sample'}
        assert result == 40 + sum(len(m['content']) for m in measured[-1])
        assert envelope.tokenizer_id == 'synthetic-chat-v1'


def build(**overrides):
    args = dict(conversation_id="11111111-1111-4111-8111-111111111111", owner_id="owner",
                session_factory=object(), send_update=None,
                providers=[{"id": "chat", "model": "m", "trust_scope": "owner_private", "context_tokens": 32768}],
                embedding_providers=[{"id": "embed", "embedding_model": "e", "trust_scope": "owner_private"}],
                privacy={"local_llm_ok": True}, budgets=RuntimeBudgets(), system_prompt="test instructions")
    args.update(overrides)
    return build_interleaved_processor(**args)


def test_factory_composes_shared_policy_and_recovery_identity():
    processor = build()
    assert processor._passage_context_policy.passage_target_tokens == 4096
    assert processor._semantic_candidates is not None
    assert processor._inference_envelope is not None
    assert len(processor.interpretation_policy_fingerprint) == 64
    assert build().interpretation_policy_fingerprint == processor.interpretation_policy_fingerprint
    assert build(budgets=RuntimeBudgets(passage_target_tokens=2048)).interpretation_policy_fingerprint != processor.interpretation_policy_fingerprint
    assert build(system_prompt="changed instructions").interpretation_policy_fingerprint != processor.interpretation_policy_fingerprint


def test_hosted_raw_source_is_rejected_before_processor_creation(monkeypatch):
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    with pytest.raises(ValueError, match="retention"):
        build()


def test_no_implicit_embedding_cloud_fallback():
    with pytest.raises(ValueError, match="No enabled LLM provider"):
        build(embedding_providers=[{"id": "cloud", "embedding_model": "e", "trust_scope": "external"}])


def test_capacity_and_owner_are_required():
    with pytest.raises(ValueError):
        build(owner_id="")
    with pytest.raises(ValueError, match="context_tokens"):
        build(providers=[{"id": "chat", "model": "m", "trust_scope": "owner_private"}])


def test_registered_prompt_matches_bootstrap_contract():
    path = Path(__file__).resolve().parents[2] / "prompts.json"
    config = json.loads(path.read_text())["prompts"]["interpret_interleaved_conversation"]
    assert config["template"] == INTERLEAVED_SYSTEM_PROMPT
    from lct_python_backend.services.transcript.source_backed_aggregation import AGGREGATION_SYSTEM_PROMPT
    aggregation = json.loads(path.read_text())["prompts"]["aggregate_source_backed_conversation"]
    assert aggregation["template"] == AGGREGATION_SYSTEM_PROMPT


def test_embedding_identity_and_tokenizer_change_recovery_fingerprint():
    original = build().interpretation_policy_fingerprint
    changed = [{"id": "embed", "embedding_model": "different", "trust_scope": "owner_private"}]
    assert build(embedding_providers=changed).interpretation_policy_fingerprint != original
    with pytest.raises(ValueError, match="tokenizer_id"):
        build(count_tokens=len)
    assert build(count_tokens=len, tokenizer_id="synthetic_character_counter_v1").interpretation_policy_fingerprint != original


def test_aggregation_factory_keeps_private_source_off_external_routes(monkeypatch):
    from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
    config = InterleavedRuntimeConfig(session_factory=object(),
        context_limits={"local": 32768, "cloud": 32768}, embedding_provider_ids=())
    providers = [{"id": "local", "model": "synthetic", "trust_scope": "owner_private"},
                 {"id": "cloud", "model": "synthetic", "trust_scope": "external"}]
    kwargs = dict(conversation_id="11111111-1111-4111-8111-111111111111", owner_id="owner",
                  providers=providers, privacy={"local_llm_ok": True, "external_llm_ok": False})
    runner = config.build_aggregation(**kwargs)
    assert [p["id"] for p in runner.envelope.providers] == ["local"]
    with pytest.raises(ValueError, match="No enabled LLM provider"):
        config.build_aggregation(**{**kwargs, "providers": providers[1:]})
    with pytest.raises(ValueError, match="No enabled LLM provider"):
        config.build_aggregation(**{**kwargs, "privacy": {}})
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    with pytest.raises(ValueError, match="retention"):
        config.build_aggregation(**kwargs)

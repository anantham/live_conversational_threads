"""Budget/privacy contract: test the complete request and all allowed fallbacks."""
import pytest
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded
from lct_python_backend.services.transcript.conversation_context import PassageContextPolicy
from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError


def provider(identity="local", capacity=12000, trust="owner_private"):
    return {"id": identity, "model": "configured-model", "base_url": "http://127.0.0.1:11434",
            "type": "openai_compatible", "trust_scope": trust, "enabled": True,
            "context_tokens": capacity}


def envelope(providers=None, **kwargs):
    return InferenceEnvelope(system_prompt="Exact instructions", providers=providers or [provider()],
                             privacy={"local_llm_ok": True, "external_llm_ok": False},
                             output_tokens=2000, headroom_tokens=512, **kwargs)


def test_reserves_system_output_and_framing_for_smallest_allowed_fallback():
    contract = envelope([provider(), provider("fallback", 8000)])
    assert 0 < contract.input_token_budget < 8000 - 2000 - 512
    assert contract.validate("source") + 2000 + 512 <= 8000


def test_unknown_capacity_is_not_guessed_from_model_alias():
    with pytest.raises(ValueError, match="context_tokens"):
        envelope([provider(capacity=None)])


def test_forbidden_external_fallback_never_participates_or_receives_content():
    contract = envelope([provider(), provider("external", 20, "external")])
    assert [p["id"] for p in contract.providers] == ["local"]


def test_missing_consent_fails_closed():
    with pytest.raises(DeploymentPrivacyError):
        InferenceEnvelope(system_prompt="Instructions", providers=[provider()], privacy={},
                          output_tokens=2000, headroom_tokens=512)


def test_overflow_rejected_before_any_model_call(monkeypatch):
    contract = envelope()
    monkeypatch.setattr("lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync",
                        lambda **kw: pytest.fail("Must not send overflowing input"))
    with pytest.raises(ContextBudgetExceeded):
        contract.generate("x" * 12000)


def test_request_uses_the_exact_budgeted_prompt_and_frozen_routing(monkeypatch):
    providers = [provider()]
    contract = envelope(providers)
    providers[0]["model"] = "mutated-model"
    captured = {}
    class Result:
        data = [{"node_name": "A node", "summary": "Meaning"}]
        def backend_label(self):
            return "local_test"
    def call(**kwargs):
        captured.update(kwargs)
        return Result()
    monkeypatch.setattr("lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync", call)
    contract.generate("source", providers=[provider("forbidden", trust="external")])
    assert captured["providers"][0]["model"] == "configured-model"
    assert captured["messages"] == [{"role": "system", "content": "Exact instructions"},
                                    {"role": "user", "content": "source"}]
    assert captured["max_tokens"] == 2000


@pytest.mark.asyncio
async def test_shared_processor_uses_same_envelope_for_planning_and_request(monkeypatch):
    requests = []
    class Result:
        data = [{"node_name": "Question", "summary": "Still open", "semantic_level": 1}]
        def backend_label(self):
            return "local_test"
    def call(**kwargs):
        requests.append(kwargs)
        return Result()
    monkeypatch.setattr("lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync", call)
    monkeypatch.setattr("lct_python_backend.services.transcript.transcript_processing.generate_lct_json",
                        lambda *a, **kw: pytest.fail("Must use the frozen envelope"))
    contract = envelope()
    processor = TranscriptProcessor(send_update=None, inference_envelope=contract,
                                    graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0)
    await processor.handle_final_text("An unfinished question.", utterance_id="u-1")
    assert len(requests) == 1
    assert requests[0]["messages"][0]["content"] == "Exact instructions"
    assert processor._passage_context_policy.input_token_budget == contract.input_token_budget


def test_processor_rejects_planner_larger_than_request_budget():
    with pytest.raises(ValueError, match="budget"):
        TranscriptProcessor(send_update=None, inference_envelope=envelope(),
                            passage_context_policy=PassageContextPolicy(999999))


def test_transport_deadline_change_preserves_interpretation_identity_and_budget():
    """A longer wait can resume receipts without changing model or input semantics."""
    short = envelope([{**provider(), "timeout_seconds": 240}])
    longer = envelope([{**provider(), "timeout_seconds": 600}])
    assert short.fingerprint == longer.fingerprint
    assert short.validate("same source") == longer.validate("same source")
    assert longer.providers[0]["timeout_seconds"] == 600


def test_new_task_instructions_preserve_routes_and_budget_contract():
    original = envelope()
    derived = original.with_system_prompt('Select supporting source IDs only.')
    assert derived.providers == original.providers
    assert derived.count_tokens is original.count_tokens
    assert derived.fingerprint != original.fingerprint
    assert derived.validate('source') + 2512 <= 12000


def test_planner_budget_includes_escaping_inside_message_envelope():
    """A packed JSON user message must still fit its outer message encoding."""
    from lct_python_backend.services.transcript.conversation_context import plan_conversation_context
    contract = envelope()
    chunks = {str(i): 'A quoted "callback" with \\ paths. ' * 4 for i in range(100)}
    plan = plan_conversation_context('Returning to the callback.', [], chunks, {}, contract.context_policy())
    contract.validate(plan.prompt)

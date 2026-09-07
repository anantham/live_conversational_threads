"""Compose the same explicit interpretation/recovery policy for every entry point.

Call only after source utterances have been committed with stable IDs. This
factory does not authorize a conversation or reinterpret an existing legacy
graph; the owner-scoped journal checks those boundaries on first recovery.
"""
from dataclasses import asdict, dataclass
import hashlib
import json
import uuid

from lct_python_backend.services.deployment_privacy_policy import assert_raw_transcript_retention_allowed
from .conversation_context import conservative_tokens
from .inference_envelope import InferenceEnvelope
from .passage_runtime import PassageJournalSession
from .semantic_candidates import SemanticCandidates
from .transcript_processing import TranscriptProcessor
from .transcript_prompts import get_transcript_prompt_text, PROMPT_ID_INTERLEAVED_CONVERSATION, PROMPT_ID_SOURCE_AGGREGATION


@dataclass(frozen=True)
class RuntimeBudgets:
    output_tokens: int = 4096
    headroom_tokens: int = 512
    passage_target_tokens: int = 4096
    embedding_input_tokens: int = 8192
    embedding_batch_tokens: int = 32768

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in asdict(self).values()):
            raise ValueError("Runtime budgets require positive integers")


@dataclass(frozen=True)
class InterleavedRuntimeConfig:
    """Trusted host configuration, never populated from transcript/request text."""
    session_factory: object
    context_limits: dict
    embedding_provider_ids: tuple[str, ...]
    budgets: RuntimeBudgets = RuntimeBudgets()

    def build_aggregation(self, *, conversation_id, owner_id, providers, privacy):
        """Compose an unactivated runner under the existing consent envelope.

        No network calls or deployment occur here. InferenceEnvelope again
        filters the caller's already-narrowed providers: external_llm_ok=False
        excludes every external route, and missing consent fails closed.
        """
        from .aggregation_runner import AggregationRunner
        uuid.UUID(conversation_id)
        if not isinstance(owner_id, str) or not owner_id.strip() or self.session_factory is None:
            raise ValueError("Owner and durable session factory are required")
        if not isinstance(privacy, dict) or privacy.get("redaction_applied") is not True:
            assert_raw_transcript_retention_allowed()
        chat = [{**p, "context_tokens": self.context_limits[p["id"]]}
                for p in providers if p.get("id") in self.context_limits]
        envelope = InferenceEnvelope(
            system_prompt=get_transcript_prompt_text(PROMPT_ID_SOURCE_AGGREGATION),
            providers=chat, privacy=privacy, output_tokens=self.budgets.output_tokens,
            headroom_tokens=self.budgets.headroom_tokens,
        )
        return AggregationRunner(session_factory=self.session_factory, conversation_id=conversation_id,
                                 owner_id=owner_id, envelope=envelope)

    def build(self, *, providers, **kwargs):
        chat = [{**p, "context_tokens": self.context_limits[p["id"]]}
                for p in providers if p.get("id") in self.context_limits]
        embedding = [p for p in providers if p.get("id") in self.embedding_provider_ids]
        return build_interleaved_processor(
            session_factory=self.session_factory, providers=chat, embedding_providers=embedding,
            budgets=self.budgets, **kwargs,
        )


def build_interleaved_processor(*, conversation_id, owner_id, session_factory,
                                providers, embedding_providers, privacy, send_update,
                                send_status=None, budgets=RuntimeBudgets(), system_prompt=None,
                                count_tokens=conservative_tokens, tokenizer_id="utf8_bytes_v1"):
    uuid.UUID(conversation_id)
    if not isinstance(owner_id, str) or not owner_id.strip() or session_factory is None:
        raise ValueError("Owner and durable session factory are required")
    if not isinstance(privacy, dict) or privacy.get("redaction_applied") is not True:
        assert_raw_transcript_retention_allowed()
    if not tokenizer_id or (count_tokens is not conservative_tokens and tokenizer_id == "utf8_bytes_v1"):
        raise ValueError("Custom token counters require an explicit versioned tokenizer_id")
    prompt = system_prompt if system_prompt is not None else get_transcript_prompt_text(PROMPT_ID_INTERLEAVED_CONVERSATION)
    envelope = InferenceEnvelope(
        system_prompt=prompt, providers=providers, privacy=privacy,
        output_tokens=budgets.output_tokens, headroom_tokens=budgets.headroom_tokens,
        count_tokens=count_tokens,
    )
    context = envelope.context_policy(passage_target_tokens=budgets.passage_target_tokens)
    retrieval = SemanticCandidates(
        providers=embedding_providers, privacy=privacy,
        input_token_budget=budgets.embedding_input_tokens,
        batch_token_budget=budgets.embedding_batch_tokens, count_tokens=count_tokens,
    )
    identity = {"version": "interleaved_runtime_v1", "inference": envelope.fingerprint,
                "retrieval": retrieval.fingerprint, "budgets": asdict(budgets), "tokenizer_id": tokenizer_id}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    journal = PassageJournalSession(session_factory=session_factory, conversation_id=conversation_id,
                                    owner_id=owner_id, policy_fingerprint=fingerprint)
    processor = TranscriptProcessor(
        send_update=send_update, send_status=send_status,
        inference_envelope=envelope, passage_context_policy=context,
        passage_journal=journal, semantic_candidates=retrieval,
    )
    processor.interpretation_policy_fingerprint = fingerprint
    return processor

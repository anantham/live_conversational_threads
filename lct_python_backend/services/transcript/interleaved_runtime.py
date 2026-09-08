"""Compose the same explicit interpretation/recovery policy for every entry point.

Call only after source utterances have been committed with stable IDs. This
factory does not authorize a conversation or reinterpret an existing legacy
graph; the owner-scoped journal checks those boundaries on first recovery.
"""
from dataclasses import asdict, dataclass
import hashlib
import json
import math
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
    temperature: float = 0.3
    count_tokens: object = conservative_tokens
    count_messages: object = None
    tokenizer_id: str = 'utf8_bytes_v1'

    def __post_init__(self):
        if type(self.temperature) not in (int, float) or not math.isfinite(self.temperature) or not 0 <= self.temperature <= 2:
            raise ValueError('Explicit sampling temperature must be finite and between 0 and 2')
        if not self.tokenizer_id or ((self.count_tokens is not conservative_tokens or self.count_messages is not None)
                                     and self.tokenizer_id == 'utf8_bytes_v1'):
            raise ValueError('Custom counters require an explicit tokenizer identity')

    def build_reconciliation(self, *, conversation_id, owner_id, providers, privacy):
        """Use the same owner, frozen routes and budgets for post-passage review."""
        from .reconciliation_runner import ReconciliationRunner
        from .source_inspection import INSPECTION_PROMPT
        from .inspection_relations import RELATION_PROMPT
        base = self.build_aggregation(conversation_id=conversation_id, owner_id=owner_id,
                                      providers=providers, privacy=privacy).envelope
        retrieval = SemanticCandidates(
            providers=[p for p in providers if p.get('id') in self.embedding_provider_ids],
            privacy=privacy, input_token_budget=self.budgets.embedding_input_tokens,
            batch_token_budget=self.budgets.embedding_batch_tokens)
        return ReconciliationRunner(session_factory=self.session_factory,
            conversation_id=conversation_id, owner_id=owner_id,
            inspection_envelope=base.with_system_prompt(INSPECTION_PROMPT),
            review_envelope=base.with_system_prompt(RELATION_PROMPT), retriever=retrieval)

    def build_question_review(self, *, conversation_id, owner_id, providers, privacy):
        """Use the same frozen routes, budget and tokenizer for question review."""
        from .question_review_runner import QuestionReviewRunner
        base = self.build_aggregation(conversation_id=conversation_id, owner_id=owner_id,
                                      providers=providers, privacy=privacy).envelope
        return QuestionReviewRunner(session_factory=self.session_factory,
            conversation_id=conversation_id, owner_id=owner_id, envelope=base)

    def build_thread_identity(self, *, conversation_id, owner_id, providers, privacy):
        from .thread_identity_runner import ThreadIdentityRunner
        from .thread_identity_context import CANDIDATE_POLICY
        base = self.build_aggregation(conversation_id=conversation_id, owner_id=owner_id,
                                      providers=providers, privacy=privacy).envelope
        return ThreadIdentityRunner(session_factory=self.session_factory,
            conversation_id=conversation_id, owner_id=owner_id, envelope=base,
            candidate_policy_id=CANDIDATE_POLICY)

    def build_aggregation(self, *, conversation_id, owner_id, providers, privacy):
        """Compose an unactivated runner under the existing consent envelope.

        No network calls or deployment occur here. InferenceEnvelope again
        filters the caller's already-narrowed providers: external_llm_ok=False
        excludes every external route, and missing consent fails closed.
        """
        from .bounded_aggregation_runner import BoundedAggregationRunner
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
            temperature=self.temperature,
            count_tokens=self.count_tokens, count_messages=self.count_messages,
            tokenizer_id=self.tokenizer_id,
        )
        from .thread_identity_runner import ThreadIdentityRunner, export_thread_identity_reviews
        from .thread_identity_context import CANDIDATE_POLICY
        identity_runner = ThreadIdentityRunner(session_factory=self.session_factory,
            conversation_id=conversation_id, owner_id=owner_id, envelope=envelope,
            candidate_policy_id=CANDIDATE_POLICY)
        async def identity_reviews(db):
            return await export_thread_identity_reviews(db, conversation_id=conversation_id, owner_id=owner_id)
        return BoundedAggregationRunner(session_factory=self.session_factory, conversation_id=conversation_id,
            owner_id=owner_id, envelope=envelope, identity_review_loader=identity_reviews,
            identity_policy_fingerprint=identity_runner.fingerprint)

    def build(self, *, providers, **kwargs):
        chat = [{**p, "context_tokens": self.context_limits[p["id"]]}
                for p in providers if p.get("id") in self.context_limits]
        embedding = [p for p in providers if p.get("id") in self.embedding_provider_ids]
        return build_interleaved_processor(
            session_factory=self.session_factory, providers=chat, embedding_providers=embedding,
            budgets=self.budgets, temperature=self.temperature,
            count_tokens=self.count_tokens, count_messages=self.count_messages,
            tokenizer_id=self.tokenizer_id, **kwargs,
        )


def build_interleaved_processor(*, conversation_id, owner_id, session_factory,
                                providers, embedding_providers, privacy, send_update,
                                send_status=None, budgets=RuntimeBudgets(), system_prompt=None,
                                count_tokens=conservative_tokens, tokenizer_id="utf8_bytes_v1", temperature=0.3,
                                count_messages=None):
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
        count_messages=count_messages, tokenizer_id=tokenizer_id,
        temperature=temperature,
        require_leaf_sources=True,
    )
    context = envelope.context_policy(passage_target_tokens=budgets.passage_target_tokens)
    retrieval = SemanticCandidates(
        providers=embedding_providers, privacy=privacy,
        input_token_budget=budgets.embedding_input_tokens,
        # The chat tokenizer is not the embedding model's tokenizer.
        batch_token_budget=budgets.embedding_batch_tokens, count_tokens=conservative_tokens,
    )
    from .question_review_runner import QuestionReviewRunner
    from .question_context import QuestionContextReader
    question_runner = QuestionReviewRunner(session_factory=session_factory,
        conversation_id=conversation_id, owner_id=owner_id, envelope=envelope)
    from .thread_identity_runner import ThreadIdentityRunner
    from .thread_identity_context import ThreadIdentityContextReader, CANDIDATE_POLICY
    identity_runner = ThreadIdentityRunner(session_factory=session_factory,
        conversation_id=conversation_id, owner_id=owner_id, envelope=envelope,
        candidate_policy_id=CANDIDATE_POLICY)
    identity = {"version": "interleaved_runtime_v8_leaf_sources", "inference": envelope.fingerprint,
                "thread_identity": identity_runner.fingerprint,
                "question_review": question_runner.envelope.fingerprint,
                "retrieval": retrieval.fingerprint, "budgets": asdict(budgets), "tokenizer_id": tokenizer_id}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    journal = PassageJournalSession(session_factory=session_factory, conversation_id=conversation_id,
                                    owner_id=owner_id, policy_fingerprint=fingerprint,
                                    inference_providers=[*envelope.providers, *retrieval.providers])
    question_context = QuestionContextReader(question_runner)
    processor = TranscriptProcessor(
        send_update=send_update, send_status=send_status,
        inference_envelope=envelope, passage_context_policy=context,
        passage_journal=journal, semantic_candidates=retrieval,
        inference_guard=journal.check_consent,
        question_review_loader=question_context,
        thread_identity_loader=ThreadIdentityContextReader(identity_runner),
    )
    processor.interpretation_policy_fingerprint = fingerprint
    return processor

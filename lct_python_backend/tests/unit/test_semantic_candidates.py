"""Semantic candidates must remain source-bound, private and non-authoritative."""
import asyncio
import json

import pytest

from lct_python_backend.services.transcript.semantic_candidates import SemanticCandidates
from lct_python_backend.services.transcript.conversation_context import PassageContextPolicy, plan_conversation_context


PROVIDER = {"id": "local", "embedding_model": "embed", "trust_scope": "owner_private"}


def test_candidates_are_ranked_over_only_supplied_sources_and_no_global_cache():
    calls = []

    async def embed(texts, **kwargs):
        calls.append((texts, kwargs))
        return [[0., 1.] if text == "lunch" else [1., 0.] for text in texts]

    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=embed)
    scores = asyncio.run(retriever.rank("pay the server bill", {"old": "unresolved funding", "new": "lunch"}))
    assert scores["old"] > scores["new"]
    assert calls[0][1]["providers"][0]["strict_embedding_response"] is True
    assert calls[0][0][:2] == ["unresolved funding", "lunch"]
    asyncio.run(retriever.rank("pay the server bill", {"old": "corrected funding", "new": "lunch"}))
    assert calls[1][0][0] == "corrected funding"
    assert "lunch" not in calls[1][0]


def test_incremental_reuse_prunes_removed_sources_and_is_instance_local():
    calls = []
    async def embed(texts, **kwargs):
        calls.append(list(texts))
        return [[1., 0.] for _ in texts]
    def make():
        return SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=embed)
    retriever = make()
    asyncio.run(retriever.rank("q1", {"a": "first", "b": "second"}))
    asyncio.run(retriever.rank("q2", {"a": "first", "b": "second", "c": "third"}))
    assert calls[-1][:-1] == ["third"]
    asyncio.run(retriever.rank("q3", {"a": "first"}))
    asyncio.run(retriever.rank("q4", {"b": "second"}))
    assert calls[-1][0] == "second"
    asyncio.run(make().rank("q5", {"b": "second"}))
    assert calls[-1][0] == "second"


def test_embedding_windows_preserve_all_source_and_enforce_input_and_batch_budgets():
    """Long sources/queries must fit without dropping tails or authoring new IDs."""
    calls = []
    async def embed(texts, **kwargs):
        calls.append(texts)
        return [[1., 0.] for _ in texts]
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=embed,
                                   input_token_budget=200, batch_token_budget=300)
    from lct_python_backend.services.transcript.semantic_candidates import QUERY_PREFIX
    source = "é🪷" * 100
    scores = asyncio.run(retriever.rank("callback " * 80, {"b": source}))
    sent = [text for batch in calls for text in batch]
    assert ''.join(t for t in sent if not t.startswith(QUERY_PREFIX)) == source
    assert ''.join(t[len(QUERY_PREFIX):] for t in sent if t.startswith(QUERY_PREFIX)) == "callback " * 80
    assert set(scores) == {"b"}
    assert all(len(text.encode()) <= 200 for text in sent)
    asyncio.run(retriever.rank("q", {"a": "a" * 180, "b": "b" * 180, "c": "c" * 180}))
    assert all(sum(len(text.encode()) for text in batch) <= 300 for batch in calls)


def test_impossible_query_prefix_fails_before_any_embedding_call():
    calls = []
    async def embed(texts, **kwargs):
        calls.append(texts)
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True},
                                   embed_batch=embed, input_token_budget=2, batch_token_budget=2)
    with pytest.raises(ValueError, match="budget"):
        asyncio.run(retriever.rank("q", {"a": "x"}))
    assert not calls


def test_long_passage_tail_callback_survives_windowing_and_cached_reuse():
    calls = []
    async def embed(texts, **kwargs):
        calls.extend(texts)
        return [[1., 0.] if 'funding' in t else [0., 1.] for t in texts]
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True},
                                   embed_batch=embed, input_token_budget=200, batch_token_budget=300)
    source = 'garden ' * 70 + 'funding'
    scores = asyncio.run(retriever.rank('funding', {'old': source, 'other': 'lunch'}))
    assert scores['old'] > scores['other']
    calls.clear()
    again = asyncio.run(retriever.rank('funding', {'old': source, 'other': 'lunch'}))
    assert again == scores
    assert len(calls) == 1, 'Unchanged source windows should not be embedded again'


def test_revocation_between_embedding_batches_stops_calls_and_discards_partial_cache():
    """A long retrieval must not retain initial consent for all its batches."""
    calls, allowed, revoke = [], True, True
    async def guard():
        if not allowed:
            raise PermissionError('Synthetic consent revoked')
    async def embed(texts, **kwargs):
        nonlocal allowed
        calls.append(list(texts))
        if revoke:
            allowed = False
        return [[1., 0.] for _ in texts]
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={'local_llm_ok': True}, embed_batch=embed,
                                   input_token_budget=200, batch_token_budget=300)
    sources = {'a': 'a' * 180, 'b': 'b' * 180, 'c': 'c' * 180}
    with pytest.raises(PermissionError, match='consent revoked'):
        asyncio.run(retriever.rank('q', sources, request_guard=guard))
    assert len(calls) == 1
    allowed, revoke = True, False
    scores = asyncio.run(retriever.rank('q', sources, request_guard=guard))
    assert set(scores) == set(sources)
    assert calls[1] == calls[0], 'Failed retrieval must not publish a partial embedding cache'


def test_dimension_drift_against_cached_sources_fails_without_installing_bad_vectors():
    dimension = 2
    async def embed(texts, **kwargs):
        return [[1.] * dimension for _ in texts]
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=embed)
    asyncio.run(retriever.rank("q", {"a": "first"}))
    dimension = 3
    with pytest.raises(ValueError, match="dimension"):
        asyncio.run(retriever.rank("q2", {"a": "first", "b": "second"}))
    dimension = 2
    assert set(asyncio.run(retriever.rank("q3", {"a": "first", "b": "second"}))) == {"a", "b"}


def test_private_provider_selection_happens_before_any_content_call():
    with pytest.raises(ValueError, match="No enabled LLM provider"):
        SemanticCandidates(providers=[{"id": "cloud", "embedding_model": "embed"}],
                           privacy={"local_llm_ok": True})


def test_consent_check_inventory_cannot_mutate_pinned_embedding_route():
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=lambda *args: None)
    exposed = retriever.providers
    exposed[0]['trust_scope'] = 'external'
    assert retriever.providers[0]['trust_scope'] == 'owner_private'


@pytest.mark.parametrize("vectors", [[], [[1., 0.]], [[1., 0.], [1.]],
                                     [[1., 0.], [float("nan"), 1.]], [[1., 0.], [0., 0.]]])
def test_malformed_vectors_fail_before_source_ranking(vectors):
    async def embed(*args, **kwargs):
        return vectors
    retriever = SemanticCandidates(providers=[PROVIDER], privacy={"local_llm_ok": True}, embed_batch=embed)
    with pytest.raises(ValueError):
        asyncio.run(retriever.rank("question", {"a": "evidence"}))


def test_semantic_candidate_beats_unrelated_recency_without_creating_edges():
    chunks = {"old": "We never settled who pays after the grant.",
              **{f"c{i}": "Discuss the garden." for i in range(50)}}
    plan = plan_conversation_context("Who covers the server bill?", [], chunks, {},
                                    PassageContextPolicy(1800), semantic_scores={"old": .8})
    payload = json.loads(plan.prompt)
    assert payload["earlier_passages"][0]["chunk_id"] == "old"
    assert "semantic" in payload["coverage"]["retrieval"]
    assert "edge_relations" not in payload
    assert plan.estimated_tokens <= 1800


def test_foreign_source_candidates_are_rejected():
    with pytest.raises(ValueError, match="source"):
        plan_conversation_context("question", [], {"owned": "source"}, {},
                                  PassageContextPolicy(3000), semantic_scores={"foreign": .9})

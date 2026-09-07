"""Context-planning intent, before implementation.

Retrieve source, never infer semantic relationships from word overlap. Include
old relevant evidence ahead of unrelated recency; keep source units intact,
bound the serialized request, disclose omissions, and mutate no canonical data.
These are deterministic plumbing checks, not a test of model understanding.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.conversation_context import (
    ContextBudgetExceeded,
    PassageContextPolicy,
    plan_conversation_context,
)


def history():
    chunks = {"old": "Consent means informed assent, not just a yes button."}
    nodes = [{"id": "n-old", "chunk_id": "old", "thread_id": "consent",
              "thread_label": "Consent and agency", "summary": "What counts as consent?",
              "argument_role": "question", "semantic_level": 1}]
    for i in range(60):
        chunks[f"c-{i}"] = f"The unrelated subject number {i} has a separate explanation."
        nodes.append({"id": f"n-{i}", "chunk_id": f"c-{i}", "thread_id": f"t-{i}",
                      "summary": f"Unrelated subject {i}", "semantic_level": 1})
    return chunks, nodes


def test_old_evidence_survives_recency_and_serialized_budget():
    chunks, nodes = history()
    before = copy.deepcopy((chunks, nodes))
    policy = PassageContextPolicy(input_token_budget=5000)
    plan = plan_conversation_context("Returning to consent and agency.", nodes, chunks, {}, policy)
    payload = json.loads(plan.prompt)
    assert payload["earlier_passages"][0]["chunk_id"] == "old"
    assert payload["earlier_passages"][0]["text"] == chunks["old"]
    assert any(t["thread_id"] == "consent" for t in payload["thread_memory"])
    assert plan.estimated_tokens <= 5000
    assert plan.omitted_passages > 0
    assert (chunks, nodes) == before


def test_same_words_are_candidates_not_automatic_thread_merges():
    chunks = {"a": "A river bank collapsed.", "b": "The bank refused the loan."}
    nodes = [{"id": "river", "chunk_id": "a", "thread_id": "river-bank", "summary": "River bank"},
             {"id": "loan", "chunk_id": "b", "thread_id": "loan-bank", "summary": "Bank loan"}]
    plan = plan_conversation_context("About the bank...", nodes, chunks, {}, PassageContextPolicy(8000))
    payload = json.loads(plan.prompt)
    assert {t["thread_id"] for t in payload["thread_memory"]} == {"river-bank", "loan-bank"}
    assert "not proof" in payload["context_contract"]
    assert "edge_relations" not in payload
    assert "resolved" not in {t.get("status") for t in payload["thread_memory"]}


def test_current_passage_never_silently_truncated_to_fit():
    with pytest.raises(ContextBudgetExceeded):
        plan_conversation_context("untruncated " * 1000, [], {}, {}, PassageContextPolicy(2000))


def test_overlarge_history_is_omitted_whole_and_reported():
    chunks = {"big": "Earlier consent evidence " * 1000, "small": "Recent evidence."}
    plan = plan_conversation_context("Consent?", [], chunks, {}, PassageContextPolicy(2200))
    payload = json.loads(plan.prompt)
    assert all(p["chunk_id"] != "big" for p in payload["earlier_passages"])
    assert plan.omitted_passages >= 1
    assert payload["coverage"]["omitted_passages"] == plan.omitted_passages


def test_provenance_references_are_carried_without_reauthoring_quotes():
    text = "[SPEAKER_01]: That's not what I meant."
    plan = plan_conversation_context("What did you mean?", [], {"c": text}, {"c": ["u-1"]}, PassageContextPolicy(5000))
    passage = json.loads(plan.prompt)["earlier_passages"][0]
    assert passage["text"] == text
    assert passage["utterance_ids"] == ["u-1"]


def test_custom_token_counter_is_applied_to_complete_serialized_request():
    counter = lambda text: len(text.encode("utf-8")) * 2
    policy = PassageContextPolicy(input_token_budget=5000, count_tokens=counter)
    plan = plan_conversation_context("当前问题", [], {"earlier": "较早的证据"}, {}, policy)
    assert plan.estimated_tokens == counter(plan.prompt)
    assert plan.estimated_tokens <= policy.input_token_budget


def test_question_line_reference_overhead_is_inside_budget_without_source_truncation():
    """Many short source fragments cost more than just their joined prose."""
    from lct_python_backend.services.transcript.question_evidence import question_source_lines
    fragments = ['Yes.'] * 100
    source = ' '.join(fragments)
    lines = question_source_lines(source, fragments)
    complete = plan_conversation_context(source, [], {}, {}, PassageContextPolicy(20000),
                                         evidence_lines=lines)
    payload = json.loads(complete.prompt)
    assert payload['current_source_lines'] == lines
    assert payload['current_passage'] == source
    assert complete.estimated_tokens == len(complete.prompt.encode('utf-8'))
    with pytest.raises(ContextBudgetExceeded):
        plan_conversation_context(source, [], {}, {},
                                  PassageContextPolicy(complete.estimated_tokens - 1),
                                  evidence_lines=lines)

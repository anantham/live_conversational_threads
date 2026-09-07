"""Test intent:
- Questions survive digressions; source-backed updates never erase originals.
- Partial answers preserve open status and their exact attributed evidence.
- Partial answers cannot implicitly reopen answered or withdrawn questions.
"""
import copy

import pytest

from lct_python_backend.services.transcript.question_memory import fold_question_memory
from lct_python_backend.services.transcript.transcript_normalizer import _normalize_generated_output


def test_normalizer_does_not_duplicate_typed_edge_as_generic_context():
    nodes = _normalize_generated_output([{"node_name": "Return", "edge_relations": [
        {"related_node": "earlier", "relation_type": "clarifies", "relation_text": "Explains earlier wording."}]}])
    assert len(nodes[0]["edge_relations"]) == 1
    assert nodes[0]["edge_relations"][0]["relation_type"] == "clarifies"


def node(identity, action, quote, wording="Who pays?", question="funding"):
    return {"id": identity, "chunk_id": identity, "thread_id": "costs", "question_updates": [
        {"question_id": question, "action": action, "wording": wording,
         "evidence_quote": quote, "rationale": "The speaker explicitly discusses this question."}]}


def test_interleaved_question_survives_silence_and_preserves_original_after_answer():
    nodes = [node("a", "open", "Who pays?"), {"id": "b", "chunk_id": "b", "thread_id": "garden"}]
    chunks = {"a": "Who pays?", "b": "Let's talk about roses.", "c": "I will cover the bill."}
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "open"
    nodes.append(node("c", "answer", chunks["c"], "Mira offered to pay."))
    before = copy.deepcopy(nodes)
    memory = fold_question_memory(nodes, chunks)["funding"]
    assert memory["status"] == "answered"
    assert memory["original"]["wording"] == "Who pays?"
    assert memory["original"]["node_id"] == "a"
    assert memory["latest"]["node_id"] == "c"
    assert nodes == before


def test_clarification_does_not_answer_and_reopening_is_explicit():
    nodes = [node("a", "open", "Who pays?"), node("b", "clarify", "I mean hosting.", "Who pays hosting?")]
    chunks = {"a": "Who pays?", "b": "I mean hosting.", "c": "I will pay.", "d": "Actually I cannot pay."}
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "open"
    nodes.extend([node("c", "answer", chunks["c"]), node("d", "reopen", chunks["d"])])
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "open"


@pytest.mark.parametrize("bad", [node("b", "answer", "answer", question="missing"),
                                    node("b", "open", "answer"), node("b", "resolve_from_silence", "answer"),
                                    node("b", "answer", "invented quote")])
def test_unknown_referent_duplicate_identity_or_unsupported_evidence_rejected(bad):
    with pytest.raises(ValueError):
        fold_question_memory([node("a", "open", "Who pays?"), bad], {"a": "Who pays?", "b": "answer"})


def test_one_passage_can_advance_two_questions_without_merging_them():
    first = node("a", "open", "Who pays?")
    first["question_updates"].append(node("a", "open", "Who consents?", question="consent")["question_updates"][0])
    memory = fold_question_memory([first], {"a": "Who pays? Who consents?"})
    assert set(memory) == {"funding", "consent"}


def test_partial_answer_keeps_inquiry_open_across_digression_until_full_answer():
    chunks = {"a": "Who pays?", "b": "I can cover hosting, but not staffing.",
              "c": "The roses are blooming.", "d": "The grant covers the rest."}
    nodes = [node("a", "open", chunks["a"]),
             node("b", "partial_answer", chunks["b"], "Hosting covered; staffing unresolved."),
             {"id": "c", "chunk_id": "c", "thread_id": "garden"}]
    before = copy.deepcopy(nodes)
    memory = fold_question_memory(nodes, chunks)["funding"]
    assert memory["status"] == "open"
    assert memory["original"]["wording"] == "Who pays?"
    assert memory["latest"]["action"] == "partial_answer"
    assert memory["latest"]["evidence_quote"] == chunks["b"]
    assert memory["update_count"] == 2
    assert nodes == before
    nodes.append(node("d", "answer", chunks["d"]))
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "answered"


@pytest.mark.parametrize("closing_action", ["answer", "withdraw"])
def test_partial_answer_requires_explicit_reopening_of_closed_question(closing_action):
    chunks = {"a": "Who pays?", "b": "That question is settled.",
              "c": "Only hosting is covered.", "d": "Who pays staffing is still a question."}
    nodes = [node("a", "open", chunks["a"]), node("b", closing_action, chunks["b"])]
    partial = node("c", "partial_answer", chunks["c"])
    with pytest.raises(ValueError, match="Partial answer requires an open question"):
        fold_question_memory(nodes + [partial], chunks)
    nodes.extend([node("d", "reopen", chunks["d"]), partial])
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "open"


def test_partial_answer_requires_exact_current_source_evidence():
    with pytest.raises(ValueError, match="exact source evidence"):
        fold_question_memory([node("a", "open", "Who pays?"),
                              node("b", "partial_answer", "Invented offer")],
                             {"a": "Who pays?", "b": "I do not know."})

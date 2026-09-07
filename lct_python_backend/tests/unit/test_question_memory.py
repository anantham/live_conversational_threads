"""Test intent:
- Questions survive digressions; source-backed updates never erase originals.
- Partial answers preserve open status and their exact attributed evidence.
- Partial answers cannot implicitly reopen answered or withdrawn questions.
- A source-backed contribution conflicting with provisional closure is retained
  as uncertain, not rejected and not converted into an invented reopening.
"""
import copy
import json

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
def test_partial_answer_after_provisional_closure_preserves_conflict_without_reopening(closing_action):
    chunks = {"a": "Who pays?", "b": "That question is settled.",
              "c": "Only hosting is covered.", "d": "Who pays staffing is still a question."}
    nodes = [node("a", "open", chunks["a"]), node("b", closing_action, chunks["b"])]
    partial = node("c", "partial_answer", chunks["c"])
    before = copy.deepcopy(nodes + [partial])
    memory = fold_question_memory(nodes + [partial], chunks)['funding']
    assert memory['status'] == 'uncertain'
    assert memory['latest']['action'] == 'partial_answer'
    assert memory['latest']['transition_issue'] == 'partial_answer_after_non_open_state'
    assert memory['latest']['prior_provisional_status'] == ('answered' if closing_action == 'answer' else 'withdrawn')
    assert memory['intermediate'][0]['action'] == closing_action
    assert nodes + [partial] == before
    nodes.extend([node("d", "reopen", chunks["d"]), partial])
    assert fold_question_memory(nodes, chunks)["funding"]["status"] == "open"


def test_explicit_reopening_while_provisionally_open_is_retained_with_discrepancy():
    chunks = {'a': 'Who pays?', 'b': 'I want to reopen who pays.'}
    nodes = [node('a', 'open', chunks['a']), node('b', 'reopen', chunks['b'])]
    memory = fold_question_memory(nodes, chunks)['funding']
    assert memory['status'] == 'open'
    assert memory['latest']['transition_issue'] == 'reopening_already_open_question'
    assert memory['original']['action'] == 'open'


def test_conflict_survives_journal_restore_and_review_can_identify_prior_aside():
    from lct_python_backend.services.transcript.passage_journal import build_record, restore_records
    from lct_python_backend.services.transcript.question_review import build_question_review, validate_question_review
    from lct_python_backend.services.transcript.question_review_projection import project_question_review
    from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
    chunks = {'a': 'Who pays hosting and staffing?', 'b': 'Someone else paid for their own project.',
              'c': 'I can cover our hosting, but staffing is undecided.'}
    nodes = [node('a', 'open', chunks['a']), node('b', 'answer', chunks['b']),
             node('c', 'partial_answer', chunks['c'])]
    records = []
    for sequence, original in enumerate(nodes, 1):
        cid = original['chunk_id']
        records.append(build_record(sequence, sequence - 1,
            [{'id': cid, 'sequence_number': sequence, 'text': chunks[cid]}],
            {'nodes': [original], 'chunks': {cid: chunks[cid]}, 'utterance_chunk_map': {cid: [cid]}},
            policy_fingerprint='synthetic-question-conflicts-v1'))
    restored = restore_records(json.loads(json.dumps(records)))
    assert restored['nodes'] == nodes
    memory = fold_question_memory(restored['nodes'], restored['chunks'])['funding']
    assert memory['status'] == 'uncertain'
    assert memory['latest']['transition_issue'] == 'partial_answer_after_non_open_state'
    envelope = InferenceEnvelope(system_prompt='Synthetic review',
        providers=[{'id': 'local', 'trust_scope': 'owner_private', 'context_tokens': 16000}],
        privacy={'local_llm_ok': True}, output_tokens=1000, headroom_tokens=512)
    request = build_question_review(restored['nodes'], restored['chunks'], 'funding', envelope=envelope)
    response = {'assessments': [
        {'event_id': 'event-1', 'scope': 'related_aside', 'resolution': 'not_an_answer',
         'reason': 'A different project does not answer this inquiry.', 'evidence_ids': ['source-0', 'source-1']},
        {'event_id': 'event-2', 'scope': 'same_question', 'resolution': 'partial_answer',
         'reason': 'Hosting is offered but staffing remains undecided.', 'evidence_ids': ['source-0', 'source-2']}]}
    result = project_question_review(request, validate_question_review(response, request))
    assert result['provisional_status'] == 'uncertain'
    assert result['reviewed_status'] == 'open'
    assert [e['original']['action'] for e in result['events']] == ['open', 'answer', 'partial_answer']
    assert restored['nodes'] == nodes


def test_partial_answer_requires_exact_current_source_evidence():
    with pytest.raises(ValueError, match="exact source evidence"):
        fold_question_memory([node("a", "open", "Who pays?"),
                              node("b", "partial_answer", "Invented offer")],
                             {"a": "Who pays?", "b": "I do not know."})


def test_later_clarification_preserves_intermediate_partial_answer_in_working_memory():
    """Later wording cannot erase an earlier contribution to an unresolved question."""
    chunks = {'a': 'Who pays?', 'b': 'I can cover hosting, but not staffing.',
              'c': 'By staffing I mean a facilitator.', 'd': 'Food is covered too.'}
    nodes = [node('a', 'open', chunks['a']), node('b', 'partial_answer', chunks['b']),
             node('c', 'clarify', chunks['c']), node('d', 'partial_answer', chunks['d'])]
    before = copy.deepcopy(nodes)
    memory = fold_question_memory(nodes, chunks)['funding']
    assert memory['status'] == 'open'
    assert [e['node_id'] for e in memory['intermediate']] == ['b', 'c']
    assert memory['intermediate'][0]['evidence_quote'] == chunks['b']
    assert memory['original']['node_id'] == 'a' and memory['latest']['node_id'] == 'd'
    assert memory['update_count'] == 4
    assert nodes == before
    from lct_python_backend.services.transcript.conversation_context import plan_conversation_context, PassageContextPolicy
    plan = plan_conversation_context('Returning to the funding question.', nodes, chunks,
        {k: [k] for k in chunks}, PassageContextPolicy(16000))
    supplied = json.loads(plan.prompt)['question_memory'][0]
    assert supplied['intermediate'] == memory['intermediate']

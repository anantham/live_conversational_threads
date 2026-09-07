"""Test intent: retrieval becomes only source-cited proposals, with explicit
abstention and coverage. Foreign, missing and one-sided evidence must reject.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.inspection_relations import validate_relation_review, review_inspection_context


def fixture():
    context = {'focal': {'id': 'later', 'source_excerpts': [
        {'utterance_id': 'u90', 'start': 0, 'text': 'Returning to borrowing: it is still undecided.'}]},
        'candidates': [{'id': 'earlier', 'source_excerpts': [
            {'utterance_id': 'u1', 'start': 0, 'text': 'Who may borrow the key?'}]}],
        'coverage': {'omitted_candidates': 45}}
    response = {'comparisons': [{'candidate_id': 'earlier', 'status': 'related',
        'reason': 'The later remark returns to the borrowing question without answering it.',
        'relations': [{'relation_type': 'return_to_thread', 'rationale': 'Explicit unresolved callback.',
            'evidence': [{'observation_id': 'later', 'utterance_id': 'u90', 'quote': 'Returning to borrowing'},
                         {'observation_id': 'earlier', 'utterance_id': 'u1', 'quote': 'Who may borrow the key?'}]}]}]}
    return context, response


def test_cited_callback_is_a_proposal_not_an_answer_or_thread_merge():
    context, response = fixture()
    before = copy.deepcopy((context, response))
    result = validate_relation_review(response, context)
    relation = result['comparisons'][0]['relations'][0]
    assert relation['relation_type'] == 'return_to_thread'
    assert relation['evidence'][0]['start'] == 0
    assert not result['semantic_reconciliation_complete']
    assert result['coverage']['omitted_candidates'] == 45
    assert (context, response) == before


@pytest.mark.parametrize('fault', ['one_sided', 'foreign_source', 'invented_quote', 'missing_candidate', 'unknown_relation'])
def test_invalid_relation_proposals_reject(fault):
    context, response = fixture()
    relation = response['comparisons'][0]['relations'][0]
    if fault == 'one_sided': relation['evidence'].pop()
    elif fault == 'foreign_source': relation['evidence'][0]['utterance_id'] = 'u1'
    elif fault == 'invented_quote': relation['evidence'][0]['quote'] = 'The question is resolved.'
    elif fault == 'missing_candidate': response['comparisons'] = []
    else: relation['relation_type'] = 'answered_everything'
    with pytest.raises(ValueError):
        validate_relation_review(response, context)


@pytest.mark.parametrize('status', ['unrelated', 'uncertain'])
def test_non_linking_decisions_remain_explicit(status):
    context, response = fixture()
    response['comparisons'][0].update(status=status, reason='Insufficient evidence of a connection.', relations=[])
    assert validate_relation_review(response, context)['comparisons'][0]['relations'] == []


@pytest.mark.asyncio
async def test_no_admitted_candidates_needs_no_model_and_is_not_completion():
    context, _ = fixture()
    context['candidates'] = []
    class Envelope:
        fingerprint = 'synthetic'
        def complete_json(self, prompt):
            pytest.fail('An empty candidate set must not invoke inference')
    result = await review_inspection_context(json.dumps(context), envelope=Envelope())
    assert result['comparisons'] == [] and result['coverage']['omitted_candidates'] == 45
    assert result['policy_fingerprint'] == 'synthetic' and result['context_hash']
    assert not result['semantic_reconciliation_complete']

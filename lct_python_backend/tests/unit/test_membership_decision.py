"""Test intent: final membership judgment must account for all source reviews.

Missing/changed evidence and foreign citations fail; supporting evidence alone
does not automatically accept membership when a later page contradicts it.
"""
import copy

import pytest

from lct_python_backend.services.transcript.membership_decision import build_decision_request, validate_decision
from lct_python_backend.services.transcript.membership_review import plan_membership_reviews, validate_membership_review
from lct_python_backend.tests.unit.test_source_inspection import envelope


def case():
    p = {'proposal_id': 'p', 'label': 'Public access', 'rationale': 'Access discussion',
         'children_ids': ['a'], 'status': 'source_verification_required'}
    c = {'id': 'a', 'node_name': 'Access', 'summary': 'Public access is disputed.', 'utterance_ids': ['u']}
    s = {'u': {'id': 'u', 'sequence_number': 1, 'speaker_id': 'A',
               'text': 'Access is restricted. ' * 400}}
    requests = plan_membership_reviews(p, c, s, envelope=envelope())
    receipts = []
    for i, request in enumerate(requests):
        ids = [s['span_id'] for s in request['source_page']['spans']]
        result = validate_membership_review({'reviewed_span_ids': ids,
            'judgment': 'supports' if i == 0 else 'contradicts', 'rationale': 'Source-scoped interpretation.',
            'evidence_span_ids': ids}, request)
        receipts.append({'request': request, 'result': result})
    return requests, receipts


def test_all_reviews_required_and_conflicts_are_not_silently_resolved():
    requests, receipts = case()
    assert len(requests) > 1
    request = build_decision_request(requests, receipts, envelope=envelope(30000))
    assert any(r['judgment'] == 'contradicts' for r in request['reviews'])
    payload = {'decision': 'uncertain', 'rationale': 'The source interpretations conflict.',
               'reviewed_ids': [r['review_id'] for r in request['reviews']],
               'evidence_ids': [], 'qualifications': 'Do not infer unrestricted access.'}
    result = validate_decision(payload, request)
    assert result['decision'] == 'uncertain'
    assert result['qualifications'] == payload['qualifications']
    payload['reviewed_ids'] = payload['reviewed_ids'][:1]
    with pytest.raises(ValueError):
        validate_decision(payload, request)
    with pytest.raises(ValueError):
        build_decision_request(requests, receipts[:-1], envelope=envelope(30000))
    altered = copy.deepcopy(receipts)
    altered[0]['result']['citations'][0]['quote'] = 'Forged quote'
    with pytest.raises(ValueError):
        build_decision_request(requests, altered, envelope=envelope(30000))


def test_acceptance_requires_evidence_and_preserves_selected_exact_citations():
    requests, receipts = case()
    request = build_decision_request(requests, receipts, envelope=envelope(30000))
    payload = {'decision': 'accept', 'rationale': 'Access is the subject, not a settled policy.',
        'reviewed_ids': [r['review_id'] for r in request['reviews']], 'evidence_ids': [],
        'qualifications': 'Grouping does not imply that public access was agreed.'}
    with pytest.raises(ValueError):
        validate_decision(payload, request)
    evidence = request['reviews'][0]['evidence'][0]
    payload['evidence_ids'] = [evidence['evidence_id']]
    result = validate_decision(payload, request)
    assert result['citations'][0] == evidence['citation']
    payload['evidence_ids'] = ['invented']
    with pytest.raises(ValueError):
        validate_decision(payload, request)


def test_oversized_complete_evidence_packet_is_not_silently_trimmed():
    requests, receipts = case()
    class Reject:
        def validate(self, prompt):
            import json
            assert len(json.loads(prompt)['reviews']) == len(requests)
            raise ValueError('Complete evidence packet exceeds budget')
    with pytest.raises(ValueError, match='exceeds budget'):
        build_decision_request(requests, receipts, envelope=Reject())

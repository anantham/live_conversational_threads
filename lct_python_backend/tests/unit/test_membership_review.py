"""Test intent: inspect every child source within the full request budget.

- Oversized source remains gapless and attributed across processing windows.
- Reviews cite only supplied source spans and never declare final membership.
- Contradiction, uncertainty and unrelated evidence remain distinct outcomes.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.membership_review import plan_membership_reviews, validate_membership_review
from lct_python_backend.tests.unit.test_source_inspection import envelope


def inputs():
    child = {'id': 'a', 'node_name': 'Custody', 'summary': 'Who holds the key?',
             'utterance_ids': ['u1']}
    proposal = {'proposal_id': 'group', 'label': 'Shared access', 'rationale': 'Key custody affects access.',
                'children_ids': ['a'], 'status': 'source_verification_required'}
    sources = {'u1': {'id': 'u1', 'sequence_number': 1, 'speaker_id': 'A',
                      'speaker_revision': 2, 'text': 'Borrowing remains unresolved. 🗝️ ' * 700}}
    return proposal, child, sources


def test_complete_child_evidence_is_bounded_without_mutation():
    proposal, child, sources = inputs()
    before = copy.deepcopy((proposal, child, sources))
    pages = plan_membership_reviews(proposal, child, sources, envelope=envelope())
    assert len(pages) > 1
    spans = [s for p in pages for s in p['source_page']['spans']]
    assert ''.join(s['text'] for s in spans) == sources['u1']['text']
    cursor = 0
    for s in spans:
        assert s['start'] == cursor and s['speaker_revision'] == 2
        cursor = s['end']
    for page in pages:
        envelope().validate(json.dumps(page, ensure_ascii=False, separators=(',', ':')))
        assert page['child']['id'] == 'a'
        assert page['proposal']['proposal_id'] == 'group'
    assert (proposal, child, sources) == before


@pytest.mark.parametrize('judgment', ['supports', 'contradicts', 'uncertain', 'unrelated'])
def test_evidence_judgments_keep_exact_attribution_without_finalizing(judgment):
    p, c, s = inputs()
    request = plan_membership_reviews(p, c, s, envelope=envelope())[0]
    ids = [span['span_id'] for span in request['source_page']['spans']]
    raw = {'reviewed_span_ids': ids, 'judgment': judgment, 'rationale': 'Source-scoped assessment.',
           'evidence_span_ids': ids}
    result = validate_membership_review(raw, request)
    assert result['judgment'] == judgment
    assert result['status'] == 'proposal_reconciliation_required'
    assert result['citations'][0]['utterance_id'] == 'u1'
    assert result['citations'][0]['speaker_id'] == 'A'
    assert result['citations'][0]['quote'] == request['source_page']['spans'][0]['text']
    raw['evidence_span_ids'] = ['invented']
    with pytest.raises(ValueError):
        validate_membership_review(raw, request)
    raw['evidence_span_ids'] = ids
    raw['reviewed_span_ids'] = []
    with pytest.raises(ValueError):
        validate_membership_review(raw, request)


def test_foreign_child_and_missing_source_rejected():
    p, c, s = inputs()
    c['id'] = 'foreign'
    with pytest.raises(ValueError):
        plan_membership_reviews(p, c, s, envelope=envelope())
    c['id'] = 'a'
    with pytest.raises(ValueError):
        plan_membership_reviews(p, c, {}, envelope=envelope())

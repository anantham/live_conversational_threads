"""Test intent: synthesize only fully accepted, source-backed memberships.
Every child remains present; generated output cannot invent evidence or silently
drop a disputed child. Canonical ancestry includes all child sources, not only
the selected summary evidence.
"""
import pytest

from lct_python_backend.services.transcript.parent_synthesis import build_parent_request, validate_parent
from lct_python_backend.services.transcript.source_backed_aggregation import build_aggregation_request, validate_aggregation
from lct_python_backend.tests.unit.test_source_inspection import envelope


def test_parent_keeps_accepted_memberships_and_full_source_union():
    child = {'id': 'a', 'node_name': 'Borrowing', 'summary': 'Borrowing remains open.',
             'semantic_level': 1, 'utterance_ids': ['u1', 'u2']}
    proposal = {'proposal_id': 'p', 'children_ids': ['a'], 'label': 'Access', 'rationale': 'Key access'}
    decisions = [{'child_id': 'a', 'proposal_id': 'p', 'decision': 'accept',
                  'rationale': 'Related inquiry', 'qualifications': 'Unresolved',
                  'citations': [{'utterance_id': 'u1', 'quote': 'Who borrows?', 'start': 0, 'end': 12}]}]
    request = build_parent_request(proposal, [child], decisions, envelope=envelope())
    raw = {'node_name': 'Access inquiry', 'summary': 'Borrowing remains unresolved.',
           'memberships': [{'child_id': 'a', 'evidence_ids': [request['members'][0]['evidence'][0]['evidence_id']]}]}
    parent = validate_parent(raw, request)
    sources = {'u1': {'id': 'u1', 'sequence_number': 1, 'text': 'Who borrows?'},
               'u2': {'id': 'u2', 'sequence_number': 2, 'text': 'Still unanswered.'}}
    canonical = validate_aggregation({'nodes': [parent]}, build_aggregation_request([child], sources, target_level=2))
    assert canonical[0]['utterance_ids'] == ['u1', 'u2']
    raw['memberships'][0]['evidence_ids'] = ['invented']
    with pytest.raises(ValueError): validate_parent(raw, request)
    raw['memberships'] = []
    with pytest.raises(ValueError): validate_parent(raw, request)
    decisions[0]['decision'] = 'uncertain'
    with pytest.raises(ValueError): build_parent_request(proposal, [child], decisions, envelope=envelope())

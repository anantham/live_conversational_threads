"""Test intent: global overview is a proposal, never source verification.

- Preserve every child and open-question context; allow overlapping groups.
- Reject missing/foreign children rather than adopting them by position.
- Budget the whole overview and keep proposal IDs tied to its exact snapshot.
"""
import copy

import pytest

from lct_python_backend.services.transcript.abstraction_proposals import (
    build_proposal_request, validate_proposals,
)
from lct_python_backend.tests.unit.test_source_inspection import envelope


def children():
    return [{'id': 'a', 'semantic_level': 1, 'node_name': 'Key custody',
             'summary': 'Who holds the key?', 'thread_id': 'keys', 'utterance_ids': ['u1'],
             'question_updates': [{'action': 'open', 'question_id': 'custody'}]},
            {'id': 'b', 'semantic_level': 1, 'node_name': 'Garden access',
             'summary': 'Garden access also needs the shared key.', 'utterance_ids': ['u2']}]


def test_overlapping_proposals_preserve_children_but_are_not_verified_nodes():
    original = children()
    before = copy.deepcopy(original)
    request = build_proposal_request(original, target_level=2, source_snapshot_hash='source-v1', envelope=envelope())
    assert original == before
    assert request['children'][0]['question_updates'] == original[0]['question_updates']
    result = {'groups': [{'label': 'Custody', 'rationale': 'An unresolved custody inquiry.', 'children_ids': ['a']},
                         {'label': 'Access', 'rationale': 'The shared key connects access and custody.', 'children_ids': ['a', 'b']}]}
    proposals = validate_proposals(result, request)
    assert len(proposals) == 2
    assert all(p['status'] == 'source_verification_required' for p in proposals)
    assert all('semantic_level' not in p and 'summary' not in p for p in proposals)
    assert validate_proposals(result, request) == proposals
    changed = copy.deepcopy(request)
    changed['source_snapshot_hash'] = 'source-v2'
    assert validate_proposals(result, changed)[0]['proposal_id'] != proposals[0]['proposal_id']


@pytest.mark.parametrize('ids', [[], ['a'], ['a', 'missing'], ['a', 'a', 'b']])
def test_coverage_and_identity_fail_closed(ids):
    request = build_proposal_request(children(), target_level=2, source_snapshot_hash='source-v1', envelope=envelope())
    with pytest.raises(ValueError):
        validate_proposals({'groups': [{'label': 'Group', 'rationale': 'Reason', 'children_ids': ids}]}, request)


def test_no_silent_truncation_or_wrong_tier():
    nodes = children()
    nodes[0]['summary'] = 'x' * 30000
    with pytest.raises(ValueError):
        build_proposal_request(nodes, target_level=2, source_snapshot_hash='source-v1', envelope=envelope())
    with pytest.raises(ValueError):
        build_proposal_request(children(), target_level=3, source_snapshot_hash='source-v1', envelope=envelope())

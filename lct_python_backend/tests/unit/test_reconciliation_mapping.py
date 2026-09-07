"""Test intent: preserve exact relation direction/evidence, do not guess among
overlapping moments, and reject altered reviews before canonical writes.
"""
import copy

import pytest

from lct_python_backend.tests.unit.test_inspection_relations import fixture
from lct_python_backend.services.transcript.inspection_relations import validate_relation_review
from lct_python_backend.services.transcript.reconciliation_mapping import map_reviewed_relations


def inputs():
    context, raw = fixture()
    review = validate_relation_review(raw, context)
    nodes = [{'id': 'old-node', 'level': 1, 'utterance_ids': ['u1']},
             {'id': 'new-node', 'level': 1, 'utterance_ids': ['u90']}]
    return context, review, nodes


def test_unique_leaf_ownership_preserves_later_to_earlier_callback():
    context, review, nodes = inputs()
    before = copy.deepcopy((context, review, nodes))
    mapped = map_reviewed_relations(review, context, nodes)
    assert mapped[0]['from_node_id'] == 'new-node' and mapped[0]['to_node_id'] == 'old-node'
    assert mapped[0]['relation']['relation_type'] == 'return_to_thread'
    assert (context, review, nodes) == before


def test_candidate_question_can_ask_about_focal_statement():
    context, raw = fixture()
    raw['comparisons'][0]['relations'][0].update(
        relation_type='asks', from_observation_id='earlier', to_observation_id='later')
    review = validate_relation_review(raw, context)
    nodes = [{'id': 'question', 'level': 1, 'utterance_ids': ['u1']},
             {'id': 'statement', 'level': 1, 'utterance_ids': ['u90']}]
    mapped = map_reviewed_relations(review, context, nodes)
    assert mapped[0]['from_node_id'] == 'question'
    assert mapped[0]['to_node_id'] == 'statement'


@pytest.mark.parametrize('fault,expected', [('overlap', 'ambiguous_node_ownership'),
                                           ('missing', 'unmapped_source'), ('same_node', 'within_node')])
def test_unsafe_endpoint_mapping_remains_explicit(fault, expected):
    context, review, nodes = inputs()
    if fault == 'overlap':
        nodes.append({'id': 'other-claim', 'level': 1, 'utterance_ids': ['u1'],
                      'source_excerpt': 'Different sentence is only a display snippet.'})
    elif fault == 'missing': nodes.pop()
    else: nodes = [{'id': 'combined', 'level': 1, 'utterance_ids': ['u1', 'u90']}]
    mapped = map_reviewed_relations(review, context, nodes)
    assert mapped[0]['disposition'] == expected
    assert mapped[0]['from_node_id'] is None and mapped[0]['to_node_id'] is None


def test_modified_offset_is_not_laundered_into_canonical_edge():
    context, review, nodes = inputs()
    review['comparisons'][0]['relations'][0]['evidence'][0]['start'] += 1
    with pytest.raises(ValueError, match='altered evidence'):
        map_reviewed_relations(review, context, nodes)

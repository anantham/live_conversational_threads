"""Test intent: preserve exact relation direction/evidence, do not guess among
overlapping moments, and reject altered reviews before canonical writes.
Explicit semantic choices resolve overlaps; abstention overrides unique ownership.
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


@pytest.mark.parametrize('abstain', [False, True])
def test_explicit_semantic_selection_or_abstention_controls_mapping(abstain):
    context, raw = fixture()
    nodes = [{'id': 'old-node', 'level': 1, 'utterance_ids': ['u1']},
             {'id': 'new-node', 'level': 1, 'utterance_ids': ['u90']}]
    if not abstain:
        nodes.append({'id': 'different-idea', 'level': 1, 'utterance_ids': ['u1']})
    for obs in [context['focal'], *context['candidates']]:
        uid = obs['source_excerpts'][0]['utterance_id']
        obs['canonical_candidates'] = [dict(n) for n in nodes if uid in n['utterance_ids']]
    raw['comparisons'][0]['relations'][0]['node_selections'] = [
        {'observation_id': 'later', 'node_id': 'new-node', 'rationale': 'Same unresolved callback.'},
        {'observation_id': 'earlier', 'node_id': None if abstain else 'old-node',
         'rationale': 'No semantic match.' if abstain else 'This node expresses the inquiry.'}]
    review = validate_relation_review(raw, context)
    result = map_reviewed_relations(review, context, nodes)[0]
    assert result['disposition'] == ('semantic_mapping_unresolved' if abstain else 'semantic_selection')
    assert result['to_node_id'] == (None if abstain else 'old-node')


def test_canonical_context_requires_selection_not_implicit_unique_match():
    context, raw = fixture()
    for obs in [context['focal'], *context['candidates']]:
        obs['canonical_candidates'] = []
    with pytest.raises(ValueError, match='selection'):
        validate_relation_review(raw, context)


@pytest.mark.parametrize('fault', ['foreign', 'wrong_source'])
def test_semantic_selection_cannot_escape_admitted_source(fault):
    context, raw = fixture()
    for obs in [context['focal'], *context['candidates']]:
        obs['canonical_candidates'] = [{'id': obs['id'] + '-node',
            'utterance_ids': [e['utterance_id'] for e in obs['source_excerpts']]}]
    relation = raw['comparisons'][0]['relations'][0]
    relation['node_selections'] = [{'observation_id': obs['id'], 'node_id': obs['id'] + '-node',
        'rationale': 'Purported match.'} for obs in [context['focal'], *context['candidates']]]
    if fault == 'foreign': relation['node_selections'][0]['node_id'] = 'unavailable'
    else: context['focal']['canonical_candidates'][0]['utterance_ids'] = ['different-source']
    with pytest.raises(ValueError, match='selection'):
        validate_relation_review(raw, context)


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

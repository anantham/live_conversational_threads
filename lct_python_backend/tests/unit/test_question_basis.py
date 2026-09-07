"""Revision intent: unrelated growth is stable; any contributing evidence drift is not.

Include whole passages, source identity/timing/speaker revisions and canonical
interpretations. Missing source must fail, not look like a smaller valid basis.
"""
import copy
import pytest
from lct_python_backend.services.transcript.question_basis import question_basis


def basis():
    return {'state': {'nodes': [{'id': 'n', 'chunk_id': 'c', 'summary': 'Unresolved',
        'question_updates': [{'question_id': 'q', 'action': 'open', 'wording': 'Who?',
            'evidence_quote': 'Who?', 'rationale': 'Explicit question'}]}],
        'chunks': {'c': 'Who? More context.'}, 'utterance_chunk_map': {'c': ['u']}},
        'source': {'request': {'sources': [{'id': 'u', 'text': 'Who? More context.',
            'speaker_id': 'A', 'speaker_revision': 0, 'timestamp_start': 0}]}}}


def test_unrelated_source_and_canonical_node_do_not_change_question_identity():
    original = basis()
    changed = copy.deepcopy(original)
    changed['state']['nodes'].append({'id': 'elsewhere', 'chunk_id': 'other', 'summary': 'Another topic'})
    changed['state']['chunks']['other'] = 'Another topic'
    changed['state']['utterance_chunk_map']['other'] = ['v']
    changed['source']['request']['sources'].append({'id': 'v', 'text': 'Another topic'})
    assert question_basis(changed, 'q') == question_basis(original, 'q')


@pytest.mark.parametrize('field,value', [('speaker_id', 'B'), ('speaker_revision', 1),
    ('timestamp_start', 2), ('text', 'Who? Corrected context.')])
def test_full_source_revision_is_retained(field, value):
    original = basis()
    changed = copy.deepcopy(original)
    changed['source']['request']['sources'][0][field] = value
    assert question_basis(changed, 'q') != question_basis(original, 'q')


def test_interpretation_and_unquoted_context_are_revision_relevant():
    original = basis()
    changed = copy.deepcopy(original)
    changed['state']['nodes'][0]['summary'] = 'Human correction'
    assert question_basis(changed, 'q') != question_basis(original, 'q')
    changed = copy.deepcopy(original)
    changed['state']['chunks']['c'] += ' Additional qualification.'
    assert question_basis(changed, 'q') != question_basis(original, 'q')


@pytest.mark.parametrize('sources', [[], [basis()['source']['request']['sources'][0]] * 2])
def test_missing_or_duplicate_source_is_not_accepted(sources):
    changed = basis()
    changed['source']['request']['sources'] = sources
    with pytest.raises(ValueError, match='missing or duplicated'):
        question_basis(changed, 'q')

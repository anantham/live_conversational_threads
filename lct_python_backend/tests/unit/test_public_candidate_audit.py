"""Source-only, one-thread and source-mutated files must not pass the screen."""
from copy import deepcopy
from tools.audit_public_candidate import audit


def fixture():
    source = [{'id': 'u1', 'text': 'synthetic', 'speaker_id': 'a'}]
    bundle = {'utterances': deepcopy(source), 'graph_data': [
        {'id': str(i), 'semantic_level': i, 'thread_id': 'a' if i%2 else 'b',
         'utterance_ids': ['u1']} for i in range(1,6)],
        'media_refs': [{'provider':'youtube', 'video_id':'6HmR9IaqM88',
                       'view_url':'https://www.youtube.com/watch?v=6HmR9IaqM88'}]}
    return bundle, source


def test_structural_pass_is_not_semantic_or_publication_acceptance():
    bundle, source = fixture()
    result = audit(bundle, source)
    assert not result['structural_problems']
    assert result['publication_accepted'] is False
    assert result['semantic_acceptance'].startswith('pending')


def test_source_only_and_single_thread_fail():
    bundle, source = fixture()
    bundle['graph_data'] = bundle['graph_data'][:1]
    result = audit(bundle, source)
    assert any('levels' in x for x in result['structural_problems'])
    assert any('threads' in x for x in result['structural_problems'])


def test_mutated_source_and_foreign_reference_fail():
    bundle, source = fixture()
    bundle['utterances'][0]['text'] = 'changed'
    bundle['graph_data'][0]['utterance_ids'] = ['foreign']
    result = audit(bundle, source)
    assert any('source fields' in x for x in result['structural_problems'])
    assert any('Foreign' in x for x in result['structural_problems'])

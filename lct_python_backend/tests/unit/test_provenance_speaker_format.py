"""Known prompt speaker labels may be formatting, not transcript words.

Recover unique cross-turn source spans without editing excerpts or source; reject
unknown labels, paraphrase and ambiguous recovery. Existing IDs remain untouched.
"""
from lct_python_backend.services.provenance_linking import assign_grounded_leaf_utterance_ids

def test_known_speaker_marker_recovers_exact_cross_turn_span():
    excerpt = 'We need chapters\n[SPEAKER_01]: and timestamps.'
    nodes = [{'semantic_level': 1, 'source_excerpt': excerpt}]
    assign_grounded_leaf_utterance_ids(nodes, ['We need chapters', 'and timestamps.'], [['a'], ['b']],
                                     speaker_ids=['SPEAKER_01'])
    assert nodes[0]['utterance_ids'] == ['a', 'b']
    assert nodes[0]['source_excerpt'] == excerpt

def test_unknown_label_or_paraphrase_cannot_get_guessed_source():
    for excerpt in ['We need chapters [UNKNOWN]: and timestamps.', 'We want chapters [SPEAKER_01]: and timestamps.']:
        nodes = [{'source_excerpt': excerpt}]
        assign_grounded_leaf_utterance_ids(nodes, ['We need chapters', 'and timestamps.'], [['a'], ['b']],
                                         speaker_ids=['SPEAKER_01'])
        assert not nodes[0].get('utterance_ids')

def test_ambiguous_marker_recovery_stays_unlinked():
    nodes = [{'source_excerpt': 'Hello [A]: world'}]
    assign_grounded_leaf_utterance_ids(nodes, ['Hello world', 'Hello world'], [['a'], ['b']], speaker_ids=['A'])
    assert not nodes[0].get('utterance_ids')

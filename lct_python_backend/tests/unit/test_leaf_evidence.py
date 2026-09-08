"""Intent: explicit support preserves a callback outside the display quote;
noncontiguous selections do not claim intervening turns; malformed/future IDs
and conflicting authored provenance fail before any node changes.
"""
import copy
import json

import pytest

from lct_python_backend.services.leaf_evidence import selected_leaf_sources
from lct_python_backend.services.provenance_linking import assign_grounded_leaf_utterance_ids
from lct_python_backend.services.transcript.canonical_selection import canonical_candidates
from lct_python_backend.services.transcript.transcript_normalizer import _normalize_generated_output


def test_callback_has_candidate_outside_representative_excerpt():
    texts = ['We hope to continue this series.', 'Unrelated travel aside.', 'Today we discuss safety.']
    nodes = _normalize_generated_output({'nodes': [{'node_name': 'Introduction',
        'summary': 'A continuing series begins with safety.', 'source_excerpt': texts[2],
        'source_line_ids': ['line-2', 'line-0']}]})
    assign_grounded_leaf_utterance_ids(nodes, texts, [['u0'], ['u1'], ['u2']])
    assert nodes[0]['utterance_ids'] == ['u0', 'u2']
    assert nodes[0]['source_excerpt'] == texts[2]
    observation = {'source_excerpts': [{'utterance_id': 'u0'}]}
    assert canonical_candidates(observation, nodes)[0]['id'] == nodes[0]['id']
    assert not canonical_candidates({'source_excerpts': [{'utterance_id': 'u1'}]}, nodes)


@pytest.mark.parametrize('selection', [None, [], 'line-0', ['line-9'], [0], ['line-0', 'line-0']])
def test_bad_selection_fails_atomically(selection):
    nodes = [{'source_line_ids': ['line-0']}, {'source_line_ids': selection}]
    before = copy.deepcopy(nodes)
    with pytest.raises(ValueError, match='source line IDs'):
        assign_grounded_leaf_utterance_ids(nodes, ['Source'], [['u0']])
    assert nodes == before


def test_existing_provenance_cannot_be_silently_replaced():
    with pytest.raises(ValueError, match='conflicts'):
        selected_leaf_sources([{'source_line_ids': ['line-0'], 'utterance_ids': ['other']}], ['A'], [['u0']])


def test_source_slots_cannot_alias_or_disappear():
    for slots in ([['u0'], ['u0']], [['u0']], [['u0'], []]):
        with pytest.raises(ValueError):
            selected_leaf_sources([{'source_line_ids': ['line-0']}], ['A', 'B'], slots)


def test_legacy_quote_only_localization_is_unchanged():
    nodes = [{'source_excerpt': 'B'}]
    assign_grounded_leaf_utterance_ids(nodes, ['A', 'B'], [['u0'], ['u1']])
    assert nodes[0]['utterance_ids'] == ['u1']


@pytest.mark.parametrize('selection', [None, [], ['line-9'], ['line-0', 'line-0'], ['line-0']])
def test_versioned_envelope_requires_current_selections(monkeypatch, selection):
    from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
    config = dict(system_prompt='Select support', providers=[{'id': 'local', 'model': 'test',
        'base_url': 'http://127.0.0.1:11434', 'trust_scope': 'owner_private',
        'type': 'openai_compatible', 'context_tokens': 12000}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False}, output_tokens=1000, headroom_tokens=512)
    envelope = InferenceEnvelope(**config, require_leaf_sources=True)
    assert envelope.fingerprint != InferenceEnvelope(**config).fingerprint
    class Result:
        data = {'nodes': [{'node_name': 'Opening', 'source_line_ids': selection}]}
        def backend_label(self):
            return 'synthetic'
    monkeypatch.setattr(envelope, 'complete_json', lambda prompt: Result())
    prompt = json.dumps({'current_source_lines': [{'id': 'line-0', 'text': 'Opening'}]})
    if selection == ['line-0']:
        assert envelope.generate(prompt)[0][0]['source_line_ids'] == selection
    else:
        with pytest.raises(ValueError, match='Every interpreted leaf'):
            envelope.generate(prompt)


def test_checkpoint_recovery_preserves_noncontiguous_support():
    from lct_python_backend.services.transcript.passage_journal import build_record, restore_records
    sources = [{'id': f'u{i}', 'text': text, 'sequence_number': i + 1}
               for i, text in enumerate(['Opening', 'Aside', 'Return'])]
    nodes = [{'id': 'n', 'chunk_id': 'c', 'source_line_ids': ['line-0', 'line-2']}]
    assign_grounded_leaf_utterance_ids(nodes, [s['text'] for s in sources], [[s['id']] for s in sources])
    patch = {'nodes': nodes, 'chunks': {'c': 'Opening Aside Return'},
             'utterance_chunk_map': {'c': ['u0', 'u1', 'u2']}}
    record = build_record(1, 0, sources, patch, policy_fingerprint='leaf-selection-test')
    restored = restore_records([json.loads(json.dumps(record))])
    assert restored['nodes'][0]['utterance_ids'] == ['u0', 'u2']
    assert restored['nodes'][0]['source_line_ids'] == ['line-0', 'line-2']

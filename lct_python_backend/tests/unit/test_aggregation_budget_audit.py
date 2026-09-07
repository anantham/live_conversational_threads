"""Test intent: offline budget evidence must match real request admission.

- Report overflowing individual children, not just overflowing whole tiers.
- Preserve input and keep source text/identities out of the numeric report.
- Never call inference; reject duplicate source identities.
"""
import copy
import json

import pytest

from tools.audit_aggregation_budget import audit_artifact


def test_offline_audit_distinguishes_whole_tier_and_individual_overflow(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Offline audit must not call inference')
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', forbidden)
    artifact = {'utterances': [
        {'id': 'secret-source-a', 'sequence_number': 1, 'text': 'classified content ' * 600},
        {'id': 'secret-source-b', 'sequence_number': 2, 'text': 'other content ' * 600}],
        'graph_data': [
            {'id': 'n1', 'semantic_level': 1, 'utterance_ids': ['secret-source-a']},
            {'id': 'n2', 'semantic_level': 1, 'utterance_ids': ['secret-source-b']}]}
    before = copy.deepcopy(artifact)
    report = audit_artifact(artifact, context_limit=20000)
    tier = report['tiers'][0]
    assert not tier['fits']
    assert tier['single_child_over_budget'] == 0
    smaller = audit_artifact(artifact, context_limit=12000)
    assert smaller['tiers'][0]['single_child_over_budget'] == 2
    assert artifact == before
    assert 'secret-source' not in json.dumps(report)
    assert 'classified content' not in json.dumps(report)


def test_duplicate_sources_are_not_silently_collapsed():
    source = {'id': 'u1', 'sequence_number': 1, 'text': 'source'}
    with pytest.raises(ValueError, match='Duplicate source'):
        audit_artifact({'utterances': [source, source], 'graph_data': []})


def test_legacy_missing_provenance_is_reported_not_invented():
    report = audit_artifact({'utterances': [], 'graph_data': [
        {'id': 'legacy', 'semantic_level': 2, 'utterance_ids': [],
         'provenance_utterance_ids': ['not-an-authorized-source']}]})
    assert report['tiers'] == [{'target_level': 3, 'children': 1,
        'status': 'invalid_request', 'reason': 'Every child requires distinct source IDs'}]

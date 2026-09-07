"""Verifier output must not launder invented quotes or expanded citations.

These checks establish lexical provenance only, never semantic truth/recall.
"""
import pytest
from lct_python_backend.services.transcript.atomic_evidence_audit import audit_atomic_response


def case(quote='control engineering', span='b', support='elsewhere'):
    request = {'source': [{'span_id': 'a', 'text': 'Instrumentation and'},
                          {'span_id': 'b', 'text': 'control engineering'}],
               'observations': [{'id': 'o', 'citations': [{'span_id': 'a', 'quote': 'Instrumentation'}]}]}
    response = {'reviews': [{'observation_id': 'o', 'claims': [{'claim': 'Studied control engineering.',
        'support': support, 'citations': [{'span_id': span, 'quote': quote}]}]}]}
    return response, request


def test_valid_source_continuation_is_not_original_selected_evidence():
    result = audit_atomic_response(*case(support='selected'))
    assert result['claims'][0]['citation_location'] == 'elsewhere'
    assert result['claims'][0]['support_label_mismatch']
    assert not result['semantic_entailment_verified'] and not result['claim_coverage_verified']


def test_selected_span_does_not_make_its_uncited_words_selected():
    result = audit_atomic_response(*case(quote='and', span='a', support='selected'))
    assert result['claims'][0]['citation_location'] == 'elsewhere'


def test_quote_cannot_be_assigned_to_preceding_span():
    with pytest.raises(ValueError, match='absent'):
        audit_atomic_response(*case(span='a'))


def test_missing_observation_is_not_implicit_acceptance():
    response, request = case()
    response['reviews'] = []
    with pytest.raises(ValueError, match='omitted'):
        audit_atomic_response(response, request)

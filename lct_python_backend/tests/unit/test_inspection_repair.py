"""Test intent:
- Repairs retain observation meaning and all original page acknowledgements.
- Adjacent-span quotes must become individually source-exact citations.
- Unknown spans, changed meaning, overflow and invalid corrections fail closed.
- The model selects source IDs; the backend attaches exact full-span evidence.
"""
import copy
import json
from types import SimpleNamespace

import pytest

from lct_python_backend.services.transcript.inspection_repair import (
    plan_repairs, apply_repair, repair_inspection, validate_repair_audit,
)
from lct_python_backend.services.transcript.source_inspection import validate_inspection
from lct_python_backend.tests.unit.test_source_inspection import envelope
from lct_python_backend.services.transcript.source_inspection_pages import plan_inspection_pages


def case():
    page = plan_inspection_pages([
        {'id': 'a', 'sequence_number': 1, 'text': 'Who holds'},
        {'id': 'b', 'sequence_number': 2, 'text': 'the key?'}], envelope=envelope())[0]
    payload = {'reviewed_span_ids': [s['span_id'] for s in page['spans']],
               'observations': [{'kind': 'question', 'text': 'Who holds the key?',
                   'citations': [{'span_id': page['spans'][1]['span_id'], 'quote': 'Who holds the key?'}]}]}
    return page, payload


def test_split_quote_repair_preserves_meaning_and_original():
    page, payload = case()
    before = copy.deepcopy(payload)
    plans = plan_repairs(payload, page, envelope=envelope())
    assert len(plans) == 1
    request = plans[0]['request']
    assert len(request['spans']) == 2
    corrected = {'span_ids': [s['span_id'] for s in page['spans']], 'rationale': 'The question crosses both turns.'}
    output = apply_repair(payload, plans[0], corrected)
    assert payload == before
    assert output['observations'][0]['text'] == before['observations'][0]['text']
    assert len(validate_inspection(output, page)['observations'][0]['citations']) == 2
    assert not plan_repairs(output, page, envelope=envelope())


@pytest.mark.parametrize('fault', ['meaning', 'kind', 'empty', 'unknown', 'duplicate'])
def test_repair_cannot_change_or_drop_observation(fault):
    page, payload = case()
    plan = plan_repairs(payload, page, envelope=envelope())[0]
    result = {'span_ids': [s['span_id'] for s in page['spans']], 'rationale': 'Evidence'}
    if fault == 'meaning': result['text'] = 'The question is resolved.'
    elif fault == 'kind': result['kind'] = 'answer'
    elif fault == 'empty': result['span_ids'] = []
    elif fault == 'unknown': result['span_ids'] = ['invented']
    else: result['span_ids'] *= 2
    with pytest.raises(ValueError):
        apply_repair(payload, plan, result)


def test_unknown_referent_is_not_guessed_and_full_repair_request_is_budgeted():
    page, payload = case()
    payload['observations'][0]['citations'][0]['span_id'] = 'unknown'
    with pytest.raises(ValueError, match='unknown span'):
        plan_repairs(payload, page, envelope=envelope())
    page, payload = case()
    class Reject:
        def validate(self, prompt):
            assert json.loads(prompt)['rejected_observation'] == payload['observations'][0]
            raise ValueError('Full request too large')
    with pytest.raises(ValueError, match='too large'):
        plan_repairs(payload, page, envelope=Reject())


@pytest.mark.asyncio
async def test_correction_preserves_audit_and_checks_consent(monkeypatch):
    page, payload = case()
    contract = envelope()
    requests = []
    async def guard():
        requests.append('consent')
    def transport(**kwargs):
        requests.append('inference')
        request = json.loads(kwargs['messages'][1]['content'])
        result = {'span_ids': [s['span_id'] for s in request['spans']], 'rationale': 'Both parts support the question.'}
        return SimpleNamespace(data=result)
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    corrected, audit = await repair_inspection(payload, page, envelope=contract, request_guard=guard)
    assert requests == ['consent', 'inference', 'consent']
    assert audit['original_response'] == payload
    assert len(audit['corrections']) == 1
    assert corrected != payload
    validate_repair_audit(audit, corrected, page, contract.fingerprint)
    forged = copy.deepcopy(corrected)
    forged['observations'][0]['text'] = 'Altered meaning'
    with pytest.raises(ValueError, match='reproduce'):
        validate_repair_audit(audit, forged, page, contract.fingerprint)
    with pytest.raises(ValueError, match='policy mismatch'):
        validate_repair_audit(audit, corrected, page, 'different-policy')
    async def revoked():
        raise PermissionError('Consent revoked')
    with pytest.raises(PermissionError):
        await repair_inspection(payload, page, envelope=contract, request_guard=revoked)
    assert requests == ['consent', 'inference', 'consent']

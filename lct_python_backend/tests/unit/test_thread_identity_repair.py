"""Select exact source ranges once; preserve audit and legacy recovery.

Test intent: never synthesize quotations; reject invalid endpoints; retain
validation of previously accepted quote-regeneration receipts.
"""
import copy
import json
from types import SimpleNamespace
import pytest
from lct_python_backend.services.transcript.thread_identity_repair import (
    repair_thread_identity, validate_identity_repair, materialize_selection)

def fixture():
    request = {'state_hash': 'synthetic', 'nodes': [
        {'node_id': 'a', 'source_id': 's'}, {'node_id': 'b', 'source_id': 's'}],
        'sources': [{'source_id': 's', 'text': 'Who holds the key? Returning to the key.',
                     'utterances': [[1, 0, 18, 'A'], [2, 19, 40, 'B']]}]}
    valid = {'judgment': 'uncertain', 'rationale': 'Synthetic uncertainty', 'evidence': [
        {'node_id': 'a', 'source_id': 's', 'quote': 'Who holds the key?'},
        {'node_id': 'b', 'source_id': 's', 'quote': 'Returning to the key.'}]}
    rejected = copy.deepcopy(valid)
    rejected['evidence'][1]['quote'] = 'Returning ... key.'
    return request, valid, rejected

class Envelope:
    fingerprint = 'synthetic'
    def __init__(self, output): self.output, self.calls = output, []
    def with_system_prompt(self, prompt): return self
    def validate(self, prompt): assert 'Who holds the key?' in prompt
    def complete_json(self, prompt):
        self.calls.append(json.loads(prompt))
        return SimpleNamespace(data=self.output)

@pytest.mark.asyncio
async def test_repair_preserves_full_source_and_rejected_quote_with_validated_audit():
    request, valid, rejected = fixture()
    before = copy.deepcopy(request)
    selection = {'judgment': 'uncertain', 'rationale': 'Synthetic uncertainty', 'evidence': [
        {'node_id': 'a', 'source_id': 's', 'start_sequence': 1, 'end_sequence': 1},
        {'node_id': 'b', 'source_id': 's', 'start_sequence': 2, 'end_sequence': 2}]}
    envelope = Envelope(selection)
    guards = []
    async def guard(): guards.append(True)
    response, audit = await repair_thread_identity(request, rejected, envelope=envelope, request_guard=guard)
    assert request == before and response == valid
    assert len(envelope.calls) == 1 and len(guards) == 2
    assert audit['request']['rejected_response'] == rejected
    validate_identity_repair(audit, request, response, envelope)
    audit['request']['original_request']['sources'][0]['text'] = 'changed'
    with pytest.raises(ValueError): validate_identity_repair(audit, request, response, envelope)

@pytest.mark.asyncio
@pytest.mark.parametrize('denied', [False, True])
async def test_invalid_or_unauthorized_correction_stays_failed(denied):
    request, _, rejected = fixture()
    envelope = Envelope(rejected)
    async def guard():
        if denied: raise PermissionError('Revoked')
    with pytest.raises((ValueError, PermissionError)):
        await repair_thread_identity(request, rejected, envelope=envelope, request_guard=guard)
    assert len(envelope.calls) == (0 if denied else 1)

@pytest.mark.parametrize('start,end', [(0,1),(2,1),(1,9),(True,1)])
def test_selection_rejects_invalid_source_endpoints(start,end):
    request, _, _ = fixture()
    payload = {'judgment':'uncertain','rationale':'Unclear','evidence':[
        {'node_id':'a','source_id':'s','start_sequence':start,'end_sequence':end}]}
    with pytest.raises(ValueError): materialize_selection(payload,request)

def test_legacy_quote_repair_receipt_still_validates():
    from lct_python_backend.services.transcript.thread_identity_repair import (
        LEGACY_POLICY, packet_for)
    request, valid, rejected = fixture()
    envelope = Envelope(valid)
    audit = {'policy': LEGACY_POLICY, 'inference_policy': envelope.fingerprint,
             'correction_inference_policy': envelope.fingerprint,
             'request': packet_for(request, rejected, LEGACY_POLICY), 'response': valid}
    validate_identity_repair(audit, request, valid, envelope)
    altered = copy.deepcopy(valid)
    altered['evidence'][0]['quote'] = 'Invented quotation'
    audit['response'] = altered
    with pytest.raises(ValueError):
        validate_identity_repair(audit, request, altered, envelope)

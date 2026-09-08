"""Repair intent: one attempt, full evidence, guards, strict output, durable audit.

Never edit source or silently drop invented events. Overflow and revoked consent
must prevent inference; rejected regeneration must remain a failure.
"""
import copy
import json
from types import SimpleNamespace
import pytest
from lct_python_backend.services.transcript.question_review_repair import (
    repair_question_review, validate_question_repair)
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded


def fixture():
    request = {'events': [{'event_id': 'event-0', 'source_id': 'source-0'},
                          {'event_id': 'event-1', 'source_id': 'source-0'}],
               'sources': [{'id': 'source-0', 'text': 'A full source passage.'}],
               'question_id': 'q'}
    valid = {'assessments': [{'event_id': 'event-1', 'scope': 'uncertain',
        'resolution': 'uncertain', 'reason': 'Insufficient support', 'evidence_ids': ['source-0']}]}
    invalid = copy.deepcopy(valid)
    invalid['assessments'][0]['event_id'] = 'event-3'
    return request, valid, invalid


class Envelope:
    fingerprint = 'test-policy'
    def __init__(self, output, *, overflow=False):
        self.output, self.overflow, self.prompts = output, overflow, []
    def with_system_prompt(self, prompt):
        return self
    def validate(self, prompt):
        if self.overflow:
            raise ContextBudgetExceeded('Full request too large')
    def complete_json(self, prompt):
        self.prompts.append(json.loads(prompt))
        return SimpleNamespace(data=self.output)


@pytest.mark.asyncio
async def test_complete_replacement_preserves_evidence_and_revalidatable_audit():
    request, valid, invalid = fixture()
    before = copy.deepcopy(request)
    envelope = Envelope(valid)
    guards = []
    async def guard(): guards.append(True)
    response, audit = await repair_question_review(request, invalid, envelope=envelope, request_guard=guard)
    assert request == before
    assert response == valid
    assert len(envelope.prompts) == 1 and len(guards) == 2
    assert envelope.prompts[0]['original_request'] == before
    assert audit['request']['rejected_response'] == invalid
    validate_question_repair(audit, request, response, envelope)
    audit['request']['original_request']['sources'][0]['text'] = 'changed'
    with pytest.raises(ValueError): validate_question_repair(audit, request, response, envelope)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['overflow', 'consent', 'invalid_output'])
async def test_failed_repair_cannot_produce_accepted_review(failure):
    request, valid, invalid = fixture()
    envelope = Envelope(invalid if failure == 'invalid_output' else valid, overflow=failure == 'overflow')
    async def guard():
        if failure == 'consent': raise PermissionError('Revoked')
    with pytest.raises((ValueError, PermissionError, ContextBudgetExceeded)):
        await repair_question_review(request, invalid, envelope=envelope, request_guard=guard)
    assert len(envelope.prompts) == (1 if failure == 'invalid_output' else 0)


@pytest.mark.asyncio
async def test_valid_response_is_never_regenerated():
    request, valid, _ = fixture()
    envelope = Envelope(valid)
    async def guard(): pass
    with pytest.raises(ValueError, match='must not be regenerated'):
        await repair_question_review(request, valid, envelope=envelope, request_guard=guard)
    assert not envelope.prompts

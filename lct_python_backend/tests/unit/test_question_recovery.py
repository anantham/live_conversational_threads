"""Bounded correction preserves evidence, identity, budget and consent gates.

No test calls a real model. Assert returned graph or rejected operation, exact
unchanged request source, and request counts rather than helper call names.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.question_recovery import generate_with_question_recovery
from lct_python_backend.services.transcript.question_memory import UnknownQuestionUpdate
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded


def node(*actions):
    return {'id': 'n', 'question_updates': [
        {'question_id': 'q', 'action': action, 'wording': 'Who keeps it?',
         'rationale': 'Explicit source', 'evidence_quote': 'Who keeps it?'} for action in actions]}


class Envelope:
    def __init__(self, responses, *, overflow=False):
        self.responses = responses
        self.requests = []
        self.overflow = overflow

    def validate(self, request):
        if self.overflow and 'validation_feedback' in json.loads(request):
            raise ContextBudgetExceeded('Feedback cannot fit')

    def generate(self, request):
        self.requests.append(json.loads(request))
        result = self.responses[len(self.requests) - 1]
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result), 'synthetic-local'


async def run(envelope, **kwargs):
    return await generate_with_question_recovery(envelope=envelope,
        prompt=json.dumps({'current_source_lines': [{'id': 'line-0', 'text': 'Who keeps it?'}]}),
        existing_nodes=[], chunks={}, passage='Who keeps it?', fragments=['Who keeps it?'], **kwargs)


@pytest.mark.asyncio
async def test_valid_output_needs_one_request():
    envelope = Envelope([[node('open')]])
    result, backend = await run(envelope)
    assert result == [node('open')] and backend == 'synthetic-local'
    assert len(envelope.requests) == 1


@pytest.mark.asyncio
async def test_source_backed_opening_recovers_without_mutating_source_or_candidate():
    invalid = [node('answer')]
    envelope = Envelope([invalid, [node('open', 'answer')]])
    guards, notices = [], []
    async def guard():
        guards.append(len(envelope.requests))
    async def notice():
        notices.append('retry')
    result, _ = await run(envelope, guard=guard, on_retry=notice)
    assert result == [node('open', 'answer')]
    assert invalid == [node('answer')]
    assert guards == [0, 1, 1, 2] and notices == ['retry']
    retry = dict(envelope.requests[1])
    feedback = retry.pop('validation_feedback')
    assert retry == envelope.requests[0]
    assert feedback['preserve_question_ids'] == ['q']


@pytest.mark.asyncio
@pytest.mark.parametrize('second, error', [
    ([node('answer')], UnknownQuestionUpdate),
    ([node()], ValueError),
])
async def test_invalid_or_dropped_question_is_not_silently_accepted(second, error):
    envelope = Envelope([[node('answer')], second])
    with pytest.raises(error):
        await run(envelope)
    assert len(envelope.requests) == 2


@pytest.mark.asyncio
async def test_fabricated_opening_evidence_is_rejected():
    invented = node('open', 'answer')
    invented['question_updates'][0]['evidence_quote'] = 'Invented earlier question'
    envelope = Envelope([[node('answer')], [invented]])
    with pytest.raises(ValueError, match='exact source evidence'):
        await run(envelope)
    assert len(envelope.requests) == 2


@pytest.mark.asyncio
async def test_feedback_overflow_does_not_send_second_request():
    envelope = Envelope([[node('answer')]], overflow=True)
    with pytest.raises(ContextBudgetExceeded):
        await run(envelope)
    assert len(envelope.requests) == 1


@pytest.mark.asyncio
async def test_revoked_consent_prevents_correction():
    envelope = Envelope([[node('answer')]])
    calls = 0
    async def guard():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise PermissionError('Consent revoked')
    with pytest.raises(PermissionError):
        await run(envelope, guard=guard)
    assert len(envelope.requests) == 1


@pytest.mark.asyncio
async def test_transport_failure_is_not_a_question_retry():
    envelope = Envelope([RuntimeError('Transport failed')])
    with pytest.raises(RuntimeError):
        await run(envelope)
    assert len(envelope.requests) == 1

"""Intent: recover missing comparisons without relabeling silence or discarding
checked judgments; resume saved attempts and bound no-progress model requests.
"""
import copy
import json
from types import SimpleNamespace
import pytest
from lct_python_backend.services.transcript.inspection_relations import review_inspection_context
from lct_python_backend.tests.unit.test_inspection_relations import fixture


def context():
    source, _ = fixture()
    source['candidates'].append(copy.deepcopy(source['candidates'][0]) | {'id': 'another'})
    return source


def comparison(identity):
    return {'candidate_id': identity, 'status': 'uncertain', 'reason': 'Referent unclear.', 'relations': []}


@pytest.mark.asyncio
async def test_missing_only_retry_preserves_original_context_and_judgments():
    calls = []
    class Envelope:
        fingerprint = 'synthetic'
        def complete_json(self, prompt):
            request = json.loads(prompt)
            calls.append(request)
            return SimpleNamespace(data={'comparisons': [comparison(request['candidates'][0]['id'])]})
    original = context()
    result = await review_inspection_context(json.dumps(original), envelope=Envelope())
    assert [c['id'] for c in calls[1]['candidates']] == ['o1']
    assert calls[1]['candidates'][0] == {**original['candidates'][1], 'id': 'o1'}
    assert calls[1]['focal'] == {**original['focal'], 'id': 'o0'}
    assert [c['candidate_id'] for c in result['comparisons']] == ['earlier', 'another']
    assert result['coverage'] == original['coverage']
    assert len(result['coverage_attempts']) == 2


@pytest.mark.asyncio
async def test_interrupted_recovery_reuses_saved_comparisons():
    saved, calls = {}, []
    async def checkpoint(index, request, response=None):
        if response is not None:
            saved[index] = copy.deepcopy(response)
        return saved.get(index)
    class Envelope:
        fingerprint = 'synthetic'
        interrupt = True
        def complete_json(self, prompt):
            request = json.loads(prompt)
            calls.append([c['id'] for c in request['candidates']])
            if len(calls) == 2 and self.interrupt:
                raise RuntimeError('Synthetic interrupted provider')
            return SimpleNamespace(data={'comparisons': [comparison(request['candidates'][0]['id'])]})
    envelope = Envelope()
    with pytest.raises(RuntimeError, match='interrupted'):
        await review_inspection_context(json.dumps(context()), envelope=envelope, checkpoint=checkpoint)
    envelope.interrupt = False
    result = await review_inspection_context(json.dumps(context()), envelope=envelope, checkpoint=checkpoint)
    assert calls == [['o1', 'o2'], ['o1'], ['o1']]
    assert [c['candidate_id'] for c in saved[0]['comparisons']] == ['earlier']
    assert [c['candidate_id'] for c in result['comparisons']] == ['earlier', 'another']
    assert len(result['comparisons']) == 2


@pytest.mark.asyncio
async def test_empty_outputs_stop_after_bounded_attempts_without_fabrication():
    calls = []
    class Envelope:
        fingerprint = 'synthetic'
        def complete_json(self, prompt):
            calls.append(prompt)
            return SimpleNamespace(data={'comparisons': []})
    with pytest.raises(ValueError, match='coverage incomplete'):
        await review_inspection_context(json.dumps(context()), envelope=Envelope())
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_foreign_comparison_is_not_salvaged_as_partial_success():
    class Envelope:
        fingerprint = 'synthetic'
        def complete_json(self, prompt):
            return SimpleNamespace(data={'comparisons': [comparison('foreign')]})
    with pytest.raises(ValueError, match='unknown'):
        await review_inspection_context(json.dumps(context()), envelope=Envelope())

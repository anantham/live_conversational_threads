"""Avoid hash-copy errors without guessing identity or weakening evidence checks.

Intent: exact bijection, immutable input, unchanged evidence/meaning, rejection
of unknown IDs, and canonical IDs persisted by the public review operation.
"""
import copy
import json
from types import SimpleNamespace
import pytest
from lct_python_backend.services.transcript.relation_identity_transport import encode_observation_ids, decode_observation_ids
from lct_python_backend.services.transcript.inspection_relations import review_inspection_context


def test_exact_transport_does_not_rewrite_quotes_or_source_ids():
    context = {'focal': {'id': 'a'*64, 'source_excerpts': [{'utterance_id': 'o1', 'text': 'o0 is a literal quote'}]},
               'candidates': [{'id': 'b'*64}], 'coverage': {}}
    before = copy.deepcopy(context)
    wire, mapping = encode_observation_ids(context)
    assert [wire['focal']['id'], wire['candidates'][0]['id']] == ['o0', 'o1']
    response = {'candidate_id': 'o1', 'evidence': [{'observation_id': 'o0', 'utterance_id': 'o1', 'quote': 'o0 is a literal quote'}]}
    decoded = decode_observation_ids(response, mapping)
    assert decoded['candidate_id'] == 'b'*64
    assert decoded['evidence'] == [{'observation_id': 'a'*64, 'utterance_id': 'o1', 'quote': 'o0 is a literal quote'}]
    assert context == before and response['candidate_id'] == 'o1'


@pytest.mark.parametrize('bad', ['o2', 'O1', 'b'*64, None, ['o1']])
def test_unknown_ids_are_not_fuzzy_matched(bad):
    with pytest.raises(ValueError, match='unknown request-local'):
        decode_observation_ids({'candidate_id': bad}, {'o0': 'a'*64, 'o1': 'b'*64})


@pytest.mark.asyncio
async def test_public_review_sends_aliases_but_checkpoints_canonical_ids():
    context = {'focal': {'id': 'a'*64}, 'candidates': [{'id': 'b'*64}], 'coverage': {}}
    receipts = []
    class Envelope:
        fingerprint = 'synthetic-alias'
        def complete_json(self, prompt):
            request = json.loads(prompt)
            assert request['focal']['id'] == 'o0'
            return SimpleNamespace(data={'comparisons': [{'candidate_id': request['candidates'][0]['id'],
                'status': 'unrelated', 'reason': 'Synthetic independent subjects.', 'relations': []}]})
    async def checkpoint(attempt, request, response=None):
        assert request == context
        if response is not None:
            receipts.append(response)
        return response
    result = await review_inspection_context(json.dumps(context), envelope=Envelope(), checkpoint=checkpoint)
    assert result['comparisons'][0]['candidate_id'] == 'b'*64
    assert receipts[0]['comparisons'][0]['candidate_id'] == 'b'*64


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', [None, 'quote', 'source', 'node', 'endpoint'])
async def test_related_transport_preserves_direction_and_checks_source_before_checkpoint(fault):
    """A real related response must traverse aliases, evidence and node selection.

    Wrong source, invented quotes, foreign nodes and same-endpoint relations
    must never become saved comparisons merely because aliases are valid.
    """
    from lct_python_backend.tests.unit.test_inspection_relations import fixture
    context, response = fixture()
    for observation in [context['focal'], *context['candidates']]:
        observation['canonical_candidates'] = [{
            'id': 'node-' + observation['id'],
            'utterance_ids': [row['utterance_id'] for row in observation['source_excerpts']]}]
    relation = response['comparisons'][0]['relations'][0]
    relation['node_selections'] = [
        {'observation_id': oid, 'node_id': 'node-' + oid, 'rationale': 'Synthetic source and meaning agree.'}
        for oid in ['later', 'earlier']]
    canonical = copy.deepcopy(response)
    relation['from_observation_id'], relation['to_observation_id'] = 'o0', 'o1'
    response['comparisons'][0]['candidate_id'] = 'o1'
    for rows in [relation['evidence'], relation['node_selections']]:
        for row in rows:
            row['observation_id'] = {'later': 'o0', 'earlier': 'o1'}[row['observation_id']]
    if fault == 'quote': relation['evidence'][0]['quote'] = 'Invented evidence'
    elif fault == 'source': relation['evidence'][0]['utterance_id'] = 'foreign-source'
    elif fault == 'node': relation['node_selections'][0]['node_id'] = 'foreign-node'
    elif fault == 'endpoint': relation['to_observation_id'] = 'o0'
    saved = []
    class Envelope:
        fingerprint = 'synthetic-related-alias'
        def complete_json(self, prompt):
            wire = json.loads(prompt)
            assert wire['focal']['canonical_candidates'] == context['focal']['canonical_candidates']
            return SimpleNamespace(data=copy.deepcopy(response))
    async def checkpoint(attempt, request, result=None):
        assert request == context
        if result is not None:
            saved.append(copy.deepcopy(result))
        return result
    if fault:
        with pytest.raises(ValueError):
            await review_inspection_context(json.dumps(context), envelope=Envelope(), checkpoint=checkpoint)
        assert saved == []
    else:
        result = await review_inspection_context(json.dumps(context), envelope=Envelope(), checkpoint=checkpoint)
        assert saved == [canonical]
        checked = result['comparisons'][0]['relations'][0]
        assert (checked['from_observation_id'], checked['to_observation_id']) == ('later', 'earlier')
        assert {row['node_id'] for row in checked['node_selections']} == {'node-later', 'node-earlier'}
        assert {row['utterance_id'] for row in checked['evidence']} == {'u90', 'u1'}

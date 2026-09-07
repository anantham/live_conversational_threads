"""Test intent: distant candidates retain exact source, and future-informed
inspection prose cannot leak through an old citation. Receipt gaps/tampering
must fail before retrieval. Candidate scores never become semantic edges.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.inspection_context import inspection_index, plan_inspection_context
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded
from lct_python_backend.services.transcript.passage_journal import _hash
from lct_python_backend.services.transcript.source_inspection import validate_inspection
from lct_python_backend.services.transcript.source_inspection_pages import inspection_sources, source_span


def fixture():
    texts = ['Who may borrow the spare key?'] + [f'Unrelated astronomy observation {i}.' for i in range(45)]
    texts += ['Returning to borrowing: making copies is allowed, but lending is still undecided.',
              'A future decision must not enter earlier reasoning.']
    sources = [{'id': f'u{i}', 'sequence_number': i + 1, 'speaker_id': 'A', 'text': text}
               for i, text in enumerate(texts)]
    request = {'target_level': 2, 'sources': sources, 'children': []}
    snapshot = {'request': request, 'input_hash': _hash(request)}
    receipts = []
    for i, source in enumerate(sources):
        span = source_span(source, 0, len(source['text']))
        page = {'page_index': i, 'source_snapshot_hash': _hash(inspection_sources(sources)),
                'offset_unit': 'unicode_codepoints', 'spans': [span]}
        result = validate_inspection({'reviewed_span_ids': [span['span_id']], 'observations': [
            {'kind': 'context', 'text': source['text'],
             'citations': [{'span_id': span['span_id'], 'quote': source['text']}]}]}, page)
        receipts.append({'page': page, 'result': result, 'policy_fingerprint': 'synthetic',
                         'input_hash': snapshot['input_hash']})
    return snapshot, receipts


@pytest.mark.asyncio
async def test_distant_source_is_retrieved_without_future_or_invented_edges():
    snapshot, receipts = fixture()
    before = copy.deepcopy((snapshot, receipts))
    first = receipts[0]['result']['observations'][0]['id']
    focal = receipts[-2]['result']['observations'][0]['id']
    future = receipts[-1]['result']['observations'][0]['id']
    class Retriever:
        async def rank(self, query, documents):
            assert first in documents and future not in documents
            assert 'lending is still undecided' in query
            return {identity: 1 if identity == first else 0 for identity in documents}
    envelope = InferenceEnvelope(system_prompt='Review source-grounded candidates.',
        providers=[{'id': 'local', 'trust_scope': 'owner_private', 'context_tokens': 6000}],
        privacy={'local_llm_ok': True}, output_tokens=512, headroom_tokens=128)
    prompt = await plan_inspection_context(snapshot, receipts, focal_id=focal,
        available_through_sequence=47, envelope=envelope, retriever=Retriever(), max_candidates=1)
    parsed = json.loads(prompt)
    assert parsed['candidates'][0]['id'] == first
    assert parsed['candidates'][0]['source_excerpts'][0]['text'] == 'Who may borrow the spare key?'
    assert parsed['coverage']['omitted_candidates'] == 45
    assert parsed['coverage']['excluded_future_informed_observations'] == 1
    assert not parsed['coverage']['semantic_reconciliation_complete']
    assert 'future decision' not in prompt
    assert (snapshot, receipts) == before
    envelope.validate(prompt)


@pytest.mark.parametrize('fault', ['missing_page', 'altered_quote', 'wrong_source', 'changed_input'])
def test_untrusted_receipts_cannot_supply_reconciliation_evidence(fault):
    snapshot, receipts = fixture()
    if fault == 'missing_page': receipts.pop(20)
    elif fault == 'altered_quote': receipts[0]['result']['observations'][0]['citations'][0]['quote'] = 'invented'
    elif fault == 'wrong_source': receipts[0]['result']['observations'][0]['citations'][0]['utterance_id'] = 'u45'
    else: snapshot['request']['sources'][0]['text'] = 'changed'
    with pytest.raises(ValueError):
        inspection_index(snapshot, receipts)


@pytest.mark.asyncio
async def test_old_quote_from_future_informed_page_is_not_past_only_evidence():
    snapshot, receipts = fixture()
    # Merge the last two spans into one inspected request. Even an observation
    # citing only turn 47 was interpreted with turn 48 available to the model.
    page = receipts[-2]['page']
    page['spans'].extend(receipts[-1]['page']['spans'])
    receipts[-2]['result']['reviewed_span_ids'].extend(receipts[-1]['result']['reviewed_span_ids'])
    receipts[-2]['result']['observations'].extend(receipts[-1]['result']['observations'])
    receipts.pop()
    focal = receipts[-1]['result']['observations'][0]['id']
    with pytest.raises(ValueError, match='beyond the available watermark'):
        await plan_inspection_context(snapshot, receipts, focal_id=focal,
            available_through_sequence=47, envelope=None, retriever=None)


@pytest.mark.asyncio
async def test_focal_overflow_fails_before_any_embedding_call():
    snapshot, receipts = fixture()
    focal = receipts[-2]['result']['observations'][0]['id']
    class Envelope:
        def validate(self, prompt):
            raise ContextBudgetExceeded('Synthetic full-envelope overflow')
    class Retriever:
        async def rank(self, *args):
            pytest.fail('Budget rejection must precede any content-bearing embedding call')
    with pytest.raises(ContextBudgetExceeded):
        await plan_inspection_context(snapshot, receipts, focal_id=focal,
            available_through_sequence=47, envelope=Envelope(), retriever=Retriever())

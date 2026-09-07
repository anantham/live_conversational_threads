"""Test intent for bounded inspection, not a claim of semantic understanding.

- Every Unicode source character is submitted exactly once with original IDs,
  absolute character offsets and attribution; pages are not semantic groups.
- Full serialized messages fit; impossible envelopes fail before inference.
- Missing page acknowledgements and forged/out-of-page quotes reject results.
- Instructions and unrelated platform metadata never become execution policy.
"""
import copy
import json

import pytest

from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded
from lct_python_backend.services.transcript.source_inspection import INSPECTION_PROMPT, validate_inspection
from lct_python_backend.services.transcript.source_inspection_pages import plan_inspection_pages


def envelope(limit=9000):
    return InferenceEnvelope(system_prompt=INSPECTION_PROMPT,
        providers=[{'id': 'synthetic', 'model': 'not-called', 'trust_scope': 'owner_private',
                    'context_tokens': limit}], privacy={'local_llm_ok': True},
        output_tokens=512, headroom_tokens=128)


def sources():
    return [{'id': 'u1', 'sequence_number': 1, 'speaker_id': 'A', 'speaker_revision': 2,
             'text': 'Who holds the key? 🗝️\n' * 600, 'platform_metadata': {'excluded': 'secret'}},
            {'id': 'u2', 'sequence_number': 90, 'speaker_id': 'B', 'text': 'Sam holds it.'}]


def test_oversized_unicode_source_has_exact_gapless_bounded_coverage():
    original = sources()
    before = copy.deepcopy(original)
    admitted = envelope()
    pages = plan_inspection_pages(original, envelope=admitted)
    assert len(pages) > 2
    assert plan_inspection_pages(original, envelope=admitted) == pages
    spans = [span for page in pages for span in page['spans']]
    for source in original:
        parts = [span for span in spans if span['utterance_id'] == source['id']]
        cursor = 0
        for part in parts:
            assert part['start'] == cursor
            assert part['text'] == source['text'][part['start']:part['end']]
            assert part['speaker_id'] == source['speaker_id']
            cursor = part['end']
        assert cursor == len(source['text'])
        assert ''.join(part['text'] for part in parts) == source['text']
    for page in pages:
        admitted.validate(json.dumps(page, ensure_ascii=False, separators=(',', ':')))
    assert 'platform_metadata' not in json.dumps(pages)
    assert 'secret' not in json.dumps(pages)
    assert original == before


def test_changed_attribution_changes_page_identity():
    data = sources()
    first = plan_inspection_pages(data, envelope=envelope())
    data[0]['speaker_id'] = 'corrected-speaker'
    assert plan_inspection_pages(data, envelope=envelope())[0]['source_snapshot_hash'] != first[0]['source_snapshot_hash']


def test_empty_source_is_retained_and_impossible_metadata_fails():
    data = [{'id': 'empty', 'sequence_number': 1, 'text': ''}]
    page = plan_inspection_pages(data, envelope=envelope())[0]
    assert page['spans'][0]['start'] == page['spans'][0]['end'] == 0
    data[0]['speaker_id'] = 'x' * 20000
    with pytest.raises(ContextBudgetExceeded, match='cannot fit'):
        plan_inspection_pages(data, envelope=envelope())


def result(page):
    span = page['spans'][0]
    return {'reviewed_span_ids': [part['span_id'] for part in page['spans']],
            'observations': [{'kind': 'question', 'text': 'Key custody is questioned.',
                'citations': [{'span_id': span['span_id'], 'start': span['start'],
                               'end': span['start'] + 3, 'quote': span['text'][:3]}]}]}


@pytest.mark.parametrize('fault', ['missing_span', 'forged_quote', 'outside_span', 'unknown_span', 'wrong_kind'])
def test_inspection_rejects_unproven_receipts(fault):
    page = plan_inspection_pages(sources(), envelope=envelope())[0]
    payload = result(page)
    citation = payload['observations'][0]['citations'][0]
    if fault == 'missing_span': payload['reviewed_span_ids'] = []
    elif fault == 'forged_quote': citation['quote'] = 'not the source'
    elif fault == 'outside_span': citation['end'] = page['spans'][0]['end'] + 10
    elif fault == 'unknown_span': citation['span_id'] = 'foreign'
    else: payload['observations'][0]['kind'] = 'resolved_thread'
    with pytest.raises(ValueError):
        validate_inspection(payload, page)


def test_valid_result_keeps_source_identity_and_requires_explicit_abstention():
    page = plan_inspection_pages(sources(), envelope=envelope())[0]
    validated = validate_inspection(result(page), page)
    citation = validated['observations'][0]['citations'][0]
    assert citation['utterance_id'] == 'u1' and citation['speaker_revision'] == 2
    empty = {'reviewed_span_ids': [s['span_id'] for s in page['spans']], 'observations': []}
    with pytest.raises(ValueError, match='abstention'):
        validate_inspection(empty, page)
    empty['abstention_reason'] = 'Unable to interpret this passage reliably.'
    assert validate_inspection(empty, page)['abstention_reason'] == empty['abstention_reason']


def test_backend_locates_unique_quotes_but_does_not_guess_repeated_occurrences():
    page = plan_inspection_pages([{'id': 'u1', 'sequence_number': 1,
        'text': 'Wait. Wait. Borrowing is still undecided.'}], envelope=envelope())[0]
    payload = result(page)
    payload['observations'][0]['citations'] = [{'span_id': page['spans'][0]['span_id'],
                                               'quote': 'Borrowing is still undecided.'}]
    citation = validate_inspection(payload, page)['observations'][0]['citations'][0]
    assert citation['start'] == 12 and citation['end'] == len(page['spans'][0]['text'])
    payload['observations'][0]['citations'][0]['quote'] = 'Wait.'
    with pytest.raises(ValueError, match='ambiguous'):
        validate_inspection(payload, page)
    payload['observations'][0]['citations'][0].update(start=6, end=11)
    assert validate_inspection(payload, page)['observations'][0]['citations'][0]['start'] == 6

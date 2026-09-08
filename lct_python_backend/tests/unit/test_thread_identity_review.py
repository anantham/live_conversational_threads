"""Occurrence identity review intent, not a semantic quality oracle.

- A/B/A callbacks can be assessed across different original IDs; same-ID pairs
  can be distinct. The validator never merges or infers transitive identity.
- Both source-backed occurrences must have exact, unambiguous citations.
- Requests retain whole required chunks and original state, or fail full-envelope
  budgeting; source changes invalidate deterministic request/state hashes.
"""
import copy
import json
import pytest

from lct_python_backend.services.transcript.thread_identity_review import (
    THREAD_IDENTITY_REVIEW_PROMPT, build_thread_identity_review, validate_thread_identity_review,
    render_thread_identity_request)
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.conversation_context import ContextBudgetExceeded


def envelope(capacity=16000):
    return InferenceEnvelope(system_prompt=THREAD_IDENTITY_REVIEW_PROMPT,
        providers=[{'id':'local','model':'synthetic','type':'openai_compatible',
                    'base_url':'http://127.0.0.1:11434','trust_scope':'owner_private',
                    'enabled':True,'context_tokens':capacity}],
        privacy={'local_llm_ok':True,'external_llm_ok':False}, output_tokens=100, headroom_tokens=50)


def state():
    texts = ['Who can borrow the key?', 'What time is lunch?', 'Returning to the key: can guests borrow it?']
    return {'nodes':[{'id':str(i),'thread_id':tid,'thread_label':tid,'chunk_id':str(i),
                       'summary':texts[i],'source_excerpt':texts[i]}
                      for i,tid in enumerate(['key','lunch','guest-key'])],
            'chunks':{str(i):v for i,v in enumerate(texts)},
            'utterance_chunk_map':{str(i):[f'u{i}'] for i in range(3)}}


def response(request, judgment='same_inquiry'):
    sources = {s['source_id']:s for s in request['sources']}
    return {'judgment':judgment, 'rationale':'The inquiry concerns who may borrow the same key.',
            'evidence':[{'node_id':n['node_id'],'source_id':n['source_id'],
                         'quote':sources[n['source_id']]['text']} for n in request['nodes']]}


def test_distant_callback_preserves_originals_and_deterministic_identity():
    original = state(); before=copy.deepcopy(original)
    request=build_thread_identity_review(original,['2','0'],envelope=envelope())
    assert request==build_thread_identity_review(original,['0','2'],envelope=envelope())
    result=validate_thread_identity_review(response(request),request)
    assert result['judgment']=='same_inquiry' and result['accepted_for_projection'] is False
    assert result['occurrence_ids']==['0','2']
    assert [n['thread_id'] for n in request['nodes']]==['key','guest-key']
    assert original==before
    changed=copy.deepcopy(original); changed['chunks']['0']+=' Additional context.'
    assert build_thread_identity_review(changed,['0','2'],envelope=envelope())['state_hash']!=request['state_hash']


def test_opaque_uuid_membership_does_not_displace_full_source_from_model_context():
    original = state()
    original['utterance_chunk_map']['0'] = [f'{i:036d}' for i in range(1000)]
    request = build_thread_identity_review(original, ['0','2'], envelope=envelope())
    before = copy.deepcopy(request)
    rendered = json.loads(render_thread_identity_request(request))
    assert request == before
    assert len(request['sources'][0]['utterance_ids']) == 1000
    assert [s['text'] for s in rendered['sources']] == [s['text'] for s in request['sources']]
    assert rendered['nodes'] == request['nodes']
    assert all('utterance_ids' not in s for s in rendered['sources'])
    review = validate_thread_identity_review(response(rendered), request)
    assert review['judgment'] == 'same_inquiry'


def test_speaker_dictionary_exactly_round_trips_rows_without_mutating_canonical_request():
    request = build_thread_identity_review(state(), ['0', '2'], envelope=envelope())
    for source in request['sources']:
        source['utterance_fields'] = ['sequence_number', 'start', 'end', 'speaker_id']
        source['utterances'] = [[3, 0, 8, 'speaker-A'], [4, 9, 15, None], [5, 16, 22, 'speaker-A'],
                                [6, 23, 29, 'speaker-B']]
    before = copy.deepcopy(request)
    rendered = json.loads(render_thread_identity_request(request))
    for original, packed in zip(request['sources'], rendered['sources']):
        assert packed['text'] == original['text']
        assert packed['utterance_fields'] == ['sequence_number', 'start', 'end', 'speaker_index']
        restored = [[*row[:3], packed['speaker_ids'][row[3]]] for row in packed['utterances']]
        assert restored == original['utterances']
    assert request == before


@pytest.mark.parametrize('judgment',['related_distinct','uncertain'])
def test_same_id_does_not_force_equivalence(judgment):
    original=state(); original['nodes'][1]['thread_id']='key'
    request=build_thread_identity_review(original,['0','1'],envelope=envelope())
    result=validate_thread_identity_review(response(request,judgment),request)
    assert result['judgment']==judgment
    assert 'merged_thread_id' not in result


@pytest.mark.parametrize('bad',['missing','foreign_node','foreign_source','wrong_source','forged_quote',
                               'duplicate','extra','invalid_judgment','empty_reason'])
def test_rejects_forged_or_incomplete_review(bad):
    request=build_thread_identity_review(state(),['0','2'],envelope=envelope())
    payload=response(request)
    if bad=='missing': payload['evidence'].pop()
    if bad=='foreign_node': payload['evidence'][0]['node_id']='unknown'
    if bad=='foreign_source': payload['evidence'][0]['source_id']='unknown'
    if bad=='wrong_source': payload['evidence'][0].update(source_id='source-1',quote=request['sources'][1]['text'])
    if bad=='forged_quote': payload['evidence'][0]['quote']='Not actually said'
    if bad=='duplicate': payload['evidence'].append(copy.deepcopy(payload['evidence'][0]))
    if bad=='extra': payload['merge']=True
    if bad=='invalid_judgment': payload['judgment']='merge'
    if bad=='empty_reason': payload['rationale']=' '
    with pytest.raises(ValueError): validate_thread_identity_review(payload,request)


def test_whole_source_or_budget_failure_and_ambiguous_quote():
    original=state(); original['chunks']['0']+=' Who can borrow the key?'
    request=build_thread_identity_review(original,['0','2'],envelope=envelope())
    payload=response(request); payload['evidence'][0]['quote']='Who can borrow the key?'
    with pytest.raises(ValueError): validate_thread_identity_review(payload,request)
    original['chunks']['0']+=' context'*4000
    before=copy.deepcopy(original)
    with pytest.raises(ContextBudgetExceeded): build_thread_identity_review(original,['0','2'],envelope=envelope())
    assert original==before


def test_same_chunk_retains_two_occurrences_and_attribution_warning():
    original=state()
    original['nodes'][2]['chunk_id']='0'
    original['chunks']['0']+=' '+original['chunks']['2']
    original['utterance_chunk_map']['0']=['u0','u2']
    original['nodes'][0].update(attribution_review_required=True,
                                source_attributions=[{'speaker_id':'corrected','utterance_id':'u0'}])
    request=build_thread_identity_review(original,['0','2'],envelope=envelope())
    assert len(request['sources'])==1
    assert request['sources'][0]['utterance_ids']==['u0','u2']
    assert request['nodes'][0]['attribution_review_required'] is True
    assert request['nodes'][0]['source_attributions']==original['nodes'][0]['source_attributions']
    rendered = json.loads(render_thread_identity_request(request))
    assert rendered['sources'][0]['utterance_ids'] == ['u0', 'u2']
    result=validate_thread_identity_review(response(request,'uncertain'),request)
    assert {e['node_id'] for e in result['evidence']}=={'0','2'}


@pytest.mark.parametrize('bad',['same_node','unknown','missing_source','missing_mapping','duplicate_node'])
def test_invalid_source_state_rejected(bad):
    original=state(); ids=['0','2']
    if bad=='same_node': ids=['0','0']
    if bad=='unknown': ids=['0','unknown']
    if bad=='missing_source': del original['chunks']['0']
    if bad=='missing_mapping': del original['utterance_chunk_map']['0']
    if bad=='duplicate_node': original['nodes'].append(copy.deepcopy(original['nodes'][0]))
    with pytest.raises(ValueError): build_thread_identity_review(original,ids,envelope=envelope())

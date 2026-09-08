"""Identity judgments inform bounded memory without rewriting source identities.

Test intent: exact pair annotations reach the planner; unknown occurrence IDs
fail; a whole annotation that cannot fit is omitted with a visible count.
"""
import copy
import json
import pytest
from lct_python_backend.services.transcript.conversation_context import (
    plan_conversation_context, PassageContextPolicy)


def test_candidates_include_wrong_reuse_and_distant_callback_but_are_bounded():
    from lct_python_backend.services.transcript.thread_identity_context import identity_candidates
    nodes = [{'id': f'n{i}', 'thread_id': f't{i}', 'chunk_id': f'c{i}',
              'summary': 'Funding source'} for i in range(8)]
    nodes[-1]['thread_id'] = 't0'
    chunks = {n['chunk_id']: 'source' for n in nodes}
    original = copy.deepcopy(nodes)
    pairs = identity_candidates(nodes, chunks)
    assert len(pairs) == 4
    assert ['n0', 'n7'] in pairs
    assert all('n7' in pair for pair in pairs)
    assert nodes == original


def test_pair_review_is_separate_bounded_memory():
    nodes = [{'id': 'n1', 'thread_id': 'a', 'chunk_id': 'c1', 'summary': 'Funding'},
             {'id': 'n2', 'thread_id': 'b', 'chunk_id': 'c2', 'summary': 'Returning to funding'}]
    original = copy.deepcopy(nodes)
    review = {'pair': ['n1', 'n2'], 'judgment': 'same_inquiry',
              'verification': 'model_reviewed_not_human_verified'}
    plan = plan_conversation_context('Who pays?', nodes, {'c1': 'Funding', 'c2': 'Returning'}, {},
        PassageContextPolicy(10000), thread_identity_reviews=[review])
    payload = json.loads(plan.prompt)
    assert payload['thread_identity_reviews'] == [review]
    assert nodes == original
    assert payload['coverage']['omitted_identity_reviews'] == 0
    assert 'Do not infer transitive identity' in payload['context_contract']


def test_unknown_pair_rejected_and_oversized_review_omitted_whole():
    nodes = [{'id': 'n1', 'thread_id': 'a'}, {'id': 'n2', 'thread_id': 'b'}]
    with pytest.raises(ValueError, match='occurrence'):
        plan_conversation_context('x', nodes, {}, {}, PassageContextPolicy(4000),
            thread_identity_reviews=[{'pair': ['n1', 'missing']}])
    plan = plan_conversation_context('x', nodes, {}, {}, PassageContextPolicy(4000),
        thread_identity_reviews=[{'pair': ['n1', 'n2'], 'reason': 'x' * 5000}])
    payload = json.loads(plan.prompt)
    assert payload['thread_identity_reviews'] == []
    assert payload['coverage']['omitted_identity_reviews'] == 1


@pytest.mark.asyncio
async def test_identity_loader_reaches_actual_next_passage(monkeypatch):
    from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor
    from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
    requests = []
    class Result:
        def __init__(self, data):
            self.data = data
        def backend_label(self):
            return 'synthetic'
    def call(**kwargs):
        request = json.loads(kwargs['messages'][1]['content'])
        requests.append(request)
        return Result({'nodes': [{'node_name': 'Inquiry', 'summary': 'Funding inquiry',
            'semantic_level': 1, 'thread_id': 'funding',
            'source_excerpt': request['current_source_lines'][0]['text']}]})
    async def load(nodes, chunks, mapping):
        if len(nodes) < 2:
            return []
        return [{'pair': [nodes[0]['id'], nodes[1]['id']], 'judgment': 'related_distinct'}]
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', call)
    envelope = InferenceEnvelope(system_prompt='Synthetic',
        providers=[{'id': 'local', 'model': 'synthetic', 'trust_scope': 'owner_private', 'context_tokens': 16000}],
        privacy={'local_llm_ok': True}, output_tokens=1000, headroom_tokens=512)
    processor = TranscriptProcessor(send_update=None, inference_envelope=envelope, thread_identity_loader=load,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0)
    for index, sentence in enumerate(['Who pays?', 'Who approves?', 'Returning to payment.']):
        await processor.handle_final_text(sentence, utterance_id=f'u{index}')
        await processor.flush()
    assert requests[-1]['thread_identity_reviews'][0]['judgment'] == 'related_distinct'
    assert {n['thread_id'] for n in processor.existing_json} == {'funding'}

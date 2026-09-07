"""Review annotations reach the actual next-passage prompt without rewriting events.

Transport and review loader are synthetic; real custody is tested in PostgreSQL.
The full annotation must fit the same serialized budget as source and memory.
"""
import copy
import json
import pytest
from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope


@pytest.mark.asyncio
async def test_next_passage_receives_review_without_overwriting_provisional_history(monkeypatch):
    requests = []
    annotation = {'question_id': 'q', 'reviewed_status': 'open',
                  'verification': 'model_reviewed_not_human_verified',
                  'reason': 'The later anecdote does not answer the original question.'}
    async def load(nodes, chunks, mapping):
        return {'q': copy.deepcopy(annotation)} if nodes else {}
    class Result:
        def __init__(self, data):
            self.data = data
        def backend_label(self):
            return 'synthetic'
    def call(**kwargs):
        request = json.loads(kwargs['messages'][1]['content'])
        requests.append(request)
        node = {'node_name': 'Inquiry', 'summary': 'An open inquiry', 'semantic_level': 1,
                'source_excerpt': request['current_source_lines'][0]['text']}
        if len(requests) == 1:
            node['question_updates'] = [{'question_id': 'q', 'action': 'open', 'wording': 'Who pays?',
                'rationale': 'Explicit inquiry', 'evidence_line_ids': ['line-0']}]
        return Result({'nodes': [node]})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', call)
    envelope = InferenceEnvelope(system_prompt='Synthetic instructions',
        providers=[{'id': 'local', 'model': 'synthetic', 'trust_scope': 'owner_private', 'context_tokens': 16000}],
        privacy={'local_llm_ok': True}, output_tokens=1000, headroom_tokens=512)
    processor = TranscriptProcessor(send_update=None, inference_envelope=envelope, question_review_loader=load,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0)
    await processor.handle_final_text('Who pays?', utterance_id='u1')
    await processor.flush()
    original = copy.deepcopy(processor.existing_json[0]['question_updates'])
    await processor.handle_final_text('Returning to that inquiry.', utterance_id='u2')
    await processor.flush()
    question = requests[-1]['question_memory'][0]
    assert question['review'] == annotation
    assert question['status'] == 'open'
    assert 'not human-verified truth' in requests[-1]['context_contract']
    assert processor.existing_json[0]['question_updates'] == original
    envelope.validate(json.dumps(requests[-1], ensure_ascii=False, separators=(',', ':')))

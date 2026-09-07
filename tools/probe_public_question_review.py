"""Public podcast scope diagnostic over exactly the first two committed passages.

Default readiness only; --run makes one local request. No DB/graph writes,
external provider, source repair, publication or deployment. This selected case
is not a blind benchmark or the full local/frontier comparison.
"""
import argparse
import asyncio
import json
import time
from pathlib import Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.question_review import QUESTION_REVIEW_PROMPT, validate_question_review
from lct_python_backend.services.transcript.question_review_projection import project_question_review
from lct_python_backend.services.transcript.question_review_runner import capture_question_basis, attributed_question_request
from lct_python_backend.services.transcript.source_inspection_runner import check_inference_consent
from tools.replay_public_source_inspection import REPLAY_ID, SHA, verified_public_source, verify_rows


async def main(run=False):
    source = verified_public_source()
    provider = {'id': 'public-question-scope-probe', 'model': 'qwen3.8:27b-mlx',
        'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
        'trust_scope': 'owner_private', 'context_tokens': 32768,
        'timeout_seconds': 600, 'reasoning_effort': 'none'}
    engine = create_async_engine('postgresql+asyncpg://aditya@127.0.0.1:55439/podcast')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions.begin() as db:
            conv = await db.get(Conversation, REPLAY_ID)
            if conv is None or (conv.source_metadata or {}).get('public_source_sha256') != SHA:
                raise ValueError('Exact public source is unavailable')
            scope = dict(conversation_id=str(REPLAY_ID), owner_id=conv.owner_id)
            rows = (await db.execute(select(Utterance).where(Utterance.conversation_id == REPLAY_ID)
                .order_by(Utterance.sequence_number))).scalars().all()
            verify_rows(rows, source)
            await check_inference_consent(db, **scope, providers=[provider])
            basis = await capture_question_basis(db, **scope)
            state = basis['state']
            chunks = list(state['chunks'])[:2]
            if len(chunks) != 2:
                raise ValueError('Two committed passages required')
            state['nodes'] = [node for node in state['nodes'] if node['chunk_id'] in chunks]
            state['chunks'] = {cid: state['chunks'][cid] for cid in chunks}
            state['utterance_chunk_map'] = {cid: state['utterance_chunk_map'][cid] for cid in chunks}
            envelope = InferenceEnvelope(system_prompt=QUESTION_REVIEW_PROMPT, providers=[provider],
                privacy=conv.source_metadata['privacy'], output_tokens=4096, headroom_tokens=512, temperature=0)
            request = attributed_question_request(basis, 'q_childhood_interests', envelope)
        prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
        print(json.dumps({'ready': True, 'run_requested': run, 'events': len(request['events']),
            'passages': len(request['sources']), 'budget_units': envelope.validate(prompt),
            'counter': 'conservative_utf8_bytes'}), flush=True)
        if run:
            result = await asyncio.to_thread(envelope.complete_json, prompt)
            target = Path(__file__).resolve().parents[1] / 'tmp/public-pipeline' / f'question-scope-{time.time_ns()}.json'
            receipt = {'request': request, 'response': result.data, 'source_sha256': SHA,
                'policy_fingerprint': envelope.fingerprint, 'prefix_chunk_ids': chunks,
                'messages': [{'role': 'system', 'content': QUESTION_REVIEW_PROMPT}, {'role': 'user', 'content': prompt}],
                'requested_model': provider['model'], 'reasoning_effort': 'none',
                'served_model': result.model, 'cache_hit': result.cache_hit,
                'prompt_tokens': result.prompt_tokens, 'completion_tokens': result.completion_tokens,
                'finish_reason': result.finish_reason}
            target.write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
            print(json.dumps({'response_saved': str(target)}), flush=True)
            review = validate_question_review(result.data, request)
            projected = project_question_review(request, review)
            print(json.dumps({'validated_assessments': len(review['assessments']),
                'reviewed_status': projected['reviewed_status'], 'accepted_for_publication': False}), flush=True)
    finally:
        await engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    asyncio.run(main(parser.parse_args().run))

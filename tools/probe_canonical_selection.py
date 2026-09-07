"""One public-only local semantic-mapping probe; default is read-only readiness.

Verify pinned source and live rows before inference. No database/graph writes,
no new recipient, no deployment. Diagnostic output is gitignored public data.
"""
import argparse
import asyncio
import json
import time
from pathlib import Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.transcript.canonical_selection import canonical_candidates
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.inspection_relations import RELATION_PROMPT, validate_relation_review
from lct_python_backend.services.transcript.reconciliation_checkpoint import capture_reconciliation, validate_context_source
from lct_python_backend.services.transcript.source_inspection_runner import check_inference_consent
from tools.replay_public_source_inspection import REPLAY_ID, SHA, verified_public_source, verify_rows


async def main(run=False):
    source = verified_public_source()
    root = Path(__file__).resolve().parents[1]
    request = json.loads((root / 'tmp/public-pipeline/inference-1788821644360835000.json').read_text())['request']
    engine = create_async_engine('postgresql+asyncpg://aditya@127.0.0.1:55439/podcast')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = {'id': 'public-canonical-probe', 'model': 'qwen3.8:27b-mlx',
        'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
        'trust_scope': 'owner_private', 'timeout_seconds': 600, 'context_tokens': 32768,
        'reasoning_effort': 'none'}
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
            snapshot = await capture_reconciliation(db, **scope)
            for obs in [request['focal'], *request['candidates']]:
                obs['canonical_candidates'] = canonical_candidates(obs, snapshot['nodes'])
            validate_context_source(request, snapshot)
            envelope = InferenceEnvelope(system_prompt=RELATION_PROMPT, providers=[provider],
                privacy=conv.source_metadata['privacy'], output_tokens=4096, headroom_tokens=512, temperature=0)
        prompt = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
        count = envelope.validate(prompt)
        print(json.dumps({'ready': True, 'run_requested': run, 'budget_units': count,
                          'counter': 'conservative_utf8_bytes', 'candidates': len(request['candidates'])}), flush=True)
        if run:
            result = await asyncio.to_thread(envelope.complete_json, prompt)
            target = root / 'tmp/public-pipeline' / f'canonical-probe-{time.time_ns()}.json'
            target.write_text(json.dumps({'request': request, 'response': result.data,
                'policy_fingerprint': envelope.fingerprint, 'source_sha256': SHA,
                'prompt_tokens': result.prompt_tokens, 'completion_tokens': result.completion_tokens}, ensure_ascii=False), encoding='utf-8')
            print(json.dumps({'response_saved': str(target)}), flush=True)
            checked = validate_relation_review(result.data, request)
            print(json.dumps({'validated_comparisons': len(checked['comparisons']),
                              'accepted_for_publication': False}), flush=True)
    finally:
        await engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    asyncio.run(main(parser.parse_args().run))

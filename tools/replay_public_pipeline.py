"""Public-only full replay in an explicit, already-provisioned isolated database.

Default checks configuration offline. --run inserts exact source and runs shared
stages; --resume verifies immutable owner/source/policy. No schema creation,
installation, publication or deployment. CLI --run is gated until an approved
accurate tokenizer is configured by the host.
"""
import argparse
import asyncio
import json
import time
from unittest.mock import patch
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.services.owner_context import get_current_owner_id
from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.import_pipeline.interleaved_stages import run_interleaved_stages
from tools.replay_public_source_inspection import SHA, verified_public_source
from tools.public_replay_harness import validate_target, replay_identity, ensure_replay, inference_receipt


async def main(run=False, *, database_url, run_id, resume=False,
               count_messages=None, tokenizer_id='utf8_bytes_v1'):
    validate_target(database_url, run_id)
    if run and (not callable(count_messages) or tokenizer_id == 'utf8_bytes_v1' or not tokenizer_id):
        raise ValueError('Fair replay requires an approved accurate message counter; tokenizer installation/host parity is pending')
    source = verified_public_source()
    owner = get_current_owner_id()
    provider = {'id': 'public-local-full-replay', 'model': 'qwen3.8:27b-mlx',
        'embedding_model': 'qwen3-embedding:8b', 'type': 'openai_compatible',
        'base_url': 'http://127.0.0.1:11434', 'trust_scope': 'owner_private',
        'timeout_seconds': 600, 'reasoning_effort': 'none'}
    print(json.dumps({'phase': 'configuration_checked', 'source_sha256': SHA,
        'utterances': len(source), 'run_id': run_id, 'conversation_id': str(replay_identity(run_id)),
        'run_requested': run, 'resume': resume, 'counter_configured': callable(count_messages),
        'database_readiness_verified': False}), flush=True)
    if not run:
        return
    engine = create_async_engine(database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    runtime = InterleavedRuntimeConfig(sessions, {provider['id']: 32768}, (provider['id'],),
                                       temperature=0, count_messages=count_messages, tokenizer_id=tokenizer_id)
    scope = dict(conversation_id=str(replay_identity(run_id)), owner_id=owner,
                 providers=[provider], privacy={'local_llm_ok': True, 'external_llm_ok': False})
    try:
        policy = {'runtime': runtime.build(**scope, send_update=None).interpretation_policy_fingerprint,
                  'reconciliation': runtime.build_reconciliation(**scope).fingerprint,
                  'aggregation': runtime.build_aggregation(**scope).envelope.fingerprint,
                  'question_review': runtime.build_question_review(**scope).envelope.fingerprint}
        async with sessions.begin() as db:
            await ensure_replay(db, run_id=run_id, owner_id=owner, source=source, policy=policy, resume=resume)
        output = Path(__file__).resolve().parents[1] / 'tmp/public-pipeline' / run_id / str(time.time_ns())
        output.mkdir(parents=True, exist_ok=False)
        manifest = {'run_id': run_id, 'source_sha256': SHA, 'policy': policy,
                    'tokenizer_id': tokenizer_id, 'provider': provider, 'context_limit': 32768,
                    'temperature': 0, 'resume': resume, 'accepted_for_publication': False}
        (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        original = InferenceEnvelope.complete_json
        def record_response(envelope, prompt):
            response = original(envelope, prompt)
            target = output / f'inference-{time.time_ns()}.json'
            target.write_text(json.dumps(inference_receipt(envelope, prompt, response),
                                         ensure_ascii=False), encoding='utf-8')
            print(json.dumps({'phase': 'inference_received', 'path': str(target)}), flush=True)
            return response
        with patch.object(InferenceEnvelope, 'complete_json', record_response):
            result = await run_interleaved_stages(runtime=runtime, utterances=source, **scope)
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            exported = await export_threads(scope['conversation_id'], db=db, include_question_reviews=True)
            bundle = json.loads(exported.body)
        target = output / 'local-candidate.threads'
        target.write_text(json.dumps(bundle, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'phase': 'candidate_exported', 'path': str(target), 'result': result,
                          'accepted_for_publication': False}), flush=True)
    finally:
        await engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    asyncio.run(main(args.run, database_url=args.database_url, run_id=args.run_id, resume=args.resume))

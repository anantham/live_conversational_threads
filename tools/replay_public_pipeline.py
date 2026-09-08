"""Public-only full replay in an explicit, already-provisioned isolated database.

Default checks configuration offline. --run inserts exact source and runs shared
stages; --resume verifies immutable owner/source/policy. No schema creation,
installation, publication or deployment. CLI --run requires the explicit
--tokenizer-path option and approved native engine.
"""
import argparse
import asyncio
import json
import os
import time
import uuid
from unittest.mock import patch
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy import text
from lct_python_backend.services.owner_context import get_current_owner_id
from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig, RuntimeBudgets
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.import_pipeline.interleaved_stages import run_interleaved_stages
from tools.replay_public_source_inspection import SHA, verified_public_source
from tools.public_replay_harness import validate_target, replay_identity, ensure_replay, record_inference, require_unicode_database


async def main(run=False, *, database_url, run_id, resume=False,
               count_messages=None, tokenizer_id='utf8_bytes_v1', output_tokens=4096, frontier=False):
    validate_target(database_url, run_id)
    if run and (not callable(count_messages) or tokenizer_id == 'utf8_bytes_v1' or not tokenizer_id):
        raise ValueError('Fair replay requires an approved accurate message counter; tokenizer installation/host parity is pending')
    source = verified_public_source()
    owner = get_current_owner_id()
    provider = {'id': 'public-local-full-replay', 'model': 'qwen3.8:27b-mlx',
        'embedding_model': 'qwen3-embedding:8b', 'type': 'openai_compatible',
        'base_url': 'http://127.0.0.1:11434', 'trust_scope': 'owner_private',
        # Batch evaluation may need longer than ten minutes for a 4096-token
        # completion on this local model. This changes transport patience only.
        'timeout_seconds': 1800, 'reasoning_effort': 'none'}
    embedding_provider = provider
    if frontier:
        from tools.public_frontier_transport import MODEL
        from lct_python_backend.services.egress_guard import assert_local_egress
        if run:
            assert_local_egress('https://chatgpt.com', purpose='approved pinned public podcast replay')
        provider = {'id': 'public-openai-codex', 'model': MODEL, 'type': 'codex_cli',
                    'base_url': 'https://chatgpt.com', 'trust_scope': 'external',
                    'reasoning_effort': 'high'}
        # A common source-planning yardstick, NOT the OpenAI tokenizer or
        # model context-capacity claim. Actual CLI usage is recorded separately.
        tokenizer_id = 'cross_model_reference:' + tokenizer_id
    print(json.dumps({'phase': 'configuration_checked', 'source_sha256': SHA,
        'utterances': len(source), 'run_id': run_id, 'conversation_id': str(replay_identity(run_id)),
        'run_requested': run, 'resume': resume, 'counter_configured': callable(count_messages),
        'database_readiness_verified': False}), flush=True)
    if not run:
        return
    engine = create_async_engine(database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    runtime = InterleavedRuntimeConfig(sessions, {provider['id']: 32768}, (embedding_provider['id'],),
                                       budgets=RuntimeBudgets(output_tokens=output_tokens),
                                       temperature=0, count_messages=count_messages, tokenizer_id=tokenizer_id)
    scope = dict(conversation_id=str(replay_identity(run_id)), owner_id=owner,
                 providers=[provider, embedding_provider] if frontier else [provider],
                 privacy={'local_llm_ok': True, 'external_llm_ok': frontier})
    try:
        async with engine.connect() as connection:
            require_unicode_database(await connection.scalar(text('SHOW server_encoding')))
        policy = {'runtime': runtime.build(**scope, send_update=None).interpretation_policy_fingerprint,
                  'reconciliation': runtime.build_reconciliation(**scope).fingerprint,
                  'aggregation': runtime.build_aggregation(**scope).envelope.fingerprint,
                  'question_review': runtime.build_question_review(**scope).envelope.fingerprint}
        async with sessions.begin() as db:
            await ensure_replay(db, run_id=run_id, owner_id=owner, source=source, policy=policy,
                                resume=resume, external_llm_ok=frontier)
        output = Path(__file__).resolve().parents[1] / 'tmp/public-pipeline' / run_id / str(time.time_ns())
        output.mkdir(parents=True, exist_ok=False)
        manifest = {'run_id': run_id, 'source_sha256': SHA, 'policy': policy,
                    'tokenizer_id': tokenizer_id, 'provider': provider, 'context_limit': 32768,
                    'output_tokens': output_tokens,
                    'temperature': None if frontier else 0, 'resume': resume,
                    'budget_units': 'Qwen reference tokens' if frontier else 'native Qwen tokens',
                    'comparison_limitations': ['Codex-added instructions', 'CLI decoding defaults',
                        'requested model not independently attested'] if frontier else [],
                    'accepted_for_publication': False}
        from lct_python_backend.services.transcript.question_review_repair import POLICY as question_repair_policy
        manifest['question_review_recovery'] = question_repair_policy
        from lct_python_backend.services.transcript.thread_identity_repair import POLICY as identity_repair_policy
        manifest['thread_identity_recovery'] = identity_repair_policy
        (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        original = InferenceEnvelope.complete_json
        if frontier:
            from tools.public_frontier_transport import complete_public_json
            def original(envelope, prompt):
                envelope.validate(prompt)
                result = complete_public_json(envelope._messages(prompt),
                    output / ('codex-' + uuid.uuid4().hex))
                # Bound accepted content in the common reference units. This
                # is not a claim that CLI output generation was capped upstream.
                if count_messages([{'role': 'system', 'content': ''},
                                   {'role': 'user', 'content': json.dumps(result.data, ensure_ascii=False)}]) > output_tokens:
                    raise ValueError('Frontier content exceeds common reference output allowance')
                return result
        def record_response(envelope, prompt):
            response = record_inference(output, envelope, prompt, original)
            print(json.dumps({'phase': 'inference_received', 'directory': str(output)}), flush=True)
            return response
        # Bind the telemetry store to this same isolated target, never an
        # inherited application DB. Restore ambient environment on exit.
        with patch.dict(os.environ, {'DATABASE_URL': database_url}), \
                patch.object(InferenceEnvelope, 'complete_json', record_response):
            result = await run_interleaved_stages(runtime=runtime, utterances=source, **scope)
        from lct_python_backend.share_api import export_threads
        async with sessions() as db:
            exported = await export_threads(scope['conversation_id'], db=db, include_question_reviews=True,
                                            include_thread_identity_reviews=True)
            bundle = json.loads(exported.body)
        target = output / ('frontier-candidate.threads' if frontier else 'local-candidate.threads')
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
    parser.add_argument('--frontier', action='store_true',
                        help='Explicit OpenAI public-only arm; external egress policy must separately permit it')
    parser.add_argument('--output-tokens', type=int, default=4096,
                        help='Explicit output reserve; changing it requires a new replay policy/database')
    parser.add_argument('--tokenizer-path', type=Path, help='Pinned local Qwen tokenizer JSON; enables approved native counting')
    args = parser.parse_args()
    counter = None
    if args.tokenizer_path:
        from urllib.request import urlopen
        from tools.public_replay_counter import build_counter
        with urlopen('http://127.0.0.1:11434/api/version', timeout=5) as response:
            server_version = json.load(response)['version']
        counter = build_counter(args.tokenizer_path, server_version=server_version)
    asyncio.run(main(args.run, database_url=args.database_url, run_id=args.run_id, resume=args.resume,
                    output_tokens=args.output_tokens, frontier=args.frontier,
                    count_messages=counter, tokenizer_id=counter.tokenizer_id if counter else 'utf8_bytes_v1'))

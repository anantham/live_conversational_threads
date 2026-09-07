"""Pinned local replay through the same stages used by opt-in imports.

Default validates readiness only. --run writes graph/checkpoint rows exclusively
in the isolated public replay conversation; any export remains a local candidate.
No configuration mutation, remote model fallback, publication or deployment.
"""
import argparse
import asyncio
import json
import time
from unittest.mock import patch
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance, PipelineArtifact
from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig
from lct_python_backend.services.transcript.source_inspection_runner import STAGE, capture_inspection
from lct_python_backend.services.transcript.inspection_context import inspection_index
from lct_python_backend.services.transcript.passage_journal import _hash
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.import_pipeline.interleaved_stages import run_interleaved_stages
from tools.replay_public_source_inspection import REPLAY_ID, SHA, verified_public_source, verify_rows


async def main(run=False):
    source = verified_public_source()
    engine = create_async_engine('postgresql+asyncpg://aditya@127.0.0.1:55439/podcast')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = {'id': 'public-local-inspection', 'model': 'qwen3.8:27b-mlx',
        'embedding_model': 'qwen3-embedding:8b', 'type': 'openai_compatible',
        'base_url': 'http://127.0.0.1:11434', 'trust_scope': 'owner_private', 'timeout_seconds': 600}
    runtime = InterleavedRuntimeConfig(sessions, {provider['id']: 32768},
                                       (provider['id'],), temperature=0)
    try:
        async with sessions.begin() as db:
            conv = await db.get(Conversation, REPLAY_ID)
            if conv is None or (conv.source_metadata or {}).get('public_source_sha256') != SHA:
                raise ValueError('Exact public replay is unavailable')
            rows = (await db.execute(select(Utterance).where(Utterance.conversation_id == REPLAY_ID)
                                    .order_by(Utterance.sequence_number))).scalars().all()
            verify_rows(rows, source)
            scope = dict(conversation_id=str(REPLAY_ID), owner_id=conv.owner_id,
                         providers=[provider], privacy=conv.source_metadata['privacy'])
            snapshot = await capture_inspection(db, conversation_id=str(REPLAY_ID), owner_id=conv.owner_id)
            artifacts = (await db.execute(select(PipelineArtifact).where(
                PipelineArtifact.conversation_id == REPLAY_ID, PipelineArtifact.stage == STAGE)
                .order_by(PipelineArtifact.stage_index))).scalars().all()
            expected_policy = runtime.build_reconciliation(**scope).inspection.envelope.fingerprint
            if any(_hash(a.artifact_json) != a.content_hash or
                   a.artifact_json['policy_fingerprint'] != expected_policy for a in artifacts):
                raise ValueError('Existing inspection policy or receipt differs; no silent reuse')
            index = inspection_index(snapshot, [a.artifact_json for a in artifacts])
        print(json.dumps({'phase': 'ready', 'source_sha256': SHA, 'utterances': len(source),
            'inspection_pages': len(artifacts), 'observations': len(index['observations']),
            'temperature': 0, 'chat_model': provider['model'], 'embedding_model': provider['embedding_model'],
            'run_requested': run}), flush=True)
        if run:
            original = InferenceEnvelope.complete_json
            output = Path(__file__).resolve().parents[1] / 'tmp' / 'public-pipeline'
            output.mkdir(parents=True, exist_ok=True)
            def record_response(envelope, prompt):
                response = original(envelope, prompt)
                target = output / f'inference-{time.time_ns()}.json'
                target.write_text(json.dumps({'request': json.loads(prompt), 'response': response.data,
                    'policy_fingerprint': envelope.fingerprint}, ensure_ascii=False), encoding='utf-8')
                print(json.dumps({'phase': 'inference_received', 'path': str(target)}), flush=True)
                return response
            # Public-only diagnostic observer; generation and return values are
            # unchanged. Patch is confined to this isolated process/run scope.
            with patch.object(InferenceEnvelope, 'complete_json', record_response):
                result = await run_interleaved_stages(runtime=runtime, utterances=source, **scope)
            from lct_python_backend.share_api import export_threads
            from lct_python_backend.services.transcript.question_review_export import export_question_reviews
            async with sessions() as db:
                exported = await export_threads(str(REPLAY_ID), db=db)
                bundle = json.loads(exported.body)
                bundle['question_reviews'] = await export_question_reviews(db,
                    conversation_id=str(REPLAY_ID), owner_id=scope['owner_id'])
            target = output / 'local-candidate.threads'
            target.write_text(json.dumps(bundle, ensure_ascii=False), encoding='utf-8')
            print(json.dumps({'phase': 'candidate_exported', 'path': str(target), 'result': result,
                              'accepted_for_publication': False}), flush=True)
    finally:
        await engine.dispose()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    asyncio.run(main(parser.parse_args().run))

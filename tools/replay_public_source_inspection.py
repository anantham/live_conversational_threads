"""Exact-source, local-only inspection diagnostic for the approved public podcast.

Hard-pinned artifact digest/database/model. Creates a separate local conversation
only if absent, never replaces source or graph rows. Public model responses are
saved locally for failure analysis. This is not publication or a fair comparison.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.source_inspection import INSPECTION_PROMPT
from lct_python_backend.services.transcript.source_inspection_runner import SourceInspectionRunner

SOURCE = Path('/Users/aditya/Documents/Ongoing Local/threads-podcast-release/tmp/podcast-release/source-preview.threads')
SHA = 'e1c1b6236b3604740d83754823ffbe82dbdc1cd4eee365692b2dcf25f765093f'
REPLAY_ID = uuid.uuid5(uuid.NAMESPACE_URL, f'lct-public-source-inspection:6HmR9IaqM88:{SHA}')
OWNER_SOURCE = uuid.UUID('11a871f3-9c40-4e38-9653-c15688b28f0c')
FIELDS = ('id', 'text', 'sequence_number', 'speaker_id', 'speaker_name', 'speaker_source',
          'speaker_confidence', 'speaker_revision', 'timestamp_start', 'timestamp_end', 'duration_seconds')


def verified_public_source(path=SOURCE):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA:
        raise ValueError('Input is not the exact authorized public podcast artifact')
    return json.loads(raw)['utterances']


def verify_rows(rows, expected):
    if len(rows) != len(expected):
        raise ValueError('Existing replay source count differs; no overwrite permitted')
    for row, source in zip(rows, expected):
        for field in FIELDS:
            value = str(row.id) if field == 'id' else getattr(row, field)
            if value != source.get(field):
                raise ValueError(f'Existing replay differs in {field}; no overwrite permitted')


async def main():
    sources = verified_public_source()
    engine = create_async_engine('postgresql+asyncpg://aditya@127.0.0.1:55439/podcast')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions.begin() as db:
            owner_source = await db.get(Conversation, OWNER_SOURCE)
            if owner_source is None or owner_source.deleted_at is not None:
                raise ValueError('Known local replay owner is unavailable')
            owner = owner_source.owner_id
            replay = await db.get(Conversation, REPLAY_ID)
            if replay is None:
                ids = [uuid.UUID(source['id']) for source in sources]
                conflict = (await db.execute(select(Utterance.id).where(Utterance.id.in_(ids)).limit(1))).scalar_one_or_none()
                if conflict is not None:
                    raise ValueError('Original public source IDs already exist; no overwrite permitted')
                db.add(Conversation(id=REPLAY_ID, owner_id=owner,
                    conversation_name='Public podcast: exact-source interleaved inspection diagnostic',
                    conversation_type='transcript', source_type='public_youtube_replay', visibility='private',
                    started_at=datetime.now(timezone.utc), source_metadata={
                        'public_source_sha256': SHA, 'youtube_video_id': '6HmR9IaqM88',
                        'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
                await db.flush()
                for source in sources:
                    values = {field: source.get(field) for field in FIELDS}
                    values['id'] = uuid.UUID(values['id'])
                    db.add(Utterance(conversation_id=REPLAY_ID, **values))
                await db.flush()
            elif replay.owner_id != owner or replay.deleted_at is not None or (replay.source_metadata or {}).get('public_source_sha256') != SHA:
                raise ValueError('Existing replay identity or provenance differs')
            rows = (await db.execute(select(Utterance).where(Utterance.conversation_id == REPLAY_ID)
                                    .order_by(Utterance.sequence_number))).scalars().all()
            verify_rows(rows, sources)
        output = Path(__file__).resolve().parents[1] / 'tmp' / 'public-source-inspection'
        output.mkdir(parents=True, exist_ok=True)
        class RecordedEnvelope(InferenceEnvelope):
            def complete_json(self, prompt):
                page = json.loads(prompt)['page_index']
                print(json.dumps({'phase': 'requesting', 'page': page}), flush=True)
                started = time.monotonic()
                result = super().complete_json(prompt)
                # Generated diagnostic artifact, public source only; never committed.
                target = output / f'page-{page}-{time.time_ns()}.json'
                target.write_text(json.dumps({'prompt': json.loads(prompt), 'response': result.data,
                    'policy_fingerprint': self.fingerprint}, ensure_ascii=False), encoding='utf-8')
                print(json.dumps({'phase': 'response_received', 'page': page,
                    'seconds': round(time.monotonic() - started, 2), 'diagnostic': str(target)}), flush=True)
                return result
        envelope = RecordedEnvelope(system_prompt=INSPECTION_PROMPT,
            providers=[{'id': 'public-local-inspection', 'model': 'qwen3.8:27b-mlx',
                'type': 'openai_compatible', 'base_url': 'http://127.0.0.1:11434',
                'trust_scope': 'owner_private', 'context_tokens': 32768, 'timeout_seconds': 600}],
            privacy={'local_llm_ok': True, 'external_llm_ok': False},
            output_tokens=4096, headroom_tokens=512, temperature=0)
        print(json.dumps({'phase': 'verified_source', 'conversation_id': str(REPLAY_ID),
                         'source_sha256': SHA, 'utterances': len(sources)}), flush=True)
        result = await SourceInspectionRunner(session_factory=sessions, conversation_id=str(REPLAY_ID),
                                              owner_id=owner, envelope=envelope).run()
        print(json.dumps({'phase': 'inspection_complete', 'pages': len(result['receipts']),
                          'submitted_characters': result['submitted_characters'],
                          'abstained_pages': result['abstained_pages']}), flush=True)
    finally:
        await engine.dispose()


if __name__ == '__main__':
    asyncio.run(main())

"""Test intent: subpage interruption preserves completed work and exact coverage.
Real isolated DB; synthetic transport; no graph nodes or source replacement.
"""
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance, PipelineArtifact
from lct_python_backend.services.transcript.source_inspection_runner import SourceInspectionRunner
from lct_python_backend.tests.unit.test_source_inspection import envelope


@pytest.mark.asyncio
async def test_partition_resume_then_complete_page(monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url: pytest.skip('Explicit isolated DB required')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid = uuid.uuid4()
    owner = f'synthetic-partition-{cid}'
    calls = []
    fail = [True]
    def transport(**kwargs):
        p = json.loads(kwargs['messages'][1]['content'])
        calls.append(p['partition_index'])
        if p['partition_index'] == 1 and fail[0]: raise RuntimeError('Synthetic partition failure')
        s = p['spans'][0]
        return SimpleNamespace(data={'reviewed_span_ids': [s['span_id'] for s in p['spans']],
            'observations': [{'kind': 'question', 'text': 'An unresolved inquiry.',
                'citations': [{'span_id': s['span_id'], 'quote': s['text']}]}]})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    runner = SourceInspectionRunner(session_factory=sessions, conversation_id=str(cid), owner_id=owner,
                                    envelope=envelope(), request_span_limit=2)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic partition',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            for i in range(5):
                db.add(Utterance(id=uuid.uuid4(), conversation_id=cid, sequence_number=i,
                                 text=f'Question {i}?', speaker_id='SPEAKER_00'))
        with pytest.raises(RuntimeError, match='partition failure'): await runner.run()
        assert calls == [0, 1]
        async with sessions() as db:
            assert len((await db.execute(select(PipelineArtifact.id).where(PipelineArtifact.conversation_id == cid))).scalars().all()) == 1
        fail[0] = False
        result = await runner.run()
        assert calls == [0, 1, 1, 2]
        assert len(result['receipts']) == 1
        assert len(result['receipts'][0]['partitions']) == 3
        assert len(result['receipts'][0]['result']['reviewed_span_ids']) == 5
        assert result['submitted_characters'] == sum(len(f'Question {i}?') for i in range(5))
        assert await runner.run() == result
        assert calls == [0, 1, 1, 2]
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

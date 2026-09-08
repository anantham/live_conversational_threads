"""Test intent: the shared runtime rechecks persisted consent before generation
and rejects in-flight results after revocation. Source survives for a retry;
restoring only synthetic consent allows one durable graph and journal receipt.
Transport is synthetic; factory, database, processor and commit path are real.
"""
import asyncio
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Node, PipelineArtifact, Utterance
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
from lct_python_backend.services.transcript.interleaved_runtime import build_interleaved_processor


@pytest.mark.asyncio
@pytest.mark.parametrize('revoke_during_request', [False, True])
async def test_revocation_preserves_source_without_publishing_graph(monkeypatch, revoke_during_request):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid = uuid.uuid4(), uuid.uuid4()
    owner = f'synthetic-consent-{cid}'
    text = 'Who is allowed to borrow the key?'
    local = {'id': 'local', 'model': 'synthetic', 'embedding_model': 'synthetic',
             'trust_scope': 'owner_private', 'context_tokens': 32768}
    calls = []
    loop = asyncio.get_running_loop()

    async def consent(allowed):
        async with sessions.begin() as db:
            row = await db.get(Conversation, cid)
            row.source_metadata = {'privacy': {'local_llm_ok': allowed, 'external_llm_ok': False}}

    def transport(**kwargs):
        calls.append(kwargs['providers'])
        if revoke_during_request and len(calls) == 1:
            asyncio.run_coroutine_threadsafe(consent(False), loop).result(timeout=10)
        return SimpleNamespace(data={'nodes': [{'node_name': 'Borrowing question', 'summary': text,
            'semantic_level': 1, 'source_excerpt': text, 'thread_id': 'borrowing',
            'source_line_ids': ['line-0'],
            'thread_label': 'Borrowing', 'thread_state': 'new_thread'}]},
            backend_label=lambda: 'synthetic')

    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic consent test',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1, text=text,
                             speaker_id='SPEAKER_00'))
        processor = build_interleaved_processor(conversation_id=str(cid), owner_id=owner,
            session_factory=sessions, providers=[local], embedding_providers=[local],
            privacy={'local_llm_ok': True}, send_update=None)
        if not revoke_during_request:
            await consent(False)
        await processor.handle_final_text(text, utterance_id=str(uid))
        with pytest.raises(DeploymentPrivacyError):
            await processor.flush()
        assert len(calls) == int(revoke_during_request)
        async with sessions() as db:
            assert not (await db.execute(select(Node.id).where(Node.conversation_id == cid))).scalars().all()
            assert not (await db.execute(select(PipelineArtifact.id).where(PipelineArtifact.conversation_id == cid))).scalars().all()
            assert (await db.get(Utterance, uid)).text == text
        await consent(True)
        await processor.flush()
        async with sessions() as db:
            assert len((await db.execute(select(Node.id).where(Node.conversation_id == cid))).scalars().all()) == 1
            assert len((await db.execute(select(PipelineArtifact.id).where(PipelineArtifact.conversation_id == cid))).scalars().all()) == 1
        assert len(calls) == int(revoke_during_request) + 1
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

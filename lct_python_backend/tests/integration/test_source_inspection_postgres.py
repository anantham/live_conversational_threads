"""Test intent: long-source inspection checkpoints resume across model failure,
preserve exact source, reject stale/foreign-owner results, and create no graph
nodes. Inspection works before graph creation and survives graph-only changes.
Real isolated PostgreSQL; synthetic source and provider transport only.
Correction variant verifies the accepted audit survives a full runner restart.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Node, PipelineArtifact, Utterance
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.deployment_privacy_policy import DeploymentPrivacyError
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.passage_journal import JournalConflict
from lct_python_backend.services.transcript.source_inspection import INSPECTION_PROMPT
from lct_python_backend.services.transcript.source_inspection_pages import plan_inspection_pages
from lct_python_backend.services.transcript.source_inspection_runner import (
    SourceInspectionRunner, checkpoint_inspection, capture_inspection,
)


@pytest.mark.asyncio
@pytest.mark.parametrize('repair_first_page', [False, True])
async def test_long_inspection_restart_and_revision_boundaries(monkeypatch, repair_first_page):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database URL required')
    parsed = urlparse(url)
    assert parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid, nid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner = f'synthetic-inspection-{cid}'
    text = 'Who holds the key? The borrowing rules remain undecided. 🗝️\n' * 400
    calls = []
    corrections = []
    failure = {'page': 1}
    revocation = {'page': None}
    loop = asyncio.get_running_loop()

    async def revoke_consent():
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': False, 'external_llm_ok': False}}

    def transport(**kwargs):
        assert [p['id'] for p in kwargs['providers']] == ['local']
        page = json.loads(kwargs['messages'][1]['content'])
        if 'rejected_observation' in page:
            corrections.append(page['page_index'])
            return SimpleNamespace(data={'span_ids': [page['spans'][0]['span_id']],
                                          'rationale': 'The supplied span states the unresolved borrowing question.'})
        calls.append(page['page_index'])
        if page['page_index'] == failure['page']:
            raise RuntimeError('Synthetic interrupted inspection')
        if page['page_index'] == revocation['page']:
            asyncio.run_coroutine_threadsafe(revoke_consent(), loop).result(timeout=10)
        span = page['spans'][0]
        return SimpleNamespace(data={'reviewed_span_ids': [s['span_id'] for s in page['spans']],
            'observations': [{'kind': 'question', 'text': 'Borrowing remains unresolved.',
                'citations': [{'span_id': span['span_id'], 'start': span['start'],
                    'end': span['end'], 'quote': 'Invalid copied quote' if repair_first_page and page['page_index'] == 0 else span['text']}]}]})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    envelope = InferenceEnvelope(system_prompt=INSPECTION_PROMPT,
        providers=[{'id': 'local', 'model': 'synthetic', 'context_tokens': 9000, 'trust_scope': 'owner_private'},
                   {'id': 'external', 'context_tokens': 9000, 'trust_scope': 'external'}],
        privacy={'local_llm_ok': True, 'external_llm_ok': False}, output_tokens=512, headroom_tokens=128)

    def runner(as_owner=owner):
        return SourceInspectionRunner(session_factory=sessions, conversation_id=str(cid),
                                      owner_id=as_owner, envelope=envelope)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic inspection',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1, text=text, speaker_id='SPEAKER_00'))
        with pytest.raises(PermissionError):
            await runner('wrong-owner').run()
        assert not calls
        legacy_id = uuid.uuid4()
        async with sessions.begin() as db:
            db.add(PipelineArtifact(id=legacy_id, conversation_id=cid, stage='conversation_inspection_l2_v1',
                stage_index=0, artifact_type='synthetic_legacy_receipt', artifact_json={}, content_hash='synthetic'))
        with pytest.raises(JournalConflict, match='Legacy graph-bound'):
            await runner().run()
        assert not calls, 'Old experimental receipts must not silently trigger a new source replay'
        async with sessions.begin() as db:
            await db.execute(delete(PipelineArtifact).where(PipelineArtifact.id == legacy_id, PipelineArtifact.conversation_id == cid))
        with pytest.raises(RuntimeError, match='interrupted inspection'):
            await runner().run()
        assert calls == [0, 1]
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': False, 'external_llm_ok': False}}
        with pytest.raises(DeploymentPrivacyError):
            await runner().run()
        assert calls == [0, 1], 'Revoked stored consent must prevent any further provider request'
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}
        async with sessions() as db:
            saved = (await db.execute(select(PipelineArtifact).where(PipelineArtifact.conversation_id == cid))).scalars().all()
            assert len(saved) == 1 and saved[0].stage_index == 0
            if repair_first_page:
                assert len(saved[0].artifact_json['repair_audit']['corrections']) == 1
                assert corrections == [0]
            snapshot = await capture_inspection(db, conversation_id=str(cid), owner_id=owner)
        pages = plan_inspection_pages(snapshot['request']['sources'], envelope=envelope)
        failure['page'] = None
        revocation['page'] = 1
        with pytest.raises(DeploymentPrivacyError):
            await runner().run()
        async with sessions() as db:
            saved = (await db.execute(select(PipelineArtifact).where(PipelineArtifact.conversation_id == cid))).scalars().all()
            assert len(saved) == 1, 'A result returned after revocation must not become a saved inspection'
        assert calls == [0, 1, 1]
        async with sessions.begin() as db:
            conversation = await db.get(Conversation, cid)
            conversation.source_metadata = {'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}
        revocation['page'] = None
        result = await runner().run()
        assert calls == [0, 1, 1, *range(1, len(pages))]
        assert result['submitted_characters'] == len(text)
        assert not result['semantic_reconciliation_complete']
        assert result['abstained_pages'] == 0
        async with sessions.begin() as db:
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner, append_only=True, commit=False,
                existing_json=[{'id': str(nid), 'semantic_level': 1, 'node_name': 'Borrowing',
                                'summary': 'Borrowing remains open.', 'utterance_ids': [str(uid)]}])
        assert await runner().run() == result
        assert corrections == ([0] if repair_first_page else [])
        assert len(calls) == len(pages) + 2
        async with sessions() as db:
            assert (await db.execute(select(Utterance.text).where(Utterance.id == uid))).scalar_one() == text
            assert (await db.execute(select(Node.id).where(Node.conversation_id == cid))).scalars().all() == [nid]
        async with sessions.begin() as db:
            source = await db.get(Utterance, uid)
            source.speaker_id = 'SPEAKER_01'
            source.speaker_revision = 1
        with pytest.raises(JournalConflict, match='changed'):
            async with sessions.begin() as db:
                await checkpoint_inspection(db, conversation_id=str(cid), owner_id=owner,
                    snapshot=snapshot, page=pages[0], policy_fingerprint=envelope.fingerprint)
        with pytest.raises(JournalConflict, match='revision reconciliation'):
            await runner().run()
        assert len(calls) == len(pages) + 2
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

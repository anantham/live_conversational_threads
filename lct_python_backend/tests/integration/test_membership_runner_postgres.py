"""Test intent: durable membership reviews resume after model interruption.

Use real isolated PostgreSQL and synthetic transport. Preserve source/child IDs,
save each completed review once, reject changed inputs, and create no parents.
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

from lct_python_backend.models import Conversation, Utterance, Node, PipelineArtifact
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.membership_review import MEMBERSHIP_PROMPT
from lct_python_backend.services.transcript.membership_runner import MembershipReviewRunner
from lct_python_backend.services.transcript.passage_journal import JournalConflict


@pytest.mark.asyncio
async def test_resume_review_without_repeating_pages_or_creating_parents(monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid, nid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner = f'synthetic-membership-{cid}'
    text = 'Borrowing remains unresolved. ' * 500
    calls = []
    fail = [True]
    def transport(**kwargs):
        request = json.loads(kwargs['messages'][1]['content'])
        page = request['source_page']
        calls.append(page['page_index'])
        if fail[0] and page['page_index'] == 1:
            raise RuntimeError('Synthetic interrupted review')
        ids = [s['span_id'] for s in page['spans']]
        return SimpleNamespace(data={'reviewed_span_ids': ids, 'judgment': 'supports',
            'rationale': 'The source concerns borrowing.', 'evidence_span_ids': ids})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    envelope = InferenceEnvelope(system_prompt=MEMBERSHIP_PROMPT,
        providers=[{'id': 'local', 'model': 'synthetic', 'trust_scope': 'owner_private', 'context_tokens': 9000}],
        privacy={'local_llm_ok': True}, output_tokens=512, headroom_tokens=128)
    runner = MembershipReviewRunner(session_factory=sessions, conversation_id=str(cid), owner_id=owner, envelope=envelope)
    groups = {'groups': [{'label': 'Borrowing policy', 'rationale': 'Unresolved borrowing inquiry.', 'children_ids': [str(nid)]}]}
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic membership',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1, text=text, speaker_id='SPEAKER_00'))
            await db.flush()
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner, append_only=True, commit=False,
                existing_json=[{'id': str(nid), 'semantic_level': 1, 'node_name': 'Borrowing',
                                'summary': 'Borrowing remains open.', 'utterance_ids': [str(uid)]}])
        with pytest.raises(RuntimeError, match='interrupted'):
            await runner.run(groups, target_level=2)
        assert calls == [0, 1]
        async with sessions() as db:
            assert len((await db.execute(select(PipelineArtifact.id).where(PipelineArtifact.conversation_id == cid))).scalars().all()) == 1
        fail[0] = False
        result = await runner.run(groups, target_level=2)
        assert len(result['receipts']) > 1
        assert calls == [0, 1, *range(1, len(result['receipts']))]
        before = list(calls)
        assert await runner.run(groups, target_level=2) == result
        assert calls == before
        assert result['status'] == 'proposal_reconciliation_required'
        async with sessions.begin() as db:
            assert (await db.execute(select(Node.id).where(Node.conversation_id == cid))).scalars().all() == [nid]
            source = await db.get(Utterance, uid)
            assert source.text == text
            source.text = 'Corrected source.'
        with pytest.raises(JournalConflict):
            await runner.run(groups, target_level=2)
        assert calls == before
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

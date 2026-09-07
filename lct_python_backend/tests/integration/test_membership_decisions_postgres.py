"""Test intent: interrupted final membership judgment reuses saved source reviews.
Use real isolated DB, synthetic transport and unchanged source/child identities.
Uncertain decisions persist without producing a parent or falsely claiming ready.
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

from lct_python_backend.models import Conversation, Utterance, Node
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.membership_review import MEMBERSHIP_PROMPT
from lct_python_backend.services.transcript.membership_runner import MembershipReviewRunner


@pytest.mark.asyncio
@pytest.mark.parametrize('disposition', ['accept', 'reject', 'uncertain'])
async def test_decision_failure_resume_and_uncertainty(monkeypatch, disposition):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url: pytest.skip('Explicit isolated local database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid, nid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner = f'synthetic-decision-{cid}'
    calls = []
    failure = [True]
    def transport(**kwargs):
        r = json.loads(kwargs['messages'][1]['content'])
        if 'reviews' in r:
            calls.append('decision')
            if failure[0]: raise RuntimeError('Synthetic interrupted decision')
            return SimpleNamespace(data={'decision': disposition, 'rationale': 'Source-scoped grouping judgment.',
                'qualifications': 'Borrowing has not been agreed.',
                'reviewed_ids': [p['review_id'] for p in r['reviews']],
                'evidence_ids': [] if disposition == 'uncertain' else [r['reviews'][0]['evidence'][0]['evidence_id']]})
        calls.append('review')
        ids = [s['span_id'] for s in r['source_page']['spans']]
        return SimpleNamespace(data={'reviewed_span_ids': ids, 'evidence_span_ids': ids,
                                     'judgment': 'uncertain', 'rationale': 'Open question.'})
    monkeypatch.setattr('lct_python_backend.services.transcript.inference_envelope.chat_with_provider_fallback_sync', transport)
    envelope = InferenceEnvelope(system_prompt=MEMBERSHIP_PROMPT,
        providers=[{'id': 'local', 'model': 'synthetic', 'trust_scope': 'owner_private', 'context_tokens': 9000}],
        privacy={'local_llm_ok': True}, output_tokens=512, headroom_tokens=128)
    runner = MembershipReviewRunner(session_factory=sessions, conversation_id=str(cid), owner_id=owner, envelope=envelope)
    groups = {'groups': [{'label': 'Borrowing', 'rationale': 'Key discussion', 'children_ids': [str(nid)]}]}
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic decision',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc),
                source_metadata={'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1,
                             text='Who can borrow the key?', speaker_id='SPEAKER_00'))
            await db.flush()
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner, append_only=True, commit=False,
                existing_json=[{'id': str(nid), 'semantic_level': 1, 'node_name': 'Borrowing',
                                'summary': 'An open question.', 'utterance_ids': [str(uid)]}])
        with pytest.raises(RuntimeError, match='interrupted decision'):
            await runner.run_decisions(groups, target_level=2)
        assert calls == ['review', 'decision']
        failure[0] = False
        result = await runner.run_decisions(groups, target_level=2)
        assert result['status'] == ('parent_synthesis_required' if disposition == 'accept' else 'proposal_revision_required')
        assert result['decisions'][0]['result']['decision'] == disposition
        assert calls == ['review', 'decision', 'decision']
        assert await runner.run_decisions(groups, target_level=2) == result
        assert calls == ['review', 'decision', 'decision']
        async with sessions() as db:
            assert (await db.execute(select(Node.id).where(Node.conversation_id == cid))).scalars().all() == [nid]
            assert (await db.get(Utterance, uid)).text == 'Who can borrow the key?'
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

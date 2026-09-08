"""Real commit/restart/export must retain conflicting provisional question events.

Only new random synthetic rows on the isolated local PostgreSQL database.
No model call, migration, original transcript change or production access.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.transcript.passage_journal import append_passage, load_journal, restore_records
from lct_python_backend.services.transcript.question_memory import fold_question_memory
from lct_python_backend.share_api import export_threads


@pytest.mark.asyncio
async def test_conflicting_contribution_survives_real_commit_restart_and_export(monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated database required')
    parsed = urlparse(url)
    assert parsed.hostname in ('127.0.0.1', 'localhost') and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid = uuid.uuid4()
    owner = f'synthetic-question-conflict-{cid}'
    # Exercise authorized export, not the separately tested foreign-owner case.
    monkeypatch.setenv('LCT_OWNER_ID', owner)
    texts = ['Who pays hosting and staffing?', 'A different project was funded.',
             'Hosting is covered, but staffing is undecided.']
    actions = ['open', 'answer', 'partial_answer']
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic conflict',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc)))
        for index, (text, action) in enumerate(zip(texts, actions)):
            uid, chunk, nid = uuid.uuid4(), str(uuid.uuid4()), str(uuid.uuid4())
            async with sessions.begin() as db:
                db.add(Utterance(id=uid, conversation_id=cid, sequence_number=index + 1,
                                 speaker_id='SPEAKER_00', text=text))
                await db.flush()
                await append_passage(db, conversation_id=str(cid), owner_id=owner,
                    expected_revision=index, source_ids=[str(uid)], policy_fingerprint='synthetic-conflict-v1',
                    patch={'nodes': [{'id': nid, 'chunk_id': chunk, 'node_name': 'Contribution',
                        'summary': text, 'semantic_level': 1, 'question_updates': [{'question_id': 'funding',
                        'action': action, 'wording': text, 'evidence_quote': text, 'rationale': 'Synthetic interpretation'}]}],
                        'chunks': {chunk: text}, 'utterance_chunk_map': {chunk: [str(uid)]}})
        async with sessions() as db:
            state = restore_records(await load_journal(db, conversation_id=str(cid), owner_id=owner))
            exported = json.loads((await export_threads(str(cid), db=db)).body)
        memory = fold_question_memory(state['nodes'], state['chunks'])['funding']
        assert memory['status'] == 'uncertain'
        assert memory['latest']['transition_issue'] == 'partial_answer_after_non_open_state'
        assert [n['question_updates'][0]['action'] for n in state['nodes']] == actions
        assert sorted(n['question_updates'][0]['action'] for n in exported['graph_data']) == sorted(actions)
        assert len(exported['utterances']) == 3
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

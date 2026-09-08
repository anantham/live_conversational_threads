"""Legacy replacement must never erase journal-backed interpretation or source.

Test intent: exercise both public writers against synthetic committed passages;
rejection must precede graph, source, and metadata changes. Ordinary nonjournal
replacement remains supported. Uses only random rows in the opt-in local DB.
"""
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance, Node
from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1
from lct_python_backend.services.graph_persistence import persist_graph, persist_turns
from lct_python_backend.services.transcript.passage_journal import append_passage, load_journal, JournalConflict


@pytest.mark.asyncio
@pytest.mark.parametrize('writer', ['graph', 'turns'])
async def test_replacement_rejects_journal_without_mutation(writer, monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database required')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1'} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid, nid, chunk = [uuid.uuid4() for _ in range(4)]
    owner = 'synthetic-replacement-' + str(cid)
    monkeypatch.setenv('LCT_OWNER_ID', owner)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, indrasnet_group_id=str(cid),
                conversation_name='Original synthetic title', conversation_type='transcript',
                source_type='synthetic', started_at=datetime.now(timezone.utc)))
            await db.flush()
            db.add(Utterance(id=uid, conversation_id=cid, sequence_number=1,
                text='Synthetic source.', speaker_id='SPEAKER_00'))
        async with sessions.begin() as db:
            await append_passage(db, conversation_id=str(cid), owner_id=owner, expected_revision=0,
                source_ids=[str(uid)], policy_fingerprint='synthetic-replacement',
                patch={'nodes': [{'id': str(nid), 'chunk_id': str(chunk), 'summary': 'Original interpretation'}],
                    'chunks': {str(chunk): 'Synthetic source.'}, 'utterance_chunk_map': {str(chunk): [str(uid)]}})
        async with sessions() as db:
            with pytest.raises(JournalConflict, match='journal-backed'):
                if writer == 'graph':
                    await persist_graph(db=db, conversation_id=str(cid), owner_id=owner,
                        conversation_name='Replacement', existing_json=[{'id': str(uuid.uuid4()), 'summary': 'Replacement'}],
                        utterances=[{'text': 'Replacement source.', 'speaker_id': 'OTHER'}])
                else:
                    await persist_turns(db=db, payload=RawTurnsPayloadV1(
                        group_id=str(cid), conversation_id=str(cid), owner_id=owner,
                        conversation_name='Replacement', source_type='synthetic',
                        privacy={'redaction_applied': True},
                        turns=[{'seq': 0, 'source_identifier': 'replacement', 'speaker_id': 'OTHER', 'text': 'Replacement source.'}]))
            # Commit even after rejection: guard must not leave pending changes.
            await db.commit()
        async with sessions() as db:
            assert (await db.get(Conversation, cid)).conversation_name == 'Original synthetic title'
            assert (await db.get(Utterance, uid)).text == 'Synthetic source.'
            assert (await db.get(Node, nid)).summary == 'Original interpretation'
            assert len(await load_journal(db, conversation_id=str(cid), owner_id=owner)) == 1
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

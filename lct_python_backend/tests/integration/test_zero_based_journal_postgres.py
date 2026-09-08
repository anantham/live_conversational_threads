"""Intent: import turn zero is neither rejected nor skipped by live backlog.

Real isolated PostgreSQL, original source IDs and append/recovery public APIs;
only this test's random conversation is removed on cleanup.
"""
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance
from lct_python_backend.services.transcript.passage_journal import append_passage, load_journal, restore_records
from lct_python_backend.services.transcript.passage_pump import read_owned_source_page


@pytest.mark.asyncio
async def test_zero_based_source_is_read_committed_and_recovered():
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated database required')
    parsed = urlparse(url)
    assert parsed.hostname == '127.0.0.1' and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, first, second, chunk, node = [uuid.uuid4() for _ in range(5)]
    owner = 'synthetic-zero-' + str(cid)
    scope = dict(conversation_id=str(cid), owner_id=owner)
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name='Synthetic zero-based import',
                conversation_type='transcript', source_type='synthetic', started_at=datetime.now(timezone.utc)))
            await db.flush()
            for seq, uid in enumerate((first, second)):
                db.add(Utterance(id=uid, conversation_id=cid, sequence_number=seq,
                    text=f'Exact source {seq}.', speaker_id='S'))
        async with sessions() as db:
            state = restore_records(await load_journal(db, **scope))
        page = await read_owned_source_page(sessions, **scope, after_sequence=state['committed_through'], limit=32)
        assert [row['id'] for row in page] == [str(first), str(second)]
        async with sessions.begin() as db:
            saved = await append_passage(db, **scope, expected_revision=0,
                source_ids=[str(first), str(second)], policy_fingerprint='synthetic-zero',
                patch={'nodes': [{'id': str(node), 'chunk_id': str(chunk), 'summary': 'Both source turns'}],
                       'chunks': {str(chunk): 'Exact source 0. Exact source 1.'},
                       'utterance_chunk_map': {str(chunk): [str(first), str(second)]}})
        async with sessions() as db:
            records = await load_journal(db, **scope)
            assert records == [saved]
            assert [row['sequence_number'] for row in records[0]['sources']] == [0, 1]
            assert restore_records(records)['committed_through'] == 1
        assert await read_owned_source_page(sessions, **scope, after_sequence=1, limit=32) == []
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()

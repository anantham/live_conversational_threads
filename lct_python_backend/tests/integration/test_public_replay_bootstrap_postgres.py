"""Real PostgreSQL acceptance for replay bootstrap without touching saved podcasts.

Intent: exact synthetic IDs/fields survive flush and new ORM sessions; fresh
occupied targets and resume owner/policy/source drift fail without overwrites.
Connection-local TEMP tables copy real columns/defaults/checks/indexes, not FKs.
All work is under an outer rollback; no durable database/schema is created.
This proves SQL/ORM acceptance and savepoint recovery, not process-crash recovery.
"""
import copy
import os
import uuid
from urllib.parse import urlparse

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance
from tools.public_replay_harness import ensure_replay
from tools.replay_public_source_inspection import FIELDS, verify_rows


@pytest.mark.asyncio
async def test_real_postgres_fresh_and_resume_are_source_exact_and_non_overwriting():
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated loopback test database required')
    parsed = urlparse(url)
    assert parsed.hostname == '127.0.0.1' and parsed.port == 55439 and not parsed.query
    engine = create_async_engine(url)
    run_id = 'synthetic-' + uuid.uuid4().hex
    owner = 'synthetic-owner-' + uuid.uuid4().hex
    source = []
    for index in range(2):
        row = {field: None for field in FIELDS}
        row.update(id=str(uuid.uuid4()), text=f'Synthetic replay statement {index}.',
                   sequence_number=index + 1, speaker_id=f'synthetic-speaker-{index}',
                   speaker_name=f'Synthetic speaker {index}', speaker_source='manual',
                   speaker_confidence=1.0, speaker_revision=0,
                   timestamp_start=float(index * 10), timestamp_end=float(index * 10 + 5),
                   duration_seconds=5.0)
        source.append(row)
    policy = {'tokenizer_id': 'synthetic-native-counter-v1', 'runtime': 'synthetic-policy-v1'}
    args = dict(run_id=run_id, owner_id=owner, source=source, policy=policy)
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                # Only static known table names occur in this DDL. PostgreSQL
                # puts TEMP tables in connection-private pg_temp before public.
                for table in ('conversations', 'utterances', 'nodes', 'pipeline_artifacts'):
                    await connection.execute(text(f'CREATE TEMP TABLE {table} '
                        f'(LIKE public.{table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP'))
                    persistence = (await connection.execute(text(
                        'SELECT relpersistence::text FROM pg_class WHERE oid = to_regclass(:name)'),
                        {'name': table})).scalar_one()
                    assert persistence == 't'
                sessions = async_sessionmaker(connection, expire_on_commit=False,
                                              join_transaction_mode='create_savepoint')
                async with sessions.begin() as db:
                    cid = await ensure_replay(db, **args)

                async def assert_original_unchanged():
                    async with sessions() as db:
                        conversations = (await db.execute(select(Conversation))).scalars().all()
                        assert len(conversations) == 1
                        assert conversations[0].id == cid
                        assert conversations[0].owner_id == owner
                        assert conversations[0].source_metadata['replay_policy'] == policy
                        rows = (await db.execute(select(Utterance).order_by(Utterance.sequence_number))).scalars().all()
                        verify_rows(rows, source)
                        assert all(row.conversation_id == cid for row in rows)

                await assert_original_unchanged()
                async with sessions.begin() as db:
                    assert await ensure_replay(db, **args, resume=True) == cid

                invalid = [
                    ({**args, 'run_id': 'different-' + uuid.uuid4().hex}, False, 'empty'),
                    ({**args, 'owner_id': 'wrong-owner'}, True, 'Resume'),
                    ({**args, 'policy': {'tokenizer_id': 'changed'}}, True, 'Resume'),
                ]
                changed_source = copy.deepcopy(source)
                changed_source[0]['text'] = 'Changed caller source must not replace saved evidence.'
                invalid.append(({**args, 'source': changed_source}, True, 'differs'))
                for candidate, resume, match in invalid:
                    with pytest.raises(ValueError, match=match):
                        async with sessions.begin() as db:
                            await ensure_replay(db, **candidate, resume=resume)
                    await assert_original_unchanged()
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()

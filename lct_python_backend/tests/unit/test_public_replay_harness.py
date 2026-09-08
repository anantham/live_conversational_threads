"""Test intent: a fair replay cannot mutate old/nonlocal databases or byte-run.

- Fresh runs preserve source IDs and configured ownership; occupied targets fail.
- Recovery validates exact run policy/source/owner and never overwrites rows.
- Each inference receipt retains exact messages and serving/cache evidence.
- Missing accurate tokenizer stops before database construction or inference.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from tools.public_replay_harness import validate_target, replay_identity, ensure_replay, inference_receipt
from tools.replay_public_pipeline import main


@pytest.mark.parametrize('url', [
    'postgresql+asyncpg://aditya@127.0.0.1:55439/podcast',
    'postgresql+asyncpg://aditya@remote:55439/lct_public_replay_test',
    'postgresql+asyncpg://aditya@localhost:55439/lct_public_replay_test',
    'postgresql+asyncpg://aditya@127.0.0.1:55439/lct_public_replay_test?host=remote',
    'sqlite:///lct_public_replay_test',
])
def test_refuses_unsafe_target(url):
    with pytest.raises(ValueError):
        validate_target(url, 'local-01')


def test_accepts_explicit_isolated_loopback_target():
    validate_target('postgresql+asyncpg://aditya@127.0.0.1:55439/lct_public_replay_test', 'local-01')
    assert replay_identity('local-01') == replay_identity('local-01')
    assert replay_identity('local-01') != replay_identity('local-02')


def test_missing_tokenizer_fails_before_any_database(monkeypatch):
    import tools.replay_public_pipeline as module
    monkeypatch.setattr(module, 'create_async_engine', lambda *a, **k: pytest.fail('database opened'))
    with pytest.raises(ValueError, match='accurate.*counter'):
        asyncio.run(main(run=True, database_url='postgresql+asyncpg://aditya@127.0.0.1:55439/lct_public_replay_test',
                         run_id='local-01'))


class EmptyDB:
    def __init__(self, occupied=None):
        self.added = []
        self.occupied = occupied
        self.flush = AsyncMock()

    async def execute(self, query):
        return SimpleNamespace(scalar_one_or_none=lambda: self.occupied)

    def add(self, item):
        self.added.append(item)


def test_fresh_source_identity_preserved_and_no_source_owner_lookup():
    source = [{'id': '899b2979-a973-489f-aacd-362c62f3a8b0', 'text': 'Synthetic source',
               'sequence_number': 0, 'speaker_id': 'speaker-a'}]
    db = EmptyDB()
    asyncio.run(ensure_replay(db, run_id='test', owner_id='configured-owner', source=source,
                             policy={'tokenizer_id': 'test-v1'}, resume=False))
    conversation, utterance = db.added
    assert conversation.owner_id == 'configured-owner'
    assert str(utterance.id) == source[0]['id']
    assert utterance.text == source[0]['text']
    assert utterance.conversation_id == conversation.id
    assert conversation.source_metadata['privacy'] == {'local_llm_ok': True, 'external_llm_ok': False}


def test_fresh_refuses_occupied_database_without_writes():
    db = EmptyDB(occupied='existing-row')
    with pytest.raises(ValueError, match='empty'):
        asyncio.run(ensure_replay(db, run_id='test', owner_id='owner', source=[], policy={}, resume=False))
    assert db.added == []


def test_receipt_preserves_exact_messages_and_usage():
    messages = [{'role': 'system', 'content': ' Exact\n'}, {'role': 'user', 'content': '{"a":1}'}]
    envelope = SimpleNamespace(_messages=lambda prompt: messages, fingerprint='policy',
        tokenizer_id='native', providers=[{'model': 'model', 'reasoning_effort': 'none'}])
    response = SimpleNamespace(data={'ok': True}, model='served-model', cache_hit=False,
                              prompt_tokens=123, completion_tokens=45, finish_reason='stop')
    receipt = inference_receipt(envelope, '{"a":1}', response)
    assert receipt['messages'] == messages
    assert receipt['prompt_tokens'] == 123
    assert receipt['completion_tokens'] == 45
    assert receipt['cache_hit'] is False
    assert receipt['served_model'] == 'served-model'


class ResumeDB(EmptyDB):
    def __init__(self, conversation, rows):
        super().__init__()
        self.conversation, self.rows = conversation, rows
        self.reads = 0

    async def get(self, model, cid):
        return self.conversation if self.conversation.id == cid else None

    async def execute(self, query):
        self.reads += 1
        if self.reads == 1:
            return SimpleNamespace(scalar_one_or_none=lambda: None)
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: self.rows))


def replay_fixture():
    from tools.replay_public_source_inspection import FIELDS
    source = {field: None for field in FIELDS}
    source.update(id='899b2979-a973-489f-aacd-362c62f3a8b0', text='Synthetic source',
                  sequence_number=0, speaker_id='speaker-a')
    db = EmptyDB()
    asyncio.run(ensure_replay(db, run_id='test', owner_id='owner', source=[source],
                             policy={'tokenizer_id': 'test-v1'}, resume=False))
    return db.added[0], db.added[1:], [source]


def test_exact_resume_reuses_source_without_writing():
    conversation, rows, source = replay_fixture()
    db = ResumeDB(conversation, rows)
    cid = asyncio.run(ensure_replay(db, run_id='test', owner_id='owner', source=source,
                                   policy={'tokenizer_id': 'test-v1'}, resume=True))
    assert cid == conversation.id
    assert db.added == []
    db.flush.assert_not_awaited()


@pytest.mark.parametrize('mutation', ['owner', 'policy', 'source', 'deleted'])
def test_resume_refuses_drift_without_writing(mutation):
    from datetime import datetime, timezone
    conversation, rows, source = replay_fixture()
    if mutation == 'owner':
        conversation.owner_id = 'foreign'
    elif mutation == 'policy':
        conversation.source_metadata['replay_policy'] = {'tokenizer_id': 'old'}
    elif mutation == 'source':
        rows[0].text = 'Altered source'
    else:
        conversation.deleted_at = datetime.now(timezone.utc)
    db = ResumeDB(conversation, rows)
    with pytest.raises(ValueError, match='differs|Resume'):
        asyncio.run(ensure_replay(db, run_id='test', owner_id='owner', source=source,
                                 policy={'tokenizer_id': 'test-v1'}, resume=True))
    assert db.added == []
    db.flush.assert_not_awaited()

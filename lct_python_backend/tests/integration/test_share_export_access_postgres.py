"""HTTP privacy acceptance on an explicitly isolated PostgreSQL database.

Test intent:
- Default and review exports hide foreign/deleted/absent rows identically.
- Share creation cannot mint capabilities for foreign/deleted conversations.
- Soft deletion closes existing public graph and audio capabilities, while a
  live capability remains valid independently of the configured operator owner.
- Bearer authentication is necessary but is not a substitute for ownership.
"""
import os
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend import auth_policy
from lct_python_backend.db_session import get_async_session
from lct_python_backend.middleware import AuthMiddleware
from lct_python_backend.models import Conversation
from lct_python_backend.share_api import router, _sign_audio_url


@pytest_asyncio.fixture
async def access_host(monkeypatch):
    url = os.getenv('PASSAGE_JOURNAL_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit isolated local database URL required')
    parsed = urlparse(url)
    assert parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.port == 55439
    engine = create_async_engine(url, pool_size=1, max_overflow=0)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    owner = f'synthetic-share-access-{uuid.uuid4()}'
    ids = {state: uuid.uuid4() for state in ('live', 'foreign', 'deleted', 'absent')}
    monkeypatch.setenv('LCT_OWNER_ID', owner)
    monkeypatch.setattr(auth_policy, 'AUTH_TOKEN', 'synthetic-access-token')
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(AuthMiddleware)
    async def session_dependency():
        async with sessions() as db:
            yield db
    app.dependency_overrides[get_async_session] = session_dependency
    # This isolated journal database need not have the share migration applied.
    # Mirror that migration in a connection-local temporary table, never changing
    # the durable schema or an existing share table. One pooled connection keeps
    # HTTP requests and assertions on the same disposable table.
    async with engine.begin() as connection:
        await connection.execute(text('''CREATE TEMP TABLE shared_conversation_links (
            token TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
            allowed_emails TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            created_by_email TEXT, revoked_at TIMESTAMP, expires_at TIMESTAMP,
            view_count INTEGER NOT NULL DEFAULT 0, last_viewed_at TIMESTAMP,
            last_viewed_by TEXT)'''))
    async with sessions.begin() as db:
        for state in ('live', 'foreign', 'deleted'):
            db.add(Conversation(id=ids[state], owner_id=owner if state != 'foreign' else owner + '-other',
                conversation_name='synthetic-private-content', conversation_type='transcript',
                started_at=datetime.now(timezone.utc),
                source_type='synthetic', deleted_at=datetime.now(timezone.utc) if state == 'deleted' else None))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            yield client, sessions, ids
    finally:
        async with sessions.begin() as db:
            for cid in ids.values():
                await db.execute(text('DELETE FROM shared_conversation_links WHERE conversation_id = :cid'),
                                 {'cid': str(cid)})
            await db.execute(delete(Conversation).where(Conversation.id.in_(list(ids.values()))))
        await engine.dispose()


AUTH = {'Authorization': 'Bearer synthetic-access-token'}


@pytest.mark.asyncio
@pytest.mark.parametrize('reviews', [False, True])
async def test_export_owner_and_deleted_isolation(access_host, reviews):
    client, _, ids = access_host
    for state in ('foreign', 'deleted', 'absent'):
        result = await client.get(f'/api/conversations/{ids[state]}/threads-export',
                                  params={'include_question_reviews': str(reviews).lower()}, headers=AUTH)
        assert result.status_code == 404, (state, result.status_code)
        assert result.json() == {'detail': 'Conversation not found.'}
    result = await client.get(f'/api/conversations/{ids["live"]}/threads-export',
                              params={'include_question_reviews': str(reviews).lower()}, headers=AUTH)
    assert result.status_code == 200
    assert result.json()['conversation_name'] == 'synthetic-private-content'
    assert ('question_reviews' in result.json()) == reviews


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['foreign', 'deleted', 'absent'])
async def test_share_creation_rejects_inaccessible_conversation(access_host, state):
    client, sessions, ids = access_host
    result = await client.post(f'/api/conversations/{ids[state]}/share', json={}, headers=AUTH)
    async with sessions() as db:
        count = (await db.execute(text('SELECT COUNT(*) FROM shared_conversation_links WHERE conversation_id = :cid'),
                                 {'cid': str(ids[state])})).scalar_one()
    assert (result.status_code, count) == (404, 0)


@pytest.mark.asyncio
async def test_public_capability_rejects_deleted_without_requiring_operator_owner(access_host, monkeypatch):
    client, sessions, ids = access_host
    result = await client.post(f'/api/conversations/{ids["live"]}/share', json={}, headers=AUTH)
    assert result.status_code == 200
    token = result.json()['token']
    monkeypatch.setenv('LCT_OWNER_ID', 'different-configured-operator')
    assert (await client.get(f'/api/share/{token}')).status_code == 200
    async with sessions.begin() as db:
        conversation = (await db.execute(select(Conversation).where(Conversation.id == ids['live']))).scalar_one()
        conversation.deleted_at = datetime.now(timezone.utc)
    result = await client.get(f'/api/share/{token}')
    assert result.status_code == 404
    assert 'synthetic-private-content' not in result.text
    expiry = int(time.time()) + 60
    # A real signature previously issued for the capability must not outlive deletion.
    result = await client.get(f'/api/share/{token}/audio',
                              params={'expires': expiry, 'sig': _sign_audio_url(token, expiry)})
    assert result.status_code == 404
    assert result.json()['detail'] == 'Conversation not found.'


@pytest.mark.asyncio
async def test_owner_routes_require_bearer_auth(access_host):
    client, _, ids = access_host
    for headers in ({}, {'Authorization': 'Bearer wrong'}):
        assert (await client.get(f'/api/conversations/{ids["live"]}/threads-export', headers=headers)).status_code == 401
        assert (await client.post(f'/api/conversations/{ids["live"]}/share', json={}, headers=headers)).status_code == 401

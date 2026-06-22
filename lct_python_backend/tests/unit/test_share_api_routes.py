"""Route-level tests for share_api revoked/expired flows (→410).

fetch_share and fetch_share_audio re-check the share row before serving
content. These tests mock AsyncSession to return controlled rows and
assert the public endpoints refuse revoked or expired shares.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import sys
import time
import types
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

if "lct_python_backend.db_session" not in sys.modules:
    _stub = types.ModuleType("lct_python_backend.db_session")

    async def _dummy_get_async_session():  # pragma: no cover
        yield object()

    _stub.get_async_session = _dummy_get_async_session
    sys.modules["lct_python_backend.db_session"] = _stub

from lct_python_backend.db_session import get_async_session
from lct_python_backend.share_api import _sign_audio_url, router


class _RowResult:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class _ShareRouteSession:
    def __init__(self, row):
        self._row = row

    async def execute(self, _stmt, _params=None, **_kwargs):
        return _RowResult(self._row)

    async def commit(self):
        pass


def _share_row(*, revoked=False, expired=False):
    now = datetime.utcnow()
    return SimpleNamespace(
        token="share-tok",
        conversation_id=str(uuid.uuid4()),
        revoked_at=now if revoked else None,
        expires_at=(now - timedelta(hours=1)) if expired else (now + timedelta(days=7)),
        allowed_emails=None,
    )


@pytest.fixture
def share_client():
    def _build(row):
        app = FastAPI()
        app.include_router(router)
        session = _ShareRouteSession(row)

        async def override():
            yield session

        app.dependency_overrides[get_async_session] = override
        return TestClient(app)

    return _build


def test_fetch_share_revoked_returns_410(share_client):
    client = share_client(_share_row(revoked=True))
    resp = client.get("/api/share/share-tok")
    assert resp.status_code == 410
    assert resp.json()["detail"] == "Share has been revoked."


def test_fetch_share_expired_returns_410(share_client):
    client = share_client(_share_row(expired=True))
    resp = client.get("/api/share/share-tok")
    assert resp.status_code == 410
    assert resp.json()["detail"] == "Share has expired."


def test_fetch_share_audio_revoked_returns_410(share_client):
    row = _share_row(revoked=True)
    client = share_client(row)
    expires_unix = int(time.time()) + 3600
    sig = _sign_audio_url("share-tok", expires_unix)
    resp = client.get(f"/api/share/share-tok/audio?expires={expires_unix}&sig={sig}")
    assert resp.status_code == 410
    assert resp.json()["detail"] == "Share has been revoked."


def test_fetch_share_audio_share_expired_returns_410(share_client):
    row = _share_row(expired=True)
    client = share_client(row)
    expires_unix = int(time.time()) + 3600
    sig = _sign_audio_url("share-tok", expires_unix)
    resp = client.get(f"/api/share/share-tok/audio?expires={expires_unix}&sig={sig}")
    assert resp.status_code == 410
    assert resp.json()["detail"] == "Share has expired."
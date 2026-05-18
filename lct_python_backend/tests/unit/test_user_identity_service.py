"""Tests for user_identity_service — get/set self_contact_id."""

from types import SimpleNamespace

import pytest

from lct_python_backend.services.user_identity_service import (
    ENV_SELF_CONTACT_ID,
    USER_IDENTITY_KEY,
    get_self_contact_id,
    set_self_contact_id,
)


class _ExecuteResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _Session:
    """Minimal stand-in for AsyncSession with one AppSetting row."""

    def __init__(self, row=None):
        self._row = row
        self.commit_calls = 0
        self.added = []

    async def execute(self, _stmt):
        return _ExecuteResult(self._row)

    async def commit(self):
        self.commit_calls += 1

    def add(self, value):
        self.added.append(value)
        self._row = value


@pytest.mark.asyncio
async def test_get_returns_none_when_no_row_and_no_env(monkeypatch):
    monkeypatch.delenv(ENV_SELF_CONTACT_ID, raising=False)
    session = _Session(row=None)
    assert await get_self_contact_id(session) is None


@pytest.mark.asyncio
async def test_get_returns_db_value_when_present(monkeypatch):
    monkeypatch.setenv(ENV_SELF_CONTACT_ID, "env-fallback-id")  # should be ignored
    row = SimpleNamespace(
        value={"self_contact_id": "db-id-123"}, updated_at=None
    )
    session = _Session(row=row)
    assert await get_self_contact_id(session) == "db-id-123"


@pytest.mark.asyncio
async def test_get_falls_back_to_env_when_db_row_missing(monkeypatch):
    monkeypatch.setenv(ENV_SELF_CONTACT_ID, "env-id-456")
    session = _Session(row=None)
    assert await get_self_contact_id(session) == "env-id-456"


@pytest.mark.asyncio
async def test_get_strips_whitespace_in_db_value(monkeypatch):
    monkeypatch.delenv(ENV_SELF_CONTACT_ID, raising=False)
    row = SimpleNamespace(value={"self_contact_id": "  uuid-with-spaces  "}, updated_at=None)
    session = _Session(row=row)
    assert await get_self_contact_id(session) == "uuid-with-spaces"


@pytest.mark.asyncio
async def test_get_ignores_empty_db_value_falls_back_to_env(monkeypatch):
    monkeypatch.setenv(ENV_SELF_CONTACT_ID, "env-id")
    row = SimpleNamespace(value={"self_contact_id": "   "}, updated_at=None)
    session = _Session(row=row)
    assert await get_self_contact_id(session) == "env-id"


@pytest.mark.asyncio
async def test_set_inserts_new_row_when_none_exists():
    session = _Session(row=None)
    saved = await set_self_contact_id(session, "new-id-789")
    assert saved == "new-id-789"
    assert session.commit_calls == 1
    assert len(session.added) == 1
    inserted = session.added[0]
    assert inserted.key == USER_IDENTITY_KEY
    assert inserted.value == {"self_contact_id": "new-id-789"}


@pytest.mark.asyncio
async def test_set_updates_existing_row():
    row = SimpleNamespace(
        value={"self_contact_id": "old-id"}, updated_at=None
    )
    session = _Session(row=row)
    saved = await set_self_contact_id(session, "replacement-id")
    assert saved == "replacement-id"
    assert row.value == {"self_contact_id": "replacement-id"}
    assert row.updated_at is not None
    assert session.commit_calls == 1
    assert session.added == []


@pytest.mark.asyncio
async def test_set_with_none_clears_value():
    row = SimpleNamespace(
        value={"self_contact_id": "some-id"}, updated_at=None
    )
    session = _Session(row=row)
    saved = await set_self_contact_id(session, None)
    assert saved is None
    assert row.value == {"self_contact_id": None}


@pytest.mark.asyncio
async def test_set_normalizes_whitespace_input():
    session = _Session(row=None)
    saved = await set_self_contact_id(session, "  spaced-id  ")
    assert saved == "spaced-id"
    assert session.added[0].value == {"self_contact_id": "spaced-id"}

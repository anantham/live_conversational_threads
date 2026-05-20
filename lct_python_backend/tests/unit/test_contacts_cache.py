"""Tests for services/contacts_cache — the last-known-good cache of
IndrasNet's contact list."""

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import datetime
from types import SimpleNamespace

import pytest

from lct_python_backend.services import contacts_cache
from lct_python_backend.services.contacts_cache import (
    CONTACTS_CACHE_KEY,
    cache_age_seconds,
    is_cache_stale,
    read_contacts_cache,
    refresh_contacts_cache,
    write_contacts_cache,
)


# ---------------------------------------------------------------------------
# Fake AsyncSession
# ---------------------------------------------------------------------------


class _ExecuteResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _Session:
    def __init__(self, row=None):
        self._row = row
        self.commits = 0
        self.added = []

    async def execute(self, _stmt):
        return _ExecuteResult(self._row)

    async def commit(self):
        self.commits += 1

    def add(self, value):
        self.added.append(value)
        self._row = value


class _SessionCtx:
    """Async-context-manager wrapper so a _Session can stand in for
    db_session.get_async_session_context()."""

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *a):
        return False


def _iso(dt):
    return dt.isoformat()


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# read_contacts_cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_returns_none_when_no_row():
    assert await read_contacts_cache(_Session(row=None)) is None


@pytest.mark.asyncio
async def test_read_returns_payload_when_row_present():
    row = SimpleNamespace(
        value={"fetched_at": _iso(_now()), "contacts": [{"contact_id": "c1", "display_name": "A"}]},
        updated_at=None,
    )
    cache = await read_contacts_cache(_Session(row=row))
    assert cache is not None
    assert cache["contacts"][0]["display_name"] == "A"
    assert "fetched_at" in cache


@pytest.mark.asyncio
async def test_read_returns_none_when_value_has_no_contacts_list():
    row = SimpleNamespace(value={"fetched_at": _iso(_now())}, updated_at=None)
    assert await read_contacts_cache(_Session(row=row)) is None


@pytest.mark.asyncio
async def test_read_returns_none_when_value_not_a_dict():
    row = SimpleNamespace(value="garbage", updated_at=None)
    assert await read_contacts_cache(_Session(row=row)) is None


# ---------------------------------------------------------------------------
# cache_age_seconds / is_cache_stale
# ---------------------------------------------------------------------------


def test_age_none_for_missing_cache():
    assert cache_age_seconds(None) is None
    assert cache_age_seconds({}) is None


def test_age_none_for_unparseable_timestamp():
    assert cache_age_seconds({"fetched_at": "not-a-date"}) is None


def test_age_computed_for_recent_cache():
    cache = {"fetched_at": _iso(_now() - datetime.timedelta(seconds=30))}
    age = cache_age_seconds(cache)
    assert age is not None
    assert 25 < age < 60


def test_fresh_cache_is_not_stale():
    cache = {"fetched_at": _iso(_now() - datetime.timedelta(seconds=10))}
    assert is_cache_stale(cache) is False


def test_old_cache_is_stale():
    cache = {"fetched_at": _iso(_now() - datetime.timedelta(hours=2))}
    assert is_cache_stale(cache) is True


def test_missing_or_unparseable_cache_is_stale():
    assert is_cache_stale(None) is True
    assert is_cache_stale({}) is True
    assert is_cache_stale({"fetched_at": "garbage"}) is True


def test_naive_timestamp_treated_as_utc():
    """A fetched_at without tzinfo must not crash the age calc."""
    naive = datetime.datetime.utcnow().isoformat()  # no offset
    age = cache_age_seconds({"fetched_at": naive})
    assert age is not None
    assert age < 60


# ---------------------------------------------------------------------------
# write_contacts_cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_inserts_new_row_when_none_exists():
    session = _Session(row=None)
    await write_contacts_cache(session, [{"contact_id": "c1", "display_name": "A"}])
    assert session.commits == 1
    assert len(session.added) == 1
    inserted = session.added[0]
    assert inserted.key == CONTACTS_CACHE_KEY
    assert inserted.value["contacts"][0]["display_name"] == "A"
    assert "fetched_at" in inserted.value


@pytest.mark.asyncio
async def test_write_updates_existing_row():
    row = SimpleNamespace(
        value={"fetched_at": "old", "contacts": []}, updated_at=None
    )
    session = _Session(row=row)
    await write_contacts_cache(session, [{"contact_id": "c2", "display_name": "B"}])
    assert session.commits == 1
    assert session.added == []  # updated in place, not inserted
    assert row.value["contacts"][0]["display_name"] == "B"
    assert row.value["fetched_at"] != "old"


# ---------------------------------------------------------------------------
# refresh_contacts_cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_writes_cache_on_successful_fetch():
    session = _Session(row=None)

    async def fetch_fn():
        return [{"contact_id": "c1", "display_name": "Fetched"}], None

    ok = await refresh_contacts_cache(
        fetch_fn=fetch_fn, session_factory=lambda: _SessionCtx(session)
    )
    assert ok is True
    assert session.commits == 1
    assert session.added[0].value["contacts"][0]["display_name"] == "Fetched"


@pytest.mark.asyncio
async def test_refresh_keeps_stale_cache_on_fetch_error():
    """An IndrasNet error must NOT overwrite the cache — stale beats empty."""
    session = _Session(row=None)

    async def fetch_fn():
        return [], "ReadTimeout"

    ok = await refresh_contacts_cache(
        fetch_fn=fetch_fn, session_factory=lambda: _SessionCtx(session)
    )
    assert ok is False
    assert session.commits == 0  # cache untouched


@pytest.mark.asyncio
async def test_refresh_keeps_stale_cache_on_empty_fetch():
    """An empty (but error-free) result also must not clobber the cache."""
    session = _Session(row=None)

    async def fetch_fn():
        return [], None

    ok = await refresh_contacts_cache(
        fetch_fn=fetch_fn, session_factory=lambda: _SessionCtx(session)
    )
    assert ok is False
    assert session.commits == 0


@pytest.mark.asyncio
async def test_refresh_swallows_fetch_exception():
    """A raising fetch_fn must not crash the background task."""
    session = _Session(row=None)

    async def fetch_fn():
        raise RuntimeError("boom")

    ok = await refresh_contacts_cache(
        fetch_fn=fetch_fn, session_factory=lambda: _SessionCtx(session)
    )
    assert ok is False
    assert session.commits == 0


@pytest.mark.asyncio
async def test_refresh_skips_when_already_in_progress():
    """If the lock is held, a second refresh returns False without
    stampeding IndrasNet with a duplicate fetch."""
    session = _Session(row=None)
    fetch_calls = []

    async def fetch_fn():
        fetch_calls.append(1)
        return [{"contact_id": "c1", "display_name": "A"}], None

    await contacts_cache._refresh_lock.acquire()
    try:
        ok = await refresh_contacts_cache(
            fetch_fn=fetch_fn, session_factory=lambda: _SessionCtx(session)
        )
    finally:
        contacts_cache._refresh_lock.release()

    assert ok is False
    assert fetch_calls == []  # fetch never even attempted

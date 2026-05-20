"""Last-known-good cache of IndrasNet's contact list.

IndrasNet's /api/contacts is observably slow — 15s+ round trips with
frequent ReadTimeout (see logs/backend.log). The participant picker
must never wait on a live call. This module keeps a cached copy in the
`app_settings` table and serves it instantly; refreshes happen in the
background (stale-while-revalidate).

DB-backed (not in-memory) deliberately: the cache survives a backend
restart, so even a cold backend immediately has the previous
last-known-good list — important because IndrasNet may be down at the
exact moment the backend boots.

The caller injects the actual IndrasNet fetch as `fetch_fn` so this
module has no import dependency on consumption_prayer_api (avoids a
cycle) and stays unit-testable.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Any, Awaitable, Callable, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import AppSetting

logger = logging.getLogger("lct_backend")

CONTACTS_CACHE_KEY = "indrasnet_contacts_cache"
# Older than this → considered stale → a background refresh is kicked off.
# Stale data is still served (better than empty); freshness just decides
# whether to revalidate.
CACHE_TTL_SECONDS = 600  # 10 minutes

# Serializes refreshes so concurrent picker opens don't stampede IndrasNet.
_refresh_lock = asyncio.Lock()
# Hold a reference to in-flight fire-and-forget refresh tasks so the event
# loop doesn't garbage-collect them mid-run.
_pending_tasks: set = set()

# fetch_fn signature: () -> (contacts_list, error_str_or_None)
FetchFn = Callable[[], Awaitable[Tuple[List[dict], Optional[str]]]]


async def read_contacts_cache(db: AsyncSession) -> Optional[dict]:
    """Return the cached payload {fetched_at, contacts} or None if never set."""
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == CONTACTS_CACHE_KEY)
    )
    row = result.scalar_one_or_none()
    if row is None or not isinstance(row.value, dict):
        return None
    contacts = row.value.get("contacts")
    if not isinstance(contacts, list):
        return None
    return {"fetched_at": row.value.get("fetched_at"), "contacts": contacts}


def cache_age_seconds(cache: Optional[dict]) -> Optional[float]:
    """Age of the cache in seconds, or None if missing/unparseable."""
    if not cache:
        return None
    fetched_at = cache.get("fetched_at")
    if not fetched_at:
        return None
    try:
        ts = datetime.datetime.fromisoformat(str(fetched_at))
    except (TypeError, ValueError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    return (now - ts).total_seconds()


def is_cache_stale(cache: Optional[dict]) -> bool:
    """Stale = missing, unparseable timestamp, or older than the TTL."""
    age = cache_age_seconds(cache)
    return age is None or age > CACHE_TTL_SECONDS


async def write_contacts_cache(db: AsyncSession, contacts: List[dict]) -> None:
    """Upsert the cache row with the given contacts + a fresh timestamp."""
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = {"fetched_at": now_iso, "contacts": contacts}

    result = await db.execute(
        select(AppSetting).where(AppSetting.key == CONTACTS_CACHE_KEY)
    )
    row = result.scalar_one_or_none()
    if row is None:
        db.add(AppSetting(key=CONTACTS_CACHE_KEY, value=payload))
    else:
        row.value = payload
        row.updated_at = datetime.datetime.utcnow()
    await db.commit()
    logger.info("[contacts_cache] wrote %d contacts to cache", len(contacts))


async def refresh_contacts_cache(
    *,
    fetch_fn: FetchFn,
    session_factory: Callable[[], Any],
) -> bool:
    """Fetch fresh contacts from IndrasNet and write them to the cache.

    Guarded by `_refresh_lock` — if a refresh is already running, this
    returns False immediately rather than queueing another IndrasNet hit.

    `session_factory` is the async-context-manager session source
    (db_session.get_async_session_context) — the refresh runs on its own
    session because the request that triggered it has likely already
    closed its session by the time the background task runs.

    Returns True only if a non-empty list was fetched and written. An
    empty result or error leaves the existing cache untouched (stale
    data beats no data).
    """
    if _refresh_lock.locked():
        logger.debug("[contacts_cache] refresh already in progress; skipping")
        return False

    async with _refresh_lock:
        try:
            contacts, err = await fetch_fn()
        except Exception:  # noqa: BLE001 — background task must not crash the loop
            logger.exception("[contacts_cache] refresh fetch raised")
            return False

        if err is not None:
            logger.warning("[contacts_cache] refresh failed: %s — keeping stale cache", err)
            return False
        if not contacts:
            logger.warning("[contacts_cache] refresh returned 0 contacts — keeping stale cache")
            return False

        try:
            async with session_factory() as session:
                await write_contacts_cache(session, contacts)
        except Exception:  # noqa: BLE001
            logger.exception("[contacts_cache] failed to persist refreshed cache")
            return False
        return True


def schedule_refresh(fetch_fn: FetchFn, session_factory: Callable[[], Any]) -> None:
    """Fire-and-forget a background refresh. Safe to call from a request
    handler — does not block. No-op effect if a refresh is already running
    (the lock inside refresh_contacts_cache handles that)."""
    task = asyncio.create_task(
        refresh_contacts_cache(fetch_fn=fetch_fn, session_factory=session_factory)
    )
    # Keep a strong ref until the task finishes (asyncio only holds weak refs).
    _pending_tasks.add(task)
    task.add_done_callback(_pending_tasks.discard)

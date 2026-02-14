"""
Bookmark persistence and query operations.

Service layer for bookmark CRUD — keeps the router free of inline DB logic
and eliminates the serialization duplication (previously repeated 5×).
"""

import logging
import uuid
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Bookmark

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_uuid(value: str, field_name: str = "id") -> uuid.UUID:
    """Parse a string to UUID, raising ``ValueError`` with a clear message."""
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"Invalid UUID for {field_name}: {value}") from exc


def serialize_bookmark(bookmark: Bookmark) -> dict:
    """Convert an ORM ``Bookmark`` to a response-compatible dict."""
    return {
        "id": str(bookmark.id),
        "conversation_id": str(bookmark.conversation_id),
        "utterance_ids": (
            [str(uid) for uid in bookmark.utterance_ids]
            if bookmark.utterance_ids
            else None
        ),
        "turn_id": bookmark.turn_id,
        "speaker_id": bookmark.speaker_id,
        "turn_summary": bookmark.turn_summary,
        "full_text": bookmark.full_text,
        "notes": bookmark.notes,
        "created_by": bookmark.created_by,
        "created_at": bookmark.created_at,
        "updated_at": bookmark.updated_at,
    }


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

async def create_bookmark(db: AsyncSession, *, conversation_id: str,
                          utterance_ids: Optional[list[str]] = None,
                          turn_id: Optional[str] = None,
                          speaker_id: Optional[str] = None,
                          turn_summary: Optional[str] = None,
                          full_text: str,
                          notes: Optional[str] = None,
                          created_by: str = "anonymous") -> Bookmark:
    """Create and persist a new bookmark. Returns the refreshed ORM object."""
    conversation_uuid = parse_uuid(conversation_id, "conversation_id")
    utterance_uuids = (
        [parse_uuid(uid, "utterance_id") for uid in utterance_ids]
        if utterance_ids
        else None
    )

    bookmark = Bookmark(
        id=uuid.uuid4(),
        conversation_id=conversation_uuid,
        utterance_ids=utterance_uuids,
        turn_id=turn_id,
        speaker_id=speaker_id,
        turn_summary=turn_summary,
        full_text=full_text,
        notes=notes,
        created_by=created_by,
    )

    db.add(bookmark)
    await db.commit()
    await db.refresh(bookmark)
    logger.info("Bookmark created: %s", bookmark.id)
    return bookmark


async def list_bookmarks(db: AsyncSession, *,
                         created_by: Optional[str] = None) -> list[Bookmark]:
    """Return bookmarks ordered by newest first, optionally filtered by creator."""
    query = select(Bookmark).order_by(Bookmark.created_at.desc())
    if created_by:
        query = query.where(Bookmark.created_by == created_by)
    result = await db.execute(query)
    return list(result.scalars().all())


async def list_conversation_bookmarks(db: AsyncSession,
                                      conversation_id: str) -> list[Bookmark]:
    """Return bookmarks for a specific conversation, newest first."""
    conversation_uuid = parse_uuid(conversation_id, "conversation_id")
    query = (
        select(Bookmark)
        .where(Bookmark.conversation_id == conversation_uuid)
        .order_by(Bookmark.created_at.desc())
    )
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_bookmark_by_id(db: AsyncSession,
                             bookmark_id: str) -> Bookmark:
    """Fetch a single bookmark by ID. Raises ``LookupError`` if not found."""
    bookmark_uuid = parse_uuid(bookmark_id, "bookmark_id")
    query = select(Bookmark).where(Bookmark.id == bookmark_uuid)
    result = await db.execute(query)
    bookmark = result.scalar_one_or_none()
    if bookmark is None:
        raise LookupError(f"Bookmark {bookmark_id} not found")
    return bookmark


async def update_bookmark(db: AsyncSession, bookmark_id: str, *,
                          notes: Optional[str] = None,
                          turn_summary: Optional[str] = None) -> Bookmark:
    """Update mutable fields on a bookmark. Raises ``LookupError`` if not found."""
    bookmark = await get_bookmark_by_id(db, bookmark_id)

    if notes is not None:
        bookmark.notes = notes
    if turn_summary is not None:
        bookmark.turn_summary = turn_summary

    await db.commit()
    await db.refresh(bookmark)
    logger.info("Bookmark updated: %s", bookmark.id)
    return bookmark


async def delete_bookmark(db: AsyncSession, bookmark_id: str) -> None:
    """Delete a bookmark by ID. Raises ``LookupError`` if not found."""
    bookmark_uuid = parse_uuid(bookmark_id, "bookmark_id")
    # Verify existence first
    query = select(Bookmark).where(Bookmark.id == bookmark_uuid)
    result = await db.execute(query)
    if result.scalar_one_or_none() is None:
        raise LookupError(f"Bookmark {bookmark_id} not found")

    await db.execute(delete(Bookmark).where(Bookmark.id == bookmark_uuid))
    await db.commit()
    logger.info("Bookmark deleted: %s", bookmark_id)

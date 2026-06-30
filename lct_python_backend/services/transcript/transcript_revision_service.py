"""Transcript revision service — decision-B review-gated slow-pass flow.

A *revision* is a proposed replacement transcript (as ASR segments) for a
conversation that has already been processed.  The proposal sits as 'pending'
until an operator approves or rejects it.

On approval the segments are written back through the normal utterance +
graph pipeline.  On rejection the row is marked 'rejected' and nothing changes.

Only one pending revision per conversation is allowed at a time; proposing a
new one while one is pending supersedes (rejects) the old one automatically.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("lct_backend")

# ---------------------------------------------------------------------------
# CRUD helpers
# ---------------------------------------------------------------------------

async def get_pending_revisions(
    db: AsyncSession,
    conversation_id: str,
) -> List[Dict[str, Any]]:
    """Return all pending revisions for a conversation, newest first."""
    result = await db.execute(
        text(
            "SELECT id, conversation_id, source, status, "
            "       current_snapshot_utterance_count, created_at, reviewed_at, "
            "       json_array_length(proposed_segments::json) AS segment_count "
            "FROM transcript_revisions "
            "WHERE conversation_id = :cid AND status = 'pending' "
            "ORDER BY created_at DESC"
        ),
        {"cid": conversation_id},
    )
    rows = result.fetchall()
    return [
        {
            "id": row.id,
            "conversation_id": row.conversation_id,
            "source": row.source,
            "status": row.status,
            "segment_count": row.segment_count,
            "current_snapshot_utterance_count": row.current_snapshot_utterance_count,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        }
        for row in rows
    ]


async def get_revision_segments(
    db: AsyncSession,
    revision_id: str,
    conversation_id: str,
) -> Optional[List[Dict[str, Any]]]:
    """Return the full proposed_segments list for a specific revision.

    Separate from get_pending_revisions because segments can be large; callers
    should only fetch them when the operator is actually reviewing.
    """
    result = await db.execute(
        text(
            "SELECT proposed_segments FROM transcript_revisions "
            "WHERE id = :rid AND conversation_id = :cid"
        ),
        {"rid": revision_id, "cid": conversation_id},
    )
    row = result.fetchone()
    if row is None:
        return None
    return row.proposed_segments


async def propose_revision(
    db: AsyncSession,
    *,
    conversation_id: str,
    proposed_segments: List[Dict[str, Any]],
    source: str = "manual",
    current_utterance_count: Optional[int] = None,
) -> str:
    """Create a pending revision.  Any existing pending revisions for the same
    conversation are superseded (rejected) first so there is at most one pending."""
    now = datetime.now(timezone.utc)

    # Supersede stale pending revisions
    await db.execute(
        text(
            "UPDATE transcript_revisions "
            "SET status = 'superseded', reviewed_at = :now "
            "WHERE conversation_id = :cid AND status = 'pending'"
        ),
        {"cid": conversation_id, "now": now},
    )

    revision_id = str(uuid.uuid4())
    await db.execute(
        text(
            "INSERT INTO transcript_revisions "
            "(id, conversation_id, source, proposed_segments, "
            " current_snapshot_utterance_count, status, created_at) "
            "VALUES (:id, :cid, :src, :segs::json, :cnt, 'pending', :now)"
        ),
        {
            "id": revision_id,
            "cid": conversation_id,
            "src": source,
            "segs": __import__("json").dumps(proposed_segments),
            "cnt": current_utterance_count,
            "now": now,
        },
    )
    await db.flush()
    logger.info(
        "[revision] proposed %s for conversation=%s source=%s segments=%d",
        revision_id, conversation_id, source, len(proposed_segments),
    )
    return revision_id


async def reject_revision(
    db: AsyncSession,
    *,
    revision_id: str,
    conversation_id: str,
) -> bool:
    """Mark a pending revision as rejected.  Returns True if a row was updated."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        text(
            "UPDATE transcript_revisions "
            "SET status = 'rejected', reviewed_at = :now "
            "WHERE id = :rid AND conversation_id = :cid AND status = 'pending' "
            "RETURNING id"
        ),
        {"rid": revision_id, "cid": conversation_id, "now": now},
    )
    found = result.fetchone() is not None
    if found:
        await db.flush()
        logger.info("[revision] rejected %s for conversation=%s", revision_id, conversation_id)
    return found


async def mark_revision_approved(
    db: AsyncSession,
    *,
    revision_id: str,
    conversation_id: str,
) -> Optional[List[Dict[str, Any]]]:
    """Mark a pending revision as approved and return its segments.

    Returns the segments list if a pending revision was found, or None if the
    revision doesn't exist / isn't pending (caller should 404 / 409).
    """
    segments = await get_revision_segments(db, revision_id, conversation_id)
    if segments is None:
        return None

    now = datetime.now(timezone.utc)
    result = await db.execute(
        text(
            "UPDATE transcript_revisions "
            "SET status = 'approved', reviewed_at = :now "
            "WHERE id = :rid AND conversation_id = :cid AND status = 'pending' "
            "RETURNING id"
        ),
        {"rid": revision_id, "cid": conversation_id, "now": now},
    )
    if result.fetchone() is None:
        return None  # wasn't pending

    await db.flush()
    logger.info("[revision] approved %s for conversation=%s", revision_id, conversation_id)
    return segments

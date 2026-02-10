"""
Database query helpers for instrumentation aggregation.
"""

from datetime import datetime
from typing import Any, List, Optional, Tuple
import uuid

from sqlalchemy import func, select

from lct_python_backend.models import APICallsLog


def _has_async_execute(db: Any) -> bool:
    return hasattr(db, "execute")


def _coerce_uuid(value: Any) -> uuid.UUID:
    if isinstance(value, uuid.UUID):
        return value
    return uuid.UUID(str(value))


async def fetch_logs_for_period(
    *,
    db: Any,
    period_start: datetime,
    period_end: datetime,
) -> List[Any]:
    if db is None or not _has_async_execute(db):
        return []

    stmt = select(APICallsLog).where(
        APICallsLog.started_at >= period_start,
        APICallsLog.started_at < period_end,
        APICallsLog.status == "success",
    )
    result = await db.execute(stmt)
    return result.scalars().all()


async def fetch_logs_for_conversation(
    *,
    db: Any,
    conversation_id: str,
) -> List[Any]:
    if db is None:
        raise ValueError("Database connection required for conversation cost lookup")
    if not _has_async_execute(db):
        raise ValueError("Database connection does not support async execute")

    conv_uuid = _coerce_uuid(conversation_id)
    stmt = select(APICallsLog).where(
        APICallsLog.conversation_id == conv_uuid,
        APICallsLog.status == "success",
    ).order_by(APICallsLog.started_at)

    result = await db.execute(stmt)
    return result.scalars().all()


async def fetch_top_conversations_by_cost(
    *,
    db: Any,
    limit: int = 10,
    period_start: Optional[datetime] = None,
    period_end: Optional[datetime] = None,
) -> List[Tuple[str, float]]:
    if db is None or not _has_async_execute(db):
        return []

    stmt = (
        select(
            APICallsLog.conversation_id,
            func.sum(APICallsLog.total_cost).label("total_cost"),
        )
        .where(
            APICallsLog.status == "success",
            APICallsLog.conversation_id.isnot(None),
        )
        .group_by(APICallsLog.conversation_id)
        .order_by(func.sum(APICallsLog.total_cost).desc())
        .limit(limit)
    )

    if period_start:
        stmt = stmt.where(APICallsLog.started_at >= period_start)
    if period_end:
        stmt = stmt.where(APICallsLog.started_at < period_end)

    result = await db.execute(stmt)
    rows = result.all()
    return [(str(row.conversation_id), float(row.total_cost)) for row in rows]

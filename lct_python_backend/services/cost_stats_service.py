"""Cost-stat aggregation helpers for fact-check API endpoints."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import desc, select

from lct_python_backend.models import APICallsLog


def parse_time_range_to_start(time_range: str) -> Optional[datetime]:
    now = datetime.now(timezone.utc)
    normalized = (time_range or "7d").strip().lower()
    if normalized == "1d":
        return now - timedelta(days=1)
    if normalized == "7d":
        return now - timedelta(days=7)
    if normalized == "30d":
        return now - timedelta(days=30)
    if normalized == "all":
        return None
    raise HTTPException(status_code=400, detail="Invalid time_range. Use one of: 1d, 7d, 30d, all.")


def aggregate_cost_logs(logs: List[APICallsLog]) -> Dict[str, Any]:
    total_calls = len(logs)
    total_cost = float(sum((log.total_cost or 0.0) for log in logs))
    total_tokens = int(sum((log.total_tokens or 0) for log in logs))
    avg_cost_per_call = (total_cost / total_calls) if total_calls else 0.0
    avg_tokens_per_call = (total_tokens / total_calls) if total_calls else 0.0

    conversations_analyzed = len({str(log.conversation_id) for log in logs if log.conversation_id})

    by_feature: Dict[str, Dict[str, Any]] = {}
    by_model: Dict[str, Dict[str, Any]] = {}

    for log in logs:
        feature_key = str(log.feature or log.endpoint or "unknown")
        feature_stats = by_feature.setdefault(feature_key, {"cost": 0.0, "calls": 0, "tokens": 0})
        feature_stats["cost"] += float(log.total_cost or 0.0)
        feature_stats["calls"] += 1
        feature_stats["tokens"] += int(log.total_tokens or 0)

        model_key = str(log.model or "unknown")
        model_stats = by_model.setdefault(model_key, {"cost": 0.0, "calls": 0, "tokens": 0})
        model_stats["cost"] += float(log.total_cost or 0.0)
        model_stats["calls"] += 1
        model_stats["tokens"] += int(log.total_tokens or 0)

    recent_calls = [
        {
            "timestamp": (log.started_at or datetime.now(timezone.utc)).isoformat(),
            "endpoint": log.endpoint,
            "model": log.model,
            "total_tokens": int(log.total_tokens or 0),
            "cost_usd": float(log.total_cost or 0.0),
            "latency_ms": log.latency_ms,
        }
        for log in logs[:20]
    ]

    return {
        "total_cost": round(total_cost, 6),
        "total_calls": total_calls,
        "total_tokens": total_tokens,
        "avg_cost_per_call": round(avg_cost_per_call, 6),
        "avg_tokens_per_call": round(avg_tokens_per_call, 2),
        "conversations_analyzed": conversations_analyzed,
        "by_feature": by_feature,
        "by_model": by_model,
        "recent_calls": recent_calls,
    }


async def fetch_cost_logs(db, time_range: str) -> List[APICallsLog]:
    period_start = parse_time_range_to_start(time_range)

    stmt = (
        select(APICallsLog)
        .where(APICallsLog.status == "success")
        .order_by(desc(APICallsLog.started_at))
    )
    if period_start is not None:
        stmt = stmt.where(APICallsLog.started_at >= period_start)

    result = await db.execute(stmt)
    return list(result.scalars().all())

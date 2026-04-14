"""Durable Threads observability service."""

from __future__ import annotations

import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Conversation, ThreadSession, ThreadSessionEvent


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_uuid(value: Any) -> uuid.UUID:
    if isinstance(value, uuid.UUID):
        return value
    return uuid.UUID(str(value))


def _coerce_text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _coerce_json_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _trim_context(value: Any, max_chars: int = 4000) -> Any:
    if isinstance(value, str):
        return value if len(value) <= max_chars else f"{value[:max_chars]}…"
    if isinstance(value, dict):
        return {str(key): _trim_context(sub_value, max_chars=max_chars) for key, sub_value in value.items()}
    if isinstance(value, list):
        return [_trim_context(item, max_chars=max_chars) for item in value]
    return value


def _extract_numeric_metrics(metrics: Optional[Dict[str, Any]]) -> Dict[str, float]:
    numeric: Dict[str, float] = {}
    if not isinstance(metrics, dict):
        return numeric
    for key, value in metrics.items():
        if not isinstance(key, str):
            continue
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        numeric[key] = round(parsed, 2)
    return numeric


async def start_thread_session(
    session: AsyncSession,
    *,
    conversation_id: Any,
    session_id: Any,
    owner_id: str,
    entrypoint: str = "live_threads",
    client_metadata: Optional[Dict[str, Any]] = None,
    session_metadata: Optional[Dict[str, Any]] = None,
    stt_provider: Optional[str] = None,
    stt_transport: Optional[str] = None,
    runtime_mode: Optional[str] = None,
) -> ThreadSession:
    session_uuid = _coerce_uuid(session_id)
    conversation_uuid = _coerce_uuid(conversation_id)
    thread_session = await session.get(ThreadSession, session_uuid)
    if thread_session is None:
        thread_session = ThreadSession(
            session_id=session_uuid,
            conversation_id=conversation_uuid,
            owner_id=_coerce_text(owner_id, "anonymous"),
            entrypoint=_coerce_text(entrypoint, "live_threads"),
            status="active",
            client_metadata=_trim_context(_coerce_json_dict(client_metadata)),
            session_metadata=_trim_context(_coerce_json_dict(session_metadata)),
            stt_provider=_coerce_text(stt_provider) or None,
            stt_transport=_coerce_text(stt_transport) or None,
            runtime_mode=_coerce_text(runtime_mode) or None,
        )
        session.add(thread_session)
    else:
        thread_session.status = "active"
        thread_session.ended_at = None
        thread_session.terminal_reason = None
        thread_session.client_metadata = _trim_context(_coerce_json_dict(client_metadata))
        thread_session.session_metadata = _trim_context(
            {**_coerce_json_dict(thread_session.session_metadata), **_coerce_json_dict(session_metadata)}
        )
        thread_session.stt_provider = _coerce_text(stt_provider) or thread_session.stt_provider
        thread_session.stt_transport = _coerce_text(stt_transport) or thread_session.stt_transport
        thread_session.runtime_mode = _coerce_text(runtime_mode) or thread_session.runtime_mode

    await session.flush()
    return thread_session


async def record_thread_event(
    session: AsyncSession,
    *,
    conversation_id: Any,
    session_id: Any,
    stage: str,
    event_type: str,
    level: str = "info",
    code: Optional[str] = None,
    message: str = "",
    context: Optional[Dict[str, Any]] = None,
    metrics: Optional[Dict[str, Any]] = None,
) -> ThreadSessionEvent:
    event = ThreadSessionEvent(
        session_id=_coerce_uuid(session_id),
        conversation_id=_coerce_uuid(conversation_id),
        stage=_coerce_text(stage, "unknown"),
        event_type=_coerce_text(event_type, "event"),
        level=_coerce_text(level, "info"),
        code=_coerce_text(code) or None,
        message=_coerce_text(message) or None,
        context=_trim_context(_coerce_json_dict(context)),
        metrics=_extract_numeric_metrics(metrics),
    )
    session.add(event)
    await session.flush()
    return event


async def finish_thread_session(
    session: AsyncSession,
    *,
    conversation_id: Any,
    session_id: Any,
    status: str,
    terminal_reason: str,
    session_metadata: Optional[Dict[str, Any]] = None,
    stt_provider: Optional[str] = None,
    stt_transport: Optional[str] = None,
    runtime_mode: Optional[str] = None,
) -> Optional[ThreadSession]:
    session_uuid = _coerce_uuid(session_id)
    thread_session = await session.get(ThreadSession, session_uuid)
    if thread_session is None:
        return None

    now = _utcnow()
    thread_session.status = _coerce_text(status, "completed")
    thread_session.terminal_reason = _coerce_text(terminal_reason) or None
    thread_session.ended_at = now
    started_at = thread_session.started_at
    if started_at is not None:
        thread_session.duration_ms = max(0, int((now - started_at).total_seconds() * 1000))
    thread_session.session_metadata = _trim_context(
        {**_coerce_json_dict(thread_session.session_metadata), **_coerce_json_dict(session_metadata)}
    )
    thread_session.stt_provider = _coerce_text(stt_provider) or thread_session.stt_provider
    thread_session.stt_transport = _coerce_text(stt_transport) or thread_session.stt_transport
    thread_session.runtime_mode = _coerce_text(runtime_mode) or thread_session.runtime_mode

    conversation = await session.get(Conversation, _coerce_uuid(conversation_id))
    if conversation is not None:
        conversation.ended_at = now
        if thread_session.duration_ms is not None:
            conversation.duration_seconds = max(0, int(thread_session.duration_ms / 1000))
    await session.flush()
    return thread_session


def _window_start(since_hours: int) -> datetime:
    clamped = min(max(int(since_hours or 24), 1), 24 * 30)
    return _utcnow() - timedelta(hours=clamped)


async def get_threads_observability_summary(
    session: AsyncSession,
    *,
    since_hours: int = 24,
) -> Dict[str, Any]:
    window_start = _window_start(since_hours)
    stmt: Select = select(ThreadSession).where(ThreadSession.started_at >= window_start).order_by(ThreadSession.started_at.desc())
    result = await session.execute(stmt)
    sessions = list(result.scalars().all())

    total_sessions = len(sessions)
    active_sessions = sum(1 for item in sessions if item.ended_at is None and item.status == "active")
    completed_sessions = sum(1 for item in sessions if item.status == "completed")
    failed_sessions = sum(1 for item in sessions if item.status == "failed")
    abandoned_sessions = sum(1 for item in sessions if item.status == "abandoned")
    unique_owners = len({_coerce_text(item.owner_id, "anonymous") for item in sessions})
    provider_counts = Counter(_coerce_text(item.stt_provider, "unknown") for item in sessions)
    terminal_reason_counts = Counter(_coerce_text(item.terminal_reason, "unknown") for item in sessions if item.terminal_reason)

    session_ids = [item.session_id for item in sessions]
    event_rows: list[ThreadSessionEvent] = []
    if session_ids:
        event_result = await session.execute(
            select(ThreadSessionEvent)
            .where(ThreadSessionEvent.session_id.in_(session_ids))
            .where(ThreadSessionEvent.created_at >= window_start)
            .order_by(ThreadSessionEvent.created_at.desc())
        )
        event_rows = list(event_result.scalars().all())

    error_events = [item for item in event_rows if item.level == "error"]
    stage_error_counts = Counter(_coerce_text(item.stage, "unknown") for item in error_events)
    error_code_counts = Counter(_coerce_text(item.code, "unknown") for item in error_events)

    first_partial_by_session: Dict[uuid.UUID, float] = {}
    first_final_by_session: Dict[uuid.UUID, float] = {}
    for event in event_rows:
        metrics = event.metrics if isinstance(event.metrics, dict) else {}
        if event.session_id not in first_partial_by_session and "partial_turnaround_ms" in metrics:
            first_partial_by_session[event.session_id] = float(metrics["partial_turnaround_ms"])
        if event.session_id not in first_final_by_session and "final_turnaround_ms" in metrics:
            first_final_by_session[event.session_id] = float(metrics["final_turnaround_ms"])

    def _avg(values: Dict[uuid.UUID, float]) -> Optional[float]:
        if not values:
            return None
        return round(sum(values.values()) / len(values), 2)

    return {
        "generated_at": _utcnow().isoformat(),
        "window_hours": since_hours,
        "sessions_started": total_sessions,
        "sessions_active_now": active_sessions,
        "sessions_completed": completed_sessions,
        "sessions_failed": failed_sessions,
        "sessions_abandoned": abandoned_sessions,
        "unique_owner_count": unique_owners,
        "error_event_count": len(error_events),
        "completion_rate": round(completed_sessions / total_sessions, 4) if total_sessions else 0.0,
        "failure_rate": round(failed_sessions / total_sessions, 4) if total_sessions else 0.0,
        "abandonment_rate": round(abandoned_sessions / total_sessions, 4) if total_sessions else 0.0,
        "avg_time_to_first_partial_ms": _avg(first_partial_by_session),
        "avg_time_to_first_final_ms": _avg(first_final_by_session),
        "top_providers": [
            {"provider": provider, "count": count}
            for provider, count in provider_counts.most_common(10)
        ],
        "top_terminal_reasons": [
            {"reason": reason, "count": count}
            for reason, count in terminal_reason_counts.most_common(10)
        ],
        "top_error_stages": [
            {"stage": stage, "count": count}
            for stage, count in stage_error_counts.most_common(10)
        ],
        "top_error_codes": [
            {"code": code, "count": count}
            for code, count in error_code_counts.most_common(10)
        ],
    }


async def get_threads_error_breakdown(
    session: AsyncSession,
    *,
    since_hours: int = 24,
    limit: int = 100,
) -> Dict[str, Any]:
    window_start = _window_start(since_hours)
    result = await session.execute(
        select(ThreadSessionEvent)
        .where(ThreadSessionEvent.level == "error")
        .where(ThreadSessionEvent.created_at >= window_start)
        .order_by(ThreadSessionEvent.created_at.desc())
        .limit(min(max(int(limit or 100), 1), 500))
    )
    events = list(result.scalars().all())
    return {
        "generated_at": _utcnow().isoformat(),
        "window_hours": since_hours,
        "error_count": len(events),
        "events": [
            {
                "id": str(item.id),
                "session_id": str(item.session_id),
                "conversation_id": str(item.conversation_id),
                "stage": item.stage,
                "event_type": item.event_type,
                "code": item.code,
                "message": item.message,
                "context": item.context if isinstance(item.context, dict) else {},
                "metrics": item.metrics if isinstance(item.metrics, dict) else {},
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in events
        ],
    }


async def get_thread_session_detail(
    session: AsyncSession,
    *,
    conversation_id: Any,
) -> Dict[str, Any]:
    conversation_uuid = _coerce_uuid(conversation_id)
    result = await session.execute(
        select(ThreadSession)
        .where(ThreadSession.conversation_id == conversation_uuid)
        .order_by(ThreadSession.started_at.asc())
    )
    sessions = list(result.scalars().all())
    session_ids = [item.session_id for item in sessions]
    events_by_session: Dict[uuid.UUID, list[ThreadSessionEvent]] = {item.session_id: [] for item in sessions}
    if session_ids:
        event_result = await session.execute(
            select(ThreadSessionEvent)
            .where(ThreadSessionEvent.session_id.in_(session_ids))
            .order_by(ThreadSessionEvent.created_at.asc())
        )
        for event in event_result.scalars().all():
            events_by_session.setdefault(event.session_id, []).append(event)

    return {
        "conversation_id": str(conversation_uuid),
        "session_count": len(sessions),
        "sessions": [
            {
                "session_id": str(item.session_id),
                "owner_id": item.owner_id,
                "entrypoint": item.entrypoint,
                "status": item.status,
                "terminal_reason": item.terminal_reason,
                "stt_provider": item.stt_provider,
                "stt_transport": item.stt_transport,
                "runtime_mode": item.runtime_mode,
                "started_at": item.started_at.isoformat() if item.started_at else None,
                "ended_at": item.ended_at.isoformat() if item.ended_at else None,
                "duration_ms": item.duration_ms,
                "client_metadata": item.client_metadata if isinstance(item.client_metadata, dict) else {},
                "session_metadata": item.session_metadata if isinstance(item.session_metadata, dict) else {},
                "event_count": len(events_by_session.get(item.session_id, [])),
                "events": [
                    {
                        "id": str(event.id),
                        "stage": event.stage,
                        "level": event.level,
                        "event_type": event.event_type,
                        "code": event.code,
                        "message": event.message,
                        "context": event.context if isinstance(event.context, dict) else {},
                        "metrics": event.metrics if isinstance(event.metrics, dict) else {},
                        "created_at": event.created_at.isoformat() if event.created_at else None,
                    }
                    for event in events_by_session.get(item.session_id, [])
                ],
            }
            for item in sessions
        ],
    }

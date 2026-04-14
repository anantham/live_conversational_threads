"""Bounded in-memory observability store for live session debugging.

Stores per-conversation / per-session structured events so the frontend can
export a single debug artifact containing both client-visible state and
backend-side evidence.
"""

from __future__ import annotations

from collections import OrderedDict, deque
from copy import deepcopy
from threading import RLock
from time import time
from typing import Any, Deque, Dict, List, Optional

MAX_CONVERSATIONS = 200
MAX_SESSIONS_PER_CONVERSATION = 8
MAX_EVENTS_PER_SESSION = 1200
MAX_CONTEXT_CHARS = 6000

_STORE_LOCK = RLock()
_CONVERSATIONS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()


def _now_ms() -> int:
    return int(time() * 1000)


def _trim_value(value: Any) -> Any:
    if isinstance(value, str):
        return value if len(value) <= MAX_CONTEXT_CHARS else f"{value[:MAX_CONTEXT_CHARS]}…"
    if isinstance(value, dict):
        return {str(key): _trim_value(sub_value) for key, sub_value in value.items()}
    if isinstance(value, list):
        return [_trim_value(item) for item in value]
    return value


def _extract_numeric_metrics(payload: Dict[str, Any]) -> Dict[str, float]:
    metrics: Dict[str, float] = {}
    for key, value in (payload or {}).items():
        if not isinstance(key, str):
            continue
        if not key.endswith("_ms") and not key.endswith("_count") and not key.endswith("_bytes"):
            continue
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            continue
        if key.endswith("_ms") and numeric_value < 0:
            continue
        metrics[key] = round(numeric_value, 2)
    return metrics


def _ensure_conversation(conversation_id: str) -> Dict[str, Any]:
    conversation = _CONVERSATIONS.get(conversation_id)
    if conversation is None:
        conversation = {
            "conversation_id": conversation_id,
            "created_at_ms": _now_ms(),
            "last_updated_at_ms": _now_ms(),
            "sessions": OrderedDict(),
        }
        _CONVERSATIONS[conversation_id] = conversation
    else:
        _CONVERSATIONS.move_to_end(conversation_id)
        conversation["last_updated_at_ms"] = _now_ms()

    while len(_CONVERSATIONS) > MAX_CONVERSATIONS:
        _CONVERSATIONS.popitem(last=False)
    return conversation


def _ensure_session(conversation: Dict[str, Any], session_id: str) -> Dict[str, Any]:
    sessions: "OrderedDict[str, Dict[str, Any]]" = conversation["sessions"]
    session = sessions.get(session_id)
    if session is None:
        session = {
            "session_id": session_id,
            "started_at_ms": _now_ms(),
            "ended_at_ms": None,
            "status": "active",
            "metadata": {},
            "events": deque(maxlen=MAX_EVENTS_PER_SESSION),
        }
        sessions[session_id] = session
    else:
        sessions.move_to_end(session_id)
    while len(sessions) > MAX_SESSIONS_PER_CONVERSATION:
        sessions.popitem(last=False)
    return session


def start_session(
    *,
    conversation_id: str,
    session_id: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    if not conversation_id or not session_id:
        return
    with _STORE_LOCK:
        conversation = _ensure_conversation(str(conversation_id))
        session = _ensure_session(conversation, str(session_id))
        session["started_at_ms"] = session.get("started_at_ms") or _now_ms()
        session["ended_at_ms"] = None
        session["status"] = "active"
        session["metadata"] = _trim_value(dict(metadata or {}))
        conversation["last_updated_at_ms"] = _now_ms()


def record_event(
    *,
    conversation_id: Optional[str],
    session_id: Optional[str],
    event_type: str,
    stage: str,
    level: str = "info",
    message: str = "",
    context: Optional[Dict[str, Any]] = None,
    metrics: Optional[Dict[str, Any]] = None,
) -> None:
    if not conversation_id or not session_id:
        return

    event_context = _trim_value(dict(context or {}))
    event_metrics = _extract_numeric_metrics(event_context)
    if metrics:
        event_metrics.update(_extract_numeric_metrics(metrics))

    event = {
        "ts_ms": _now_ms(),
        "type": str(event_type or "event"),
        "stage": str(stage or "unknown"),
        "level": str(level or "info"),
        "message": str(message or ""),
        "context": event_context,
        "metrics": event_metrics,
    }

    with _STORE_LOCK:
        conversation = _ensure_conversation(str(conversation_id))
        session = _ensure_session(conversation, str(session_id))
        events: Deque[Dict[str, Any]] = session["events"]
        events.append(event)
        conversation["last_updated_at_ms"] = event["ts_ms"]


def finish_session(
    *,
    conversation_id: Optional[str],
    session_id: Optional[str],
    status: str = "completed",
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    if not conversation_id or not session_id:
        return
    with _STORE_LOCK:
        conversation = _ensure_conversation(str(conversation_id))
        session = _ensure_session(conversation, str(session_id))
        session["ended_at_ms"] = _now_ms()
        session["status"] = str(status or "completed")
        if metadata:
            session["metadata"] = {
                **dict(session.get("metadata") or {}),
                **_trim_value(dict(metadata)),
            }
        conversation["last_updated_at_ms"] = session["ended_at_ms"]


def _summarize_session(session: Dict[str, Any]) -> Dict[str, Any]:
    events = list(session.get("events") or [])
    latency_candidates: List[tuple[str, str, float]] = []
    error_events = 0
    warning_events = 0
    stage_counts: Dict[str, int] = {}

    for event in events:
        stage = str(event.get("stage") or "unknown")
        stage_counts[stage] = stage_counts.get(stage, 0) + 1
        level = str(event.get("level") or "info").lower()
        if level == "error":
            error_events += 1
        elif level == "warning":
            warning_events += 1
        for metric_name, metric_value in (event.get("metrics") or {}).items():
            if metric_name.endswith("_ms"):
                latency_candidates.append((stage, metric_name, float(metric_value)))

    dominant_stage = None
    dominant_metric = None
    dominant_ms = None
    if latency_candidates:
        dominant_stage, dominant_metric, dominant_ms = max(latency_candidates, key=lambda item: item[2])

    return {
        "session_id": session.get("session_id"),
        "started_at_ms": session.get("started_at_ms"),
        "ended_at_ms": session.get("ended_at_ms"),
        "duration_ms": (
            max(0, int(session["ended_at_ms"]) - int(session["started_at_ms"]))
            if session.get("ended_at_ms") and session.get("started_at_ms")
            else None
        ),
        "status": session.get("status"),
        "metadata": deepcopy(session.get("metadata") or {}),
        "event_count": len(events),
        "error_count": error_events,
        "warning_count": warning_events,
        "stage_counts": stage_counts,
        "latency_summary": {
            "dominant_stage": dominant_stage,
            "dominant_metric": dominant_metric,
            "dominant_ms": dominant_ms,
        },
        "events": deepcopy(events),
    }


def get_conversation_observability(conversation_id: str) -> Dict[str, Any]:
    with _STORE_LOCK:
        conversation = _CONVERSATIONS.get(str(conversation_id))
        if conversation is None:
            return {
                "conversation_id": str(conversation_id),
                "latest_session_id": None,
                "session_count": 0,
                "sessions": [],
            }

        sessions = list(conversation.get("sessions", {}).values())
        summaries = [_summarize_session(session) for session in sessions]
        latest_session_id = summaries[-1]["session_id"] if summaries else None
        return {
            "conversation_id": str(conversation_id),
            "latest_session_id": latest_session_id,
            "session_count": len(summaries),
            "created_at_ms": conversation.get("created_at_ms"),
            "last_updated_at_ms": conversation.get("last_updated_at_ms"),
            "sessions": summaries,
        }


def clear_session_observability_store() -> None:
    with _STORE_LOCK:
        _CONVERSATIONS.clear()

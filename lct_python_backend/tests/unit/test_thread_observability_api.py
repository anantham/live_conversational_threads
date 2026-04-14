import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import stt_api
from lct_python_backend.services.stt_ws_session import WsSessionContext


async def _fake_session_dependency():
    yield object()


def test_threads_observability_summary_route(monkeypatch):
    app = FastAPI()
    app.include_router(stt_api.router)
    app.dependency_overrides[stt_api.get_async_session] = _fake_session_dependency

    async def _fake_summary(session, *, since_hours):
        return {"sessions_started": 3, "window_hours": since_hours}

    monkeypatch.setattr(stt_api, "get_threads_observability_summary", _fake_summary)

    client = TestClient(app)
    response = client.get("/api/threads/observability/summary?since_hours=12")
    assert response.status_code == 200
    assert response.json() == {"sessions_started": 3, "window_hours": 12}


def test_threads_observability_errors_route(monkeypatch):
    app = FastAPI()
    app.include_router(stt_api.router)
    app.dependency_overrides[stt_api.get_async_session] = _fake_session_dependency

    async def _fake_errors(session, *, since_hours, limit):
        return {"error_count": 2, "window_hours": since_hours, "limit": limit}

    monkeypatch.setattr(stt_api, "get_threads_error_breakdown", _fake_errors)

    client = TestClient(app)
    response = client.get("/api/threads/observability/errors?since_hours=6&limit=10")
    assert response.status_code == 200
    assert response.json() == {"error_count": 2, "window_hours": 6, "limit": 10}


def test_conversation_thread_session_details_route(monkeypatch):
    app = FastAPI()
    app.include_router(stt_api.router)
    app.dependency_overrides[stt_api.get_async_session] = _fake_session_dependency

    async def _fake_detail(session, *, conversation_id):
        return {"conversation_id": conversation_id, "session_count": 1}

    monkeypatch.setattr(stt_api, "get_thread_session_detail", _fake_detail)

    client = TestClient(app)
    response = client.get("/api/conversations/123e4567-e89b-12d3-a456-426614174000/thread-session-details")
    assert response.status_code == 200
    assert response.json()["session_count"] == 1


def test_ws_session_context_classifies_disconnect_before_flush_as_abandoned():
    ctx = WsSessionContext.__new__(WsSessionContext)
    ctx.session_terminal_status = "completed"
    ctx.session_terminal_reason = "completed"
    ctx.flush_complete_sent = False
    ctx.first_audio_chunk_logged = True
    ctx.session_started_committed = True
    ctx.telemetry_state = {"audio_send_started_at_ms": 1}
    ctx.state = type("State", (), {"conversation_id": "conv-1"})()

    assert ctx._classify_terminal_state() == ("abandoned", "client_disconnect_before_flush")


def test_ws_session_context_preserves_failed_terminal_status():
    ctx = WsSessionContext.__new__(WsSessionContext)
    ctx.session_terminal_status = "failed"
    ctx.session_terminal_reason = "internal_server_error"
    ctx.flush_complete_sent = False
    ctx.first_audio_chunk_logged = True
    ctx.session_started_committed = True
    ctx.telemetry_state = {"audio_send_started_at_ms": 1}
    ctx.state = type("State", (), {"conversation_id": "conv-1"})()

    assert ctx._classify_terminal_state() == ("failed", "internal_server_error")

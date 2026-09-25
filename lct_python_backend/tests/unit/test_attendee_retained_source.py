"""Synthetic retained-source contract; intent: attendee-retained-source.md."""
from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Column, DateTime, Integer, JSON, MetaData, Table, Text, Uuid, create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from lct_python_backend import attendee_api, attendee_source_api, auth_policy
from lct_python_backend.services import attendee_bridge
from lct_python_backend.services.attendee_identity import source_identity
from lct_python_backend.services.attendee_retained_source import read_retained_source

OCCURRENCE = {"calendar_id": "synthetic-calendar", "event_id": "series_20260925T120000Z"}
CONVERSATION = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path, monkeypatch):
    monkeypatch.setenv("ATTENDEE_SESSION_REGISTRY_PATH", str(tmp_path / "sessions.json"))
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", "synthetic-source-token")
    monkeypatch.setattr(auth_policy, "ADMIN_AUTH_TOKEN", None)


@pytest.fixture
def retained_db():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    metadata = MetaData()
    conversations = Table("conversations", metadata, Column("id", Uuid, primary_key=True),
                          Column("source_metadata", JSON), Column("deleted_at", DateTime))
    events = Table("transcript_events", metadata, Column("id", Uuid, primary_key=True),
                   Column("conversation_id", Uuid), Column("provider", Text),
                   Column("event_type", Text), Column("text", Text),
                   Column("sequence_number", Integer), Column("metadata", JSON))
    metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(conversations.insert().values(
            id=CONVERSATION, source_metadata=source_identity(OCCURRENCE, "closed_captions"),
        ))
        for index, (provider, kind, content) in enumerate([
            ("attendee", "final", "Original caption one"),
            ("attendee", "partial", "Do not return this partial"),
            ("other", "final", "Do not return another source"),
            ("attendee", "final", "Original caption two"),
        ], 1):
            conn.execute(events.insert().values(
                id=UUID(int=index), conversation_id=CONVERSATION,
                provider=provider, event_type=kind, text=content, sequence_number=index,
                metadata={"speaker_name": "Synthetic speaker", "source_timing": {
                    "timeline": "caption_relative", "start": index * 2.0, "end": index * 2.0 + 1,
                }},
            ))
    session = Session(engine)
    class ReadOnlyDB:
        async def execute(self, statement):
            assert statement.is_select, "retained source must never mutate or initialize"
            return session.execute(statement)
    yield ReadOnlyDB(), engine, conversations, events
    session.close()
    engine.dispose()


def read(db, **kwargs):
    return asyncio.run(read_retained_source(
        db, conversation_id=CONVERSATION, calendar_occurrence=OCCURRENCE, **kwargs,
    ))


def test_read_original_final_events_and_explicit_non_audio_timeline(retained_db):
    db, _, _, _ = retained_db
    result = read(db)
    assert result["identity_verified"] is True and result["status"] == "ready"
    assert [s["text"] for s in result["segments"]] == ["Original caption one", "Original caption two"]
    assert [s["id"] for s in result["segments"]] == [str(UUID(int=1)), str(UUID(int=4))]
    assert result["segments"][0]["start"] == 2.0
    assert result["provenance"]["timeline"] == "caption_relative"
    assert result["provenance"]["drive_audio_offset_seconds"] is None
    assert result["next_cursor"] is None


def test_pagination_keeps_stable_original_event_ids(retained_db):
    db, _, _, _ = retained_db
    first = read(db, limit=1)
    cursor = first["next_cursor"]
    second = read(db, limit=1, after_sequence=cursor["sequence_number"],
                  after_event_id=UUID(cursor["event_id"]))
    assert [s["id"] for s in first["segments"] + second["segments"]] == [str(UUID(int=1)), str(UUID(int=4))]
    assert second["next_cursor"] is None


@pytest.mark.parametrize("metadata,status", [
    ({"meeting_url": "https://meet.google.com/reused-room"}, "identity_unverified"),
    (source_identity({**OCCURRENCE, "event_id": "other-occurrence"}, "closed_captions"), "identity_mismatch"),
])
def test_url_or_mismatched_occurrence_never_releases_source(retained_db, metadata, status):
    db, engine, conversations, _ = retained_db
    with engine.begin() as conn:
        conn.execute(conversations.update().values(source_metadata=metadata))
    result = read(db)
    assert result["identity_verified"] is False and result["status"] == status
    assert result["segments"] == []


def test_conflicting_durable_occurrence_is_unverified(retained_db):
    db, _, _, _ = retained_db
    result = read(db, durable_record={"calendar_occurrence": {**OCCURRENCE, "calendar_id": "other"}})
    assert result["status"] == "identity_conflict" and result["segments"] == []


def test_missing_original_timing_is_unknown_not_mutable_utterance_fallback(retained_db):
    db, engine, _, events = retained_db
    with engine.begin() as conn:
        conn.execute(events.update().values(metadata={"speaker_name": "Synthetic speaker"}))
    assert all(s["start"] is None and s["end"] is None for s in read(db)["segments"])


@pytest.fixture
def api_client(retained_db, monkeypatch):
    db, _, _, _ = retained_db
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", "synthetic-source-token")
    monkeypatch.setattr(auth_policy, "ADMIN_AUTH_TOKEN", None)
    async def dependency():
        yield db
    app = FastAPI()
    app.include_router(attendee_api.router)
    app.dependency_overrides[attendee_source_api.retained_source_session] = dependency
    with TestClient(app) as client:
        yield client


def join_request():
    return Request({"type": "http", "headers": [(b"authorization", b"Bearer synthetic-source-token")]})


def source_url():
    return f"/api/attendee/meetings/{CONVERSATION}/retained-source"


def test_registered_source_endpoint_requires_auth_and_does_not_fetch_provider(api_client, monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("source reads must not dispatch or fetch from Attendee")
    monkeypatch.setattr(attendee_api.attendee_client, "create_bot", forbidden)
    assert api_client.get(source_url(), params=OCCURRENCE).status_code == 401
    response = api_client.get(source_url(), params=OCCURRENCE,
                              headers={"Authorization": "Bearer synthetic-source-token"})
    assert response.status_code == 200
    assert response.json()["identity_verified"] is True
    assert response.headers["cache-control"] == "private, no-store"


def test_source_endpoint_fails_closed_without_existing_auth(api_client, monkeypatch):
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", None)
    assert api_client.get(source_url(), params=OCCURRENCE).status_code == 503


def test_source_endpoint_accepts_existing_admin_only_auth(api_client, monkeypatch):
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", None)
    monkeypatch.setattr(auth_policy, "ADMIN_AUTH_TOKEN", "synthetic-admin-token")
    assert api_client.get(source_url(), params=OCCURRENCE).status_code == 401
    response = api_client.get(source_url(), params=OCCURRENCE,
                              headers={"Authorization": "Bearer synthetic-admin-token"})
    assert response.status_code == 200


def test_source_endpoint_rejects_incomplete_page_cursor(api_client):
    response = api_client.get(source_url(), params={**OCCURRENCE, "after_sequence": 4},
                              headers={"Authorization": "Bearer synthetic-source-token"})
    assert response.status_code == 422


def test_join_identity_survives_close_and_reaches_persistent_session_metadata(monkeypatch):
    frames = []
    class Socket:
        def __init__(self):
            self.closed = asyncio.Event()
        async def send(self, value):
            frames.append(json.loads(value))
        async def close(self):
            self.closed.set()
        async def __aiter__(self):
            yield json.dumps({"type": "session_started"})
            await self.closed.wait()
    async def connect(*args, **kwargs):
        return Socket()
    monkeypatch.setattr(attendee_bridge.websockets, "connect", connect)
    monkeypatch.setenv("ATTENDEE_ALLOW_DRY_RUN", "1")
    async def forbidden(*args, **kwargs):
        raise AssertionError("synthetic dry run must not join a meeting")
    monkeypatch.setattr(attendee_api.attendee_client, "create_bot", forbidden)
    async def run():
        result = await attendee_api.create_meeting(attendee_api.CreateMeetingRequest(
            meeting_url="https://meet.google.com/synthetic-room", dry_run=True,
            calendar_occurrence=OCCURRENCE,
        ), request=join_request())
        session = attendee_bridge.get_by_conversation(result["conversation_id"])
        await session.inject_utterance(text="Synthetic original", speaker_name="Speaker",
                                       timestamp_ms=100000, duration_ms=500)
        await session.close(reason="finalized")
        record = attendee_bridge.get_durable_by_conversation(result["conversation_id"])
        assert attendee_bridge.get_by_conversation(result["conversation_id"]) is None
        return record
    record = asyncio.run(run())
    assert record["calendar_occurrence"] == OCCURRENCE
    metadata = next(f for f in frames if f["type"] == "session_meta")["metadata"]["source_metadata"]
    assert metadata["calendar_occurrence"] == OCCURRENCE
    assert metadata["identity_provenance"] == "authenticated_join_request"
    event = next(f for f in frames if f["type"] == "transcript_final")
    assert event["metadata"]["source_timing"] == {"timeline": "caption_relative", "start": 0.0, "end": 0.5}


@pytest.mark.parametrize("existing", [None, {**OCCURRENCE, "event_id": "previous-occurrence"}])
def test_same_url_dedup_does_not_invent_or_replace_occurrence(monkeypatch, existing):
    session = attendee_bridge.MeetingSession(conversation_id=str(uuid4()),
        meeting_url="https://meet.google.com/reused-room", bot_name="Synthetic",
        calendar_occurrence=existing)
    monkeypatch.setattr(attendee_bridge, "get_by_meeting_url", lambda _: session)
    monkeypatch.setattr(attendee_api.attendee_client, "is_configured", lambda: True)
    async def forbidden(*args, **kwargs):
        raise AssertionError("identity conflict must not dispatch a second bot")
    monkeypatch.setattr(attendee_api.attendee_client, "create_bot", forbidden)
    result = asyncio.run(attendee_api.create_meeting(attendee_api.CreateMeetingRequest(
        meeting_url=session.meeting_url, calendar_occurrence=OCCURRENCE,
    ), request=join_request()))
    assert result.status_code == 409
    assert session.calendar_occurrence == existing


def test_exact_join_requires_auth_before_dispatch(api_client, monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("unauthenticated exact join must never dispatch")
    monkeypatch.setattr(attendee_api.attendee_client, "create_bot", forbidden)
    payload = {"meeting_url": "https://meet.google.com/synthetic-room", "calendar_occurrence": OCCURRENCE}
    assert api_client.post("/api/attendee/meetings", json=payload).status_code == 401
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", None)
    assert api_client.post("/api/attendee/meetings", json=payload).status_code == 503


def test_malformed_metadata_stays_unverified(retained_db):
    db, engine, conversations, _ = retained_db
    with engine.begin() as conn:
        conn.execute(conversations.update().values(source_metadata=["legacy malformed value"]))
    assert read(db)["status"] == "identity_unverified"


def test_equal_sequence_page_cursor_keeps_each_original_event(retained_db):
    db, engine, _, events = retained_db
    with engine.begin() as conn:
        conn.execute(events.update().values(sequence_number=1))
    first = read(db, limit=1)
    second = read(db, limit=1, after_sequence=first["next_cursor"]["sequence_number"],
                  after_event_id=UUID(first["next_cursor"]["event_id"]))
    assert [segment["id"] for segment in first["segments"] + second["segments"]] == [str(UUID(int=1)), str(UUID(int=4))]


def test_deleted_conversation_never_releases_retained_source(api_client, retained_db):
    from datetime import datetime
    _, engine, conversations, _ = retained_db
    with engine.begin() as conn:
        conn.execute(conversations.update().values(deleted_at=datetime(2026, 9, 25)))
    response = api_client.get(source_url(), params=OCCURRENCE,
                             headers={"Authorization": "Bearer synthetic-source-token"})
    assert response.status_code == 404
    assert "Original caption" not in response.text


def test_database_dependency_enforces_read_only_and_rolls_back(monkeypatch):
    from lct_python_backend import db_session
    executed = []
    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def execute(self, statement):
            executed.append(str(statement))
        async def rollback(self):
            executed.append("ROLLBACK")
    monkeypatch.setattr(db_session, "get_sessionmaker", lambda: Session)
    async def run():
        generator = attendee_source_api.retained_source_session()
        await generator.__anext__()
        await generator.aclose()
    asyncio.run(run())
    assert executed == ["SET TRANSACTION READ ONLY", "ROLLBACK"]

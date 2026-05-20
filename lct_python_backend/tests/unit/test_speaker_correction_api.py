"""Tests for POST /api/conversations/{id}/speaker-correction — ADR-032 Part H v1.

The endpoint runs three queries in order (Conversation, target Utterance,
all-utterances-for-speaker) then commits. The fake session here serves
those in sequence and captures the committed SpeakerCorrectionEvent.
"""

from __future__ import annotations

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import speaker_naming_api
from lct_python_backend.db_session import get_async_session


CONV_ID = "5953fd1b-2597-408c-916d-f553f8da57f2"


class _ScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _SequencedSession:
    """Serves queued results per execute(); records added rows + commits."""

    def __init__(self, results_queue):
        self._queue = list(results_queue)
        self.added = []
        self.commits = 0

    async def execute(self, _stmt):
        if not self._queue:
            return _ScalarResult([])
        return _ScalarResult(self._queue.pop(0))

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1


def _fake_conversation():
    return SimpleNamespace(id=uuid.UUID(CONV_ID))


def _fake_utterance(uid=None, speaker_id="SPEAKER_00", speaker_name=None,
                    ts_start=600.0, seq=1, revision=0):
    return SimpleNamespace(
        id=uid or uuid.uuid4(),
        conversation_id=uuid.UUID(CONV_ID),
        speaker_id=speaker_id,
        speaker_name=speaker_name,
        speaker_source="session_default",
        speaker_revision=revision,
        sequence_number=seq,
        timestamp_start=ts_start,
        timestamp_end=ts_start + 3.0,
    )


@pytest.fixture
def make_client():
    def _build(results_queue):
        app = FastAPI()
        app.include_router(speaker_naming_api.router_conversations)
        session = _SequencedSession(results_queue)

        async def override():
            yield session

        app.dependency_overrides[get_async_session] = override
        return TestClient(app), session

    return _build


def _post(client, body):
    return client.post(f"/api/conversations/{CONV_ID}/speaker-correction", json=body)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_correction_422_invalid_conversation_uuid(make_client):
    client, _ = make_client([])
    resp = client.post(
        "/api/conversations/not-a-uuid/speaker-correction",
        json={"utterance_id": str(uuid.uuid4()), "new_speaker": "Sarah"},
    )
    assert resp.status_code == 422


def test_correction_422_empty_new_speaker(make_client):
    client, _ = make_client([[_fake_conversation()]])
    resp = _post(client, {"utterance_id": str(uuid.uuid4()), "new_speaker": "   "})
    assert resp.status_code == 422


def test_correction_404_conversation_missing(make_client):
    client, _ = make_client([[]])  # Conversation query returns nothing
    resp = _post(client, {"utterance_id": str(uuid.uuid4()), "new_speaker": "Sarah"})
    assert resp.status_code == 404


def test_correction_404_utterance_missing(make_client):
    # Conversation found, target utterance not.
    client, _ = make_client([[_fake_conversation()], []])
    resp = _post(client, {"utterance_id": str(uuid.uuid4()), "new_speaker": "Sarah"})
    assert resp.status_code == 404


def test_correction_windowed_relabel(make_client):
    """Target at t=600s. Window ±300s. Utterances at 400/600/800 (in
    window) should flip; 1000s (out of window) should NOT."""
    target_id = uuid.uuid4()
    target = _fake_utterance(uid=target_id, speaker_id="SPEAKER_00",
                             speaker_name="Bob", ts_start=600.0)
    same_speaker_rows = [
        _fake_utterance(speaker_id="SPEAKER_00", speaker_name="Bob", ts_start=400.0, seq=1),
        target,  # 600s
        _fake_utterance(speaker_id="SPEAKER_00", speaker_name="Bob", ts_start=800.0, seq=3),
        _fake_utterance(speaker_id="SPEAKER_00", speaker_name="Bob", ts_start=1000.0, seq=4),
    ]
    client, session = make_client([
        [_fake_conversation()],   # Conversation lookup
        [target],                 # target utterance lookup
        same_speaker_rows,        # all utterances for speaker
    ])
    resp = _post(client, {
        "utterance_id": str(target_id),
        "new_speaker": "Sarah",
        "time_window_seconds": 300,
    })
    assert resp.status_code == 200
    body = resp.json()
    # 400s, 600s, 800s are within ±300 of 600 → 3 relabeled. 1000s is not.
    assert body["relabeled_count"] == 3
    assert body["prior_speaker"] == "Bob"
    assert body["new_speaker"] == "Sarah"
    assert body["scope"] == "±300s"
    # The in-window rows got the new name; the out-of-window one didn't.
    in_window = [u for u in same_speaker_rows if abs(u.timestamp_start - 600.0) <= 300]
    out_window = [u for u in same_speaker_rows if abs(u.timestamp_start - 600.0) > 300]
    assert all(u.speaker_name == "Sarah" for u in in_window)
    assert all(u.speaker_name == "Bob" for u in out_window)
    # A SpeakerCorrectionEvent was logged + committed.
    assert session.commits == 1
    assert len(session.added) == 1
    ev = session.added[0]
    assert ev.prior_speaker == "Bob"
    assert ev.new_speaker == "Sarah"
    assert ev.time_window_seconds == 300


def test_correction_window_zero_means_whole_conversation(make_client):
    """window=0 → relabel every utterance with that speaker_id, regardless
    of timestamp."""
    target_id = uuid.uuid4()
    target = _fake_utterance(uid=target_id, speaker_id="SPEAKER_01",
                             speaker_name=None, ts_start=10.0)
    rows = [
        target,
        _fake_utterance(speaker_id="SPEAKER_01", ts_start=5000.0, seq=2),
        _fake_utterance(speaker_id="SPEAKER_01", ts_start=9999.0, seq=3),
    ]
    client, session = make_client([
        [_fake_conversation()],
        [target],
        rows,
    ])
    resp = _post(client, {
        "utterance_id": str(target_id),
        "new_speaker": "Alice",
        "time_window_seconds": 0,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["relabeled_count"] == 3   # all of them, no window filter
    assert body["scope"] == "whole_conversation"
    # prior_speaker fell back to speaker_id since speaker_name was None
    assert body["prior_speaker"] == "SPEAKER_01"
    assert all(u.speaker_name == "Alice" for u in rows)


def test_correction_event_records_source(make_client):
    target_id = uuid.uuid4()
    target = _fake_utterance(uid=target_id, speaker_id="SPEAKER_00",
                             speaker_name="Bob", ts_start=100.0)
    client, session = make_client([
        [_fake_conversation()], [target], [target],
    ])
    resp = _post(client, {
        "utterance_id": str(target_id),
        "new_speaker": "Carol",
        "time_window_seconds": 300,
        "source": "node_detail_panel",
    })
    assert resp.status_code == 200
    assert session.added[0].source == "node_detail_panel"

"""Tests for GET /api/conversations/{id}/export.json — ADR-032 Part L.

The export endpoint runs five ordered queries (Conversation, Node,
Relationship, Utterance, SpeakerCorrectionEvent). The fake session here
returns results in that exact order so we can assert the full export
shape without a live database.
"""

from __future__ import annotations

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import conversations_api
from lct_python_backend.db_session import get_async_session


CONV_ID = "5953fd1b-2597-408c-916d-f553f8da57f2"


# ---------------------------------------------------------------------------
# Fake session that serves a queue of results in query order
# ---------------------------------------------------------------------------


class _ScalarResult:
    """Mimics SQLAlchemy Result — supports scalar_one_or_none() and scalars().all()."""

    def __init__(self, rows):
        self._rows = rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _SequencedSession:
    """Returns queued results one execute() call at a time."""

    def __init__(self, results_queue):
        self._queue = list(results_queue)
        self.execute_count = 0

    async def execute(self, _stmt):
        self.execute_count += 1
        if not self._queue:
            return _ScalarResult([])
        return _ScalarResult(self._queue.pop(0))


def _fake_conversation():
    return SimpleNamespace(
        id=uuid.UUID(CONV_ID),
        conversation_name="Balancing AI Features, User Trust, and Project Development",
        conversation_type="transcript",
        source_type="audio",
        owner_id="default_user",
        participant_count=3,
        participants=[{"name": "A", "utterance_count": 10}],
        total_nodes=167,
        total_utterances=404,
        total_words=15480,
        duration_seconds=900,
        started_at=datetime(2026, 5, 19, 23, 35, 18),
        created_at=datetime(2026, 5, 19, 23, 35, 18),
        source_metadata={"conversation_title": "Balancing AI Features", "executive_summary": "..."},
    )


def _fake_node(level=1, with_excerpt=True):
    nid = uuid.uuid4()
    return SimpleNamespace(
        id=nid,
        node_name=f"L{level} node",
        summary="A summary",
        source_excerpt="A: verbatim excerpt" if with_excerpt else None,
        key_points=[],
        node_type="conversational_thread",
        level=level,
        parent_id=None,
        children_ids=None,
        is_bookmark=False,
        is_contextual_progress=False,
        is_tangent=False,
        is_crux=False,
        chunk_ids=[uuid.uuid4()],
        utterance_ids=[uuid.uuid4()],
        speaker_info={"primary_speaker": "A"},
        timestamp_start=1.268,
        timestamp_end=12.5,
        duration_seconds=11.232,
        cluster_info={"thread_id": "thread-x"},
        display_preferences={"edge_relations": []},
        zoom_level_visible=[level],
        created_at=datetime(2026, 5, 19, 23, 35, 18),
        updated_at=datetime(2026, 5, 19, 23, 35, 18),
    )


def _fake_relationship(rel_type="supports"):
    return SimpleNamespace(
        id=uuid.uuid4(),
        from_node_id=uuid.uuid4(),
        to_node_id=uuid.uuid4(),
        relationship_type=rel_type,
        relationship_subtype=rel_type,
        explanation="A supports B",
        strength=0.8,
        confidence=0.9,
        is_bidirectional=False,
        created_at=datetime(2026, 5, 19, 23, 35, 18),
    )


def _fake_utterance(seq=1):
    return SimpleNamespace(
        id=uuid.uuid4(),
        sequence_number=seq,
        text="hello world",
        text_cleaned="hello world",
        speaker_id="SPEAKER_00",
        speaker_name=None,
        speaker_source="session_default",
        speaker_confidence=None,
        speaker_revision=0,
        timestamp_start=1.0,
        timestamp_end=2.0,
        duration_seconds=1.0,
        chunk_id=uuid.uuid4(),
        node_id=None,
        thread_id=None,
        word_timings=[{"word": "hello", "start": 1.0, "end": 1.4}],
        platform_metadata={},
        created_at=datetime(2026, 5, 19, 23, 35, 18),
    )


@pytest.fixture
def make_client():
    """Build a TestClient with conversations_api mounted + a sequenced session."""

    def _build(results_queue):
        app = FastAPI()
        app.include_router(conversations_api.router)
        session = _SequencedSession(results_queue)

        async def override():
            yield session

        app.dependency_overrides[get_async_session] = override
        return TestClient(app), session

    return _build


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_export_404_when_conversation_missing(make_client):
    # First query (Conversation) returns nothing.
    client, _ = make_client([[]])
    resp = client.get(f"/api/conversations/{CONV_ID}/export.json")
    assert resp.status_code == 404


def test_export_422_for_invalid_uuid(make_client):
    client, _ = make_client([[]])
    resp = client.get("/api/conversations/not-a-uuid/export.json")
    assert resp.status_code == 422


def test_export_full_shape(make_client):
    # Query order: Conversation, Node, Relationship, Utterance, SpeakerCorrectionEvent
    nodes = [_fake_node(level=L) for L in (1, 1, 2, 3, 5)]
    rels = [_fake_relationship("supports"), _fake_relationship("temporal")]
    utts = [_fake_utterance(1), _fake_utterance(2)]
    client, session = make_client([[_fake_conversation()], nodes, rels, utts, []])

    resp = client.get(f"/api/conversations/{CONV_ID}/export.json")
    assert resp.status_code == 200
    body = resp.json()

    # Top-level shape
    assert body["export_version"] == "adr032-v1"
    assert "exported_at" in body
    assert body["counts"] == {
        "nodes": 5,
        "relationships": 2,
        "utterances": 2,
        "speaker_correction_events": 0,
    }

    # Conversation block
    conv = body["conversation"]
    assert conv["id"] == CONV_ID
    assert conv["total_nodes"] == 167
    assert conv["conversation_name"].startswith("Balancing AI")

    # All five ordered queries ran
    assert session.execute_count == 5


def test_export_node_includes_adr032_columns(make_client):
    nodes = [_fake_node(level=1, with_excerpt=True)]
    client, _ = make_client([[_fake_conversation()], nodes, [], [], []])
    body = client.get(f"/api/conversations/{CONV_ID}/export.json").json()

    node = body["nodes"][0]
    # ADR-032 Part G columns must be in the export
    for col in ("source_excerpt", "timestamp_start", "timestamp_end",
                "parent_id", "children_ids", "duration_seconds"):
        assert col in node, f"node export missing {col}"
    assert node["source_excerpt"] == "A: verbatim excerpt"
    assert node["timestamp_start"] == 1.268


def test_export_utterance_includes_word_timings(make_client):
    utts = [_fake_utterance(1)]
    client, _ = make_client([[_fake_conversation()], [], [], utts, []])
    body = client.get(f"/api/conversations/{CONV_ID}/export.json").json()

    utt = body["utterances"][0]
    assert "word_timings" in utt
    assert utt["word_timings"][0]["word"] == "hello"
    assert "chunk_id" in utt


def test_export_relationship_carries_type_and_subtype(make_client):
    rels = [_fake_relationship("rebuts")]
    client, _ = make_client([[_fake_conversation()], [], rels, [], []])
    body = client.get(f"/api/conversations/{CONV_ID}/export.json").json()

    rel = body["relationships"][0]
    assert rel["relationship_type"] == "rebuts"
    assert rel["relationship_subtype"] == "rebuts"
    assert rel["explanation"] == "A supports B"


def test_export_uuid_and_datetime_are_json_safe(make_client):
    # The endpoint must coerce UUID + datetime to strings; if it didn't,
    # FastAPI's JSON encoder would still handle it, but our _ser() makes
    # it explicit + handles nested arrays. Assert the types are strings.
    client, _ = make_client([[_fake_conversation()], [_fake_node()], [], [], []])
    body = client.get(f"/api/conversations/{CONV_ID}/export.json").json()
    node = body["nodes"][0]
    assert isinstance(node["id"], str)
    assert isinstance(node["created_at"], str)
    # chunk_ids is a UUID array — each element must be a string
    assert all(isinstance(c, str) for c in node["chunk_ids"])

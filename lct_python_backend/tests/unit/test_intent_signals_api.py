"""Test Intent: ADR-013 intent-signal review API.

- Keep the HTTP contract small: `{conversation_id, count, items}`.
- Preserve owner-gated 404 behavior for missing/non-owner conversations.
- Verify serialization keeps traceability anchors and sightings visible.
- Reject unknown status filters loudly.
- Exercise the first lifecycle actions through public route/service seams.
"""

from __future__ import annotations

import uuid
import os
from datetime import datetime, timezone
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import intent_signals_api


def _client(monkeypatch, payload=None, exc=None, update_payload=None, update_exc=None):
    async def fake_list(**kwargs):
        if exc:
            raise exc
        return payload or intent_signals_api.IntentSignalListResponse(
            conversation_id=str(kwargs["conversation_id"]),
            count=0,
            items=[],
        )

    async def fake_update(**kwargs):
        if update_exc:
            raise update_exc
        return update_payload or intent_signals_api.IntentSignalResponse(
            id=str(kwargs["signal_id"]),
            conversation_id=str(kwargs["conversation_id"]),
            raw_text="Can we keep this alive?",
            context_window="The speaker returned to the question twice.",
            speaker_id="Speaker A",
            status=kwargs["status"],
            sighting_count=1,
            human_reviewed=True,
            human_review_note=kwargs.get("human_review_note"),
        )

    async def fake_session():
        yield object()

    monkeypatch.setattr(intent_signals_api, "list_intent_signals_for_conversation", fake_list)
    monkeypatch.setattr(intent_signals_api, "update_intent_signal_lifecycle", fake_update)
    app = FastAPI()
    app.include_router(intent_signals_api.router)
    app.dependency_overrides[intent_signals_api.get_async_session] = fake_session
    return TestClient(app)


def test_route_returns_read_model(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    payload = intent_signals_api.IntentSignalListResponse(
        conversation_id=str(cid),
        count=1,
        items=[
            intent_signals_api.IntentSignalResponse(
                id=str(signal_id),
                conversation_id=str(cid),
                raw_text="I keep seeing the same bridge pattern",
                context_window="The group compared three design examples.",
                speaker_id="Speaker 1",
                source_utterance_ids=[str(uuid.uuid4())],
                status="active",
                emerged_at=datetime(2026, 7, 5, tzinfo=timezone.utc),
                sighting_count=1,
                detection_confidence=0.82,
                detection_model="local-qwen",
                salience=0.82,
                sightings=[],
            )
        ],
    )
    client = _client(monkeypatch, payload=payload)

    response = client.get(f"/api/conversations/{cid}/intent-signals")

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["items"][0]["raw_text"] == "I keep seeing the same bridge pattern"
    assert body["items"][0]["detection_confidence"] == 0.82


def test_missing_or_non_owner_conversation_is_404(monkeypatch):
    cid = uuid.uuid4()
    client = _client(
        monkeypatch,
        exc=intent_signals_api.IntentSignalsConversationNotFound(),
    )

    response = client.get(f"/api/conversations/{cid}/intent-signals")

    assert response.status_code == 404


def test_unknown_status_filter_is_422(monkeypatch):
    cid = uuid.uuid4()
    client = _client(monkeypatch)

    response = client.get(f"/api/conversations/{cid}/intent-signals?status=active,zombie")

    assert response.status_code == 422
    assert "zombie" in response.json()["detail"]


def test_patch_route_marks_signal_ready(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    client = _client(monkeypatch)

    response = client.patch(
        f"/api/conversations/{cid}/intent-signals/{signal_id}",
        json={"status": "ready", "human_review_note": "worth formalizing"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["human_reviewed"] is True
    assert body["human_review_note"] == "worth formalizing"


def test_patch_route_maps_missing_signal_to_404(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    client = _client(
        monkeypatch,
        update_exc=intent_signals_api.IntentSignalsSignalNotFound(),
    )

    response = client.patch(
        f"/api/conversations/{cid}/intent-signals/{signal_id}",
        json={"status": "abandoned"},
    )

    assert response.status_code == 404


def test_patch_route_rejects_unknown_lifecycle_status(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    client = _client(monkeypatch)

    response = client.patch(
        f"/api/conversations/{cid}/intent-signals/{signal_id}",
        json={"status": "formalized"},
    )

    assert response.status_code == 422


def test_serializer_includes_sightings_and_trace_ids():
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    utterance_id = uuid.uuid4()
    sighting_id = uuid.uuid4()
    signal = SimpleNamespace(
        id=signal_id,
        conversation_id=cid,
        raw_text="Can we keep this question alive?",
        context_window="A question was raised near the end of the call.",
        speaker_id="Speaker A",
        source_utterance_ids=[utterance_id],
        source_node_id=None,
        status="accumulating",
        emerged_at=datetime(2026, 7, 5, tzinfo=timezone.utc),
        sighting_count=2,
        last_sighted_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        last_sighted_conversation_id=cid,
        detection_confidence=0.91,
        detection_model="test-model",
        candidate_formal_statement=None,
        formalization_offered_at=None,
        human_reviewed=False,
        human_review_note=None,
        formalized_claim_id=None,
        formalized_node_id=None,
        salience=0.91,
        tags=["bridge"],
        created_at=None,
        updated_at=None,
    )
    sighting = SimpleNamespace(
        id=sighting_id,
        intent_signal_id=signal_id,
        conversation_id=cid,
        utterance_ids=[utterance_id],
        context_note="It came back in the next discussion.",
        sighting_confidence=0.77,
        sighted_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    serialized = intent_signals_api.serialize_intent_signal(signal, sightings=[sighting])

    assert serialized.source_utterance_ids == [str(utterance_id)]
    assert serialized.tags == ["bridge"]
    assert serialized.sightings[0].context_note == "It came back in the next discussion."


class _FakeResult:
    def __init__(self, one=None, many=None):
        self._one = one
        self._many = list(many or [])

    def scalar_one_or_none(self):
        return self._one

    def scalars(self):
        return self

    def all(self):
        return self._many


class _FakeDb:
    def __init__(self, results):
        self._results = list(results)
        self.flushed = False

    async def execute(self, _statement):
        return self._results.pop(0)

    async def flush(self):
        self.flushed = True


def _signal(**overrides):
    base = {
        "id": uuid.uuid4(),
        "conversation_id": uuid.uuid4(),
        "raw_text": "Can we keep this alive?",
        "context_window": "The same open question returned near the end.",
        "speaker_id": "Speaker A",
        "source_utterance_ids": [],
        "source_node_id": None,
        "status": "active",
        "emerged_at": datetime(2026, 7, 5, tzinfo=timezone.utc),
        "sighting_count": 1,
        "last_sighted_at": None,
        "last_sighted_conversation_id": None,
        "detection_confidence": 0.82,
        "detection_model": "test-model",
        "candidate_formal_statement": None,
        "formalization_offered_at": None,
        "human_reviewed": False,
        "human_review_note": None,
        "formalized_claim_id": None,
        "formalized_node_id": None,
        "salience": 0.82,
        "tags": [],
        "created_at": None,
        "updated_at": None,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.mark.asyncio
async def test_update_lifecycle_marks_ready_and_preserves_evidence(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    conversation = SimpleNamespace(id=cid, owner_id="owner-1")
    signal = _signal(id=signal_id, conversation_id=cid)
    db = _FakeDb([
        _FakeResult(one=conversation),
        _FakeResult(one=signal),
        _FakeResult(many=[]),
    ])
    monkeypatch.setattr(intent_signals_api, "get_current_owner_id", lambda: "owner-1")

    response = await intent_signals_api.update_intent_signal_lifecycle(
        db=db,
        conversation_id=cid,
        signal_id=signal_id,
        status="ready",
        human_review_note="  bring this to review  ",
        note_provided=True,
    )

    assert db.flushed is True
    assert signal.status == "ready"
    assert signal.human_reviewed is True
    assert signal.human_review_note == "bring this to review"
    assert signal.raw_text == "Can we keep this alive?"
    assert response.status == "ready"


@pytest.mark.asyncio
async def test_update_lifecycle_refuses_formalized_signal(monkeypatch):
    cid = uuid.uuid4()
    signal_id = uuid.uuid4()
    conversation = SimpleNamespace(id=cid, owner_id="owner-1")
    signal = _signal(id=signal_id, conversation_id=cid, status="formalized")
    db = _FakeDb([
        _FakeResult(one=conversation),
        _FakeResult(one=signal),
    ])
    monkeypatch.setattr(intent_signals_api, "get_current_owner_id", lambda: "owner-1")

    with pytest.raises(intent_signals_api.IntentSignalsLifecycleConflict):
        await intent_signals_api.update_intent_signal_lifecycle(
            db=db,
            conversation_id=cid,
            signal_id=signal_id,
            status="abandoned",
        )

    assert db.flushed is False

"""Tests for GET/PUT /api/conversations/{id}/participants."""

from __future__ import annotations

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import conversations_api
from lct_python_backend.conversations_api import (
    ParticipantIn,
    _normalize_participants_payload,
)
from lct_python_backend.db_session import get_async_session


# ---------------------------------------------------------------------------
# Direct unit tests of the normalizer
# ---------------------------------------------------------------------------


def test_normalize_drops_nameless_rows_but_keeps_ad_hoc_guests():
    """A row needs a name. A blank contact_id with a name is a valid ad-hoc
    guest (someone not in the IndrasNet contact list) — kept, contact_id None."""
    inputs = [
        ParticipantIn(contact_id="c_sahil", display_name="Sahil"),
        ParticipantIn(contact_id="", display_name="Anon"),     # ad-hoc guest — kept
        ParticipantIn(contact_id="c_x", display_name="   "),   # nameless — dropped
    ]
    result = _normalize_participants_payload(inputs)
    assert len(result) == 2
    by_name = {r["display_name"]: r for r in result}
    assert by_name["Sahil"]["contact_id"] == "c_sahil"
    assert by_name["Anon"]["contact_id"] is None


def test_normalize_dedupes_ad_hoc_guests_by_name():
    """Ad-hoc guests have no contact_id — they dedupe on display_name so the
    same guest can't be added twice. Last write wins."""
    inputs = [
        ParticipantIn(display_name="Bob", source="manual"),
        ParticipantIn(display_name="bob", source="manual"),
    ]
    result = _normalize_participants_payload(inputs)
    assert len(result) == 1
    assert result[0]["contact_id"] is None


def test_normalize_dedupes_by_contact_id_last_wins():
    inputs = [
        ParticipantIn(contact_id="c_a", display_name="First Name"),
        ParticipantIn(contact_id="c_a", display_name="Second Name"),
    ]
    result = _normalize_participants_payload(inputs)
    assert len(result) == 1
    assert result[0]["display_name"] == "Second Name"


def test_normalize_stamps_added_at_and_defaults_source():
    inputs = [ParticipantIn(contact_id="c_a", display_name="A")]
    result = _normalize_participants_payload(inputs)
    assert "added_at" in result[0]
    # ISO format with timezone
    assert "T" in result[0]["added_at"]
    assert result[0]["source"] == "picker"


def test_normalize_passes_explicit_source_through():
    inputs = [ParticipantIn(contact_id="c_a", display_name="A", source="auto")]
    result = _normalize_participants_payload(inputs)
    assert result[0]["source"] == "auto"


def test_normalize_external_llm_ok_normalized_to_bool_or_none():
    inputs = [
        ParticipantIn(contact_id="c_a", display_name="A", external_llm_ok=True),
        ParticipantIn(contact_id="c_b", display_name="B", external_llm_ok=False),
        ParticipantIn(contact_id="c_c", display_name="C"),  # absent → None
    ]
    result = _normalize_participants_payload(inputs)
    by_id = {r["contact_id"]: r for r in result}
    assert by_id["c_a"]["external_llm_ok"] is True
    assert by_id["c_b"]["external_llm_ok"] is False
    assert by_id["c_c"]["external_llm_ok"] is None


# ---------------------------------------------------------------------------
# HTTP-level tests with mocked session
# ---------------------------------------------------------------------------


class _ExecuteResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _FakeSession:
    def __init__(self, conversation=None):
        self.conversation = conversation
        self.commits = 0
        self.added = []

    async def execute(self, _stmt):
        return _ExecuteResult(self.conversation)

    async def get(self, _model, _pk):
        # ensure_conversation (stt_session) looks the row up by primary key;
        # PUT participants auto-creates the row when it's missing (b190613).
        return self.conversation

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass

    async def commit(self):
        self.commits += 1


@pytest.fixture
def make_client():
    """Build a TestClient with conversations_api mounted and the session
    dependency overridden to return our fake session."""

    def _build(conversation=None):
        app = FastAPI()
        app.include_router(conversations_api.router)
        session = _FakeSession(conversation=conversation)

        async def override():
            yield session

        app.dependency_overrides[get_async_session] = override
        return TestClient(app), session

    return _build


CONV_ID = "00000000-0000-0000-0000-000000000001"


def test_get_returns_empty_list_when_participants_null(make_client):
    conv = SimpleNamespace(
        id=uuid.UUID(CONV_ID),
        participants=None,
    )
    client, _ = make_client(conversation=conv)

    r = client.get(f"/api/conversations/{CONV_ID}/participants")
    assert r.status_code == 200
    assert r.json() == {"participants": []}


def test_get_returns_stored_participants(make_client):
    stored = [
        {"contact_id": "c_a", "display_name": "A", "source": "picker"},
        "garbage_non_dict_entry",  # should be filtered
    ]
    conv = SimpleNamespace(id=uuid.UUID(CONV_ID), participants=stored)
    client, _ = make_client(conversation=conv)

    r = client.get(f"/api/conversations/{CONV_ID}/participants")
    assert r.status_code == 200
    body = r.json()
    assert len(body["participants"]) == 1
    assert body["participants"][0]["display_name"] == "A"


def test_get_returns_404_for_unknown_conversation(make_client):
    client, _ = make_client(conversation=None)
    r = client.get(f"/api/conversations/{CONV_ID}/participants")
    assert r.status_code == 404


def test_get_returns_400_for_invalid_uuid(make_client):
    client, _ = make_client(conversation=None)
    r = client.get("/api/conversations/not-a-uuid/participants")
    assert r.status_code == 400


def test_put_persists_normalized_participants(make_client):
    conv = SimpleNamespace(
        id=uuid.UUID(CONV_ID),
        participants=None,
        participant_count=0,
    )
    client, session = make_client(conversation=conv)

    payload = {
        "participants": [
            {
                "contact_id": "c_aditya",
                "display_name": "Aditya",
                "external_llm_ok": False,
            },
            {
                "contact_id": "c_sahil",
                "display_name": "Sahil",
                "external_llm_ok": True,
                "source": "picker",
            },
        ]
    }
    r = client.put(f"/api/conversations/{CONV_ID}/participants", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert len(body["participants"]) == 2

    # Conversation row mutated and committed
    assert conv.participant_count == 2
    assert isinstance(conv.participants, list)
    assert {p["contact_id"] for p in conv.participants} == {"c_aditya", "c_sahil"}
    assert session.commits == 1


def test_put_persists_ad_hoc_guest(make_client):
    """An ad-hoc guest (contact_id null — someone not in the contact list)
    round-trips through the PUT endpoint alongside a regular contact."""
    conv = SimpleNamespace(
        id=uuid.UUID(CONV_ID),
        participants=None,
        participant_count=0,
    )
    client, _ = make_client(conversation=conv)

    payload = {
        "participants": [
            {"contact_id": "c_aditya", "display_name": "Aditya"},
            {"contact_id": None, "display_name": "Guest Speaker", "source": "manual"},
        ]
    }
    r = client.put(f"/api/conversations/{CONV_ID}/participants", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert len(body["participants"]) == 2
    guest = next(p for p in body["participants"] if p["display_name"] == "Guest Speaker")
    assert guest["contact_id"] is None
    assert guest["source"] == "manual"
    assert conv.participant_count == 2


def test_put_empty_list_clears_participants(make_client):
    conv = SimpleNamespace(
        id=uuid.UUID(CONV_ID),
        participants=[{"contact_id": "c_old", "display_name": "Old"}],
        participant_count=1,
    )
    client, _ = make_client(conversation=conv)

    r = client.put(
        f"/api/conversations/{CONV_ID}/participants", json={"participants": []}
    )
    assert r.status_code == 200
    assert r.json() == {"participants": []}
    assert conv.participants == []
    assert conv.participant_count == 0


def test_put_autocreates_row_for_unknown_conversation(make_client):
    """PUT participants no longer 404s on an unknown conversation: the row is
    lazily created by stt_session.ensure_conversation on first transcript
    event, but the frontend PUTs participants at session start — before any
    audio. The endpoint auto-creates the row to close that race (b190613)."""
    client, session = make_client(conversation=None)
    r = client.put(
        f"/api/conversations/{CONV_ID}/participants",
        json={"participants": [{"contact_id": "c_a", "display_name": "A"}]},
    )
    assert r.status_code == 200
    assert len(r.json()["participants"]) == 1
    # The conversation row was created and persisted.
    assert len(session.added) == 1
    created = session.added[0]
    assert created.id == uuid.UUID(CONV_ID)
    assert {p["contact_id"] for p in created.participants} == {"c_a"}
    assert created.participant_count == 1
    assert session.commits == 1

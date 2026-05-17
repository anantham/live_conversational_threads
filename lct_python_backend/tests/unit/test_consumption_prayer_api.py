"""Tests for the manual consumption-prayer trigger endpoint.

Mounts just the consumption_prayer_api router with FastAPI TestClient so
we don't need the full backend up. The IndrasNet client is patched at
the module boundary so tests run offline.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import consumption_prayer_api
from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
)


@pytest.fixture
def client():
    """Mount just the consumption-prayer router for isolation."""
    app = FastAPI()
    app.include_router(consumption_prayer_api.router)
    return TestClient(app)


URL = "/api/conversations/conv-abc/recommend-consumption-query"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_returns_indrasnet_body_with_provenance(client, monkeypatch):
    """The endpoint passes through IndrasNet's body and adds source/timestamp."""
    fake_body = {
        "contact": {"contact_id": "c_sahil", "display_name": "Sahil"},
        "note_path": "/path/Sahil.md",
        "status": "ok",
        "items": [
            {"text": "discuss money", "prayer_id": 412, "added_at": "...", "source": "p_a"},
        ],
        "item_count": 1,
    }
    mock = AsyncMock(return_value=fake_body)
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={
        "selected_text": "what was Sahil saying about money",
        "contact_ref": "Sahil",
    })

    assert response.status_code == 200
    body = response.json()
    # Provenance fields added by our endpoint
    assert body["source"] == "manual"
    assert body["conversation_id"] == "conv-abc"
    assert body["selected_text"] == "what was Sahil saying about money"
    assert "triggered_at" in body
    # IndrasNet body passed through
    assert body["contact"]["display_name"] == "Sahil"
    assert body["item_count"] == 1
    assert body["items"][0]["prayer_id"] == 412
    # The client was called with the trimmed contact_ref
    mock.assert_awaited_once_with("Sahil")


def test_strips_whitespace_in_contact_ref(client, monkeypatch):
    mock = AsyncMock(return_value={"items": [], "item_count": 0, "status": "ok"})
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "  Sahil  "})
    assert response.status_code == 200
    mock.assert_awaited_once_with("Sahil")


def test_selected_text_is_optional(client, monkeypatch):
    """selected_text defaults to empty string when omitted."""
    mock = AsyncMock(return_value={"items": [], "item_count": 0, "status": "ok"})
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"contact_ref": "Sahil"})
    assert response.status_code == 200
    assert response.json()["selected_text"] == ""


def test_unicode_contact_and_text_round_trip(client, monkeypatch):
    mock = AsyncMock(return_value={"items": [], "item_count": 0, "status": "ok"})
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={
        "selected_text": "kya चर्चा karna tha Bhīṣma ke saath",
        "contact_ref": "Bhīṣma",
    })
    assert response.status_code == 200
    body = response.json()
    assert "चर्चा" in body["selected_text"]
    mock.assert_awaited_once_with("Bhīṣma")


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------

def test_missing_contact_ref_returns_422(client):
    response = client.post(URL, json={"selected_text": "x"})
    assert response.status_code == 422


def test_empty_contact_ref_returns_422(client):
    """Pydantic min_length=1 rejects empty string."""
    response = client.post(URL, json={"selected_text": "x", "contact_ref": ""})
    assert response.status_code == 422


def test_whitespace_only_contact_ref_returns_400(client):
    """Pydantic accepts whitespace, but our handler strips and re-validates."""
    response = client.post(URL, json={"selected_text": "x", "contact_ref": "   "})
    assert response.status_code == 400


def test_selected_text_truncation_enforced(client):
    """Pydantic max_length on selected_text rejects huge payloads."""
    huge = "x" * 5000
    response = client.post(URL, json={"selected_text": huge, "contact_ref": "Sahil"})
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# IndrasNet error mapping
# ---------------------------------------------------------------------------

def test_unavailable_maps_to_502(client, monkeypatch):
    mock = AsyncMock(side_effect=IndrasNetUnavailable("Tailscale down"))
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "Sahil"})
    assert response.status_code == 502
    assert "Tailscale down" in response.json()["detail"]


def test_client_error_404_passes_through(client, monkeypatch):
    """When IndrasNet returns 404 (contact not found), we forward 404."""
    mock = AsyncMock(side_effect=IndrasNetClientError(
        "IndrasNet pending-discussions returned 404 for contact 'c_nope'. Body: {...}"
    ))
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "c_nope"})
    assert response.status_code == 404
    assert "404" in response.json()["detail"]


def test_other_client_errors_map_to_400(client, monkeypatch):
    """Non-404 4xx from IndrasNet means we sent something wrong → 400."""
    mock = AsyncMock(side_effect=IndrasNetClientError(
        "IndrasNet pending-discussions returned 400 for contact 'x'. Body: bad"
    ))
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "x"})
    assert response.status_code == 400


def test_server_error_maps_to_502(client, monkeypatch):
    mock = AsyncMock(side_effect=IndrasNetServerError("500 internal"))
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "Sahil"})
    assert response.status_code == 502


def test_protocol_error_maps_to_502(client, monkeypatch):
    mock = AsyncMock(side_effect=IndrasNetProtocolError("missing items key"))
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(URL, json={"selected_text": "x", "contact_ref": "Sahil"})
    assert response.status_code == 502
    assert "protocol" in response.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Conversation ID is captured
# ---------------------------------------------------------------------------

def test_conversation_id_in_response(client, monkeypatch):
    mock = AsyncMock(return_value={"items": [], "item_count": 0, "status": "ok"})
    monkeypatch.setattr(consumption_prayer_api, "get_pending_discussions", mock)

    response = client.post(
        "/api/conversations/some-uuid-here/recommend-consumption-query",
        json={"selected_text": "x", "contact_ref": "Sahil"},
    )
    assert response.json()["conversation_id"] == "some-uuid-here"

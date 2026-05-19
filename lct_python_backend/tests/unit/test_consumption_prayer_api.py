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


# ---------------------------------------------------------------------------
# /api/consumption-prayer/known-contacts
# ---------------------------------------------------------------------------

URL_KNOWN = "/api/consumption-prayer/known-contacts"


def test_known_contacts_preserves_indrasnet_order_and_passes_ranking_fields(client, monkeypatch):
    """IndrasNet returns contacts ordered by last_activity DESC. The proxy
    must preserve that order (NOT alphabetize) and pass through ranking +
    privacy fields the picker needs (last_activity, item_count,
    external_llm_ok, privacy_tier)."""
    fake_payload = [
        {
            "contact_id": "c_zoe", "display_name": "Zoe",
            "last_activity": "2026-05-18 20:48:38+00:00",
            "item_count": 1248, "external_llm_ok": 0, "privacy_tier": "T3",
            "obsidian_note_path": "/x",
        },
        {
            "contact_id": "c_alice", "display_name": "Alice",
            "last_activity": "2026-05-18 19:00:00+00:00",
            "item_count": 88, "external_llm_ok": 1, "privacy_tier": "T2",
            "extra_field": "ignored",
        },
        {
            "contact_id": "c_bob", "display_name": "Bob",
            "last_activity": "2026-02-23 09:30:21+00:00",
            "item_count": 5,
            # external_llm_ok and privacy_tier intentionally absent — must default safely
        },
    ]

    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return fake_payload

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None): return _MockResponse()

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)

    response = client.get(URL_KNOWN)
    assert response.status_code == 200
    body = response.json()
    contacts = body["contacts"]

    # Order preserved from IndrasNet (Zoe first because most recent activity)
    assert [c["display_name"] for c in contacts] == ["Zoe", "Alice", "Bob"]

    # Ranking + privacy fields surfaced
    zoe = contacts[0]
    assert zoe["last_activity"] == "2026-05-18 20:48:38+00:00"
    assert zoe["item_count"] == 1248
    assert zoe["external_llm_ok"] is False  # 0 from IndrasNet normalized to bool
    assert zoe["privacy_tier"] == "T3"

    alice = contacts[1]
    assert alice["external_llm_ok"] is True  # 1 → True

    # Missing optional fields default safely (None / False)
    bob = contacts[2]
    assert bob["external_llm_ok"] is False
    assert bob["privacy_tier"] is None

    # Unrelated extra fields from IndrasNet are still dropped
    assert "obsidian_note_path" not in zoe
    assert "extra_field" not in alice


def test_known_contacts_handles_dict_response_shape(client, monkeypatch):
    """If IndrasNet returns {contacts: [...]} instead of a bare list,
    we still extract correctly."""
    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"contacts": [{"contact_id": "c_x", "display_name": "X"}]}

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None): return _MockResponse()

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_KNOWN)
    assert response.status_code == 200
    assert response.json()["contacts"][0]["display_name"] == "X"


def test_known_contacts_filters_invalid_entries(client, monkeypatch):
    """Contacts missing contact_id or display_name are dropped silently."""
    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return [
            {"contact_id": "c_ok", "display_name": "OK"},
            {"contact_id": "c_no_name"},  # missing display_name
            {"display_name": "No ID"},   # missing contact_id
            {"contact_id": "c_empty", "display_name": "   "},  # whitespace-only
            "not_a_dict",
        ]

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None): return _MockResponse()

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_KNOWN)
    contacts = response.json()["contacts"]
    assert len(contacts) == 1
    assert contacts[0]["display_name"] == "OK"


def test_known_contacts_returns_empty_on_indrasnet_failure(client, monkeypatch):
    """When IndrasNet is unreachable, the picker still loads — empty options
    are better than blocking the entire toolbar."""
    import httpx

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            raise httpx.ConnectError("Tailscale down")

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_KNOWN)
    assert response.status_code == 200  # NOT 502 — graceful degradation
    body = response.json()
    assert body["contacts"] == []
    assert "indrasnet_error" in body
    assert "Tailscale down" in body["indrasnet_error"]


def test_known_contacts_returns_empty_on_non_json_response(client, monkeypatch):
    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): raise ValueError("not json")

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None): return _MockResponse()

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_KNOWN)
    assert response.status_code == 200
    body = response.json()
    assert body["contacts"] == []
    assert body["indrasnet_error"] == "non-JSON response"


# ---------------------------------------------------------------------------
# /known-contacts — pagination behavior (Option B fix)
# ---------------------------------------------------------------------------


def _capture_params_client(captured: dict, payload):
    """Build a MockClient that records the params= passed by the proxy."""
    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return payload

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            captured["url"] = url
            captured["params"] = dict(params or {})
            return _MockResponse()

    return _MockClient


def test_known_contacts_defaults_to_limit_50(client, monkeypatch):
    """Picker mount should ask IndrasNet for only the top-N most-recent
    contacts — the previous limit=500 took ~5s and frequently timed out."""
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    response = client.get(URL_KNOWN)
    assert response.status_code == 200
    assert captured["params"]["limit"] == "50"
    assert "search" not in captured["params"]


def test_known_contacts_honors_explicit_limit_query_param(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    response = client.get(URL_KNOWN + "?limit=10")
    assert response.status_code == 200
    assert captured["params"]["limit"] == "10"


def test_known_contacts_clamps_limit_to_max(client, monkeypatch):
    """Prevent a client from asking for the full list and DOSing the proxy
    timeout. Hard cap at PICKER_MAX_LIMIT."""
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    response = client.get(URL_KNOWN + "?limit=9999")
    assert response.status_code == 200
    assert int(captured["params"]["limit"]) == consumption_prayer_api.PICKER_MAX_LIMIT


def test_known_contacts_clamps_zero_and_negative_limit(client, monkeypatch):
    """A nonsensical limit shouldn't ask IndrasNet for 0 rows."""
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    client.get(URL_KNOWN + "?limit=0")
    assert int(captured["params"]["limit"]) >= 1


# ---------------------------------------------------------------------------
# /known-contacts/search — long-tail lookup
# ---------------------------------------------------------------------------

URL_SEARCH = "/api/consumption-prayer/known-contacts/search"


def test_search_returns_empty_for_empty_query(client, monkeypatch):
    """Empty q skips the upstream call entirely — the top-N endpoint
    handles the initial render. No reason to round-trip IndrasNet here."""
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    response = client.get(URL_SEARCH + "?q=")
    assert response.status_code == 200
    body = response.json()
    assert body == {"contacts": [], "query": ""}
    # IndrasNet was NOT called
    assert captured == {}


def test_search_forwards_query_to_indrasnet(client, monkeypatch):
    """Server-side search across all contacts (covers names outside top-50)."""
    fake_payload = [
        {
            "contact_id": "c_vinay", "display_name": "Vinay",
            "external_llm_ok": 0, "privacy_tier": "T3",
            "last_activity": "2024-01-01", "item_count": 5,
        },
    ]
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, fake_payload),
    )
    response = client.get(URL_SEARCH + "?q=vinay")
    assert response.status_code == 200
    body = response.json()
    assert captured["params"]["search"] == "vinay"
    assert body["query"] == "vinay"
    assert len(body["contacts"]) == 1
    assert body["contacts"][0]["display_name"] == "Vinay"
    # Same field shape as /known-contacts so the frontend can render either
    assert body["contacts"][0]["external_llm_ok"] is False
    assert body["contacts"][0]["privacy_tier"] == "T3"


def test_search_strips_whitespace_in_query(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _capture_params_client(captured, []),
    )
    client.get(URL_SEARCH + "?q=%20%20saksham%20%20")  # "  saksham  "
    assert captured["params"]["search"] == "saksham"


def test_search_returns_empty_on_indrasnet_failure(client, monkeypatch):
    """Same graceful-degradation contract as /known-contacts."""
    import httpx

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_SEARCH + "?q=anything")
    assert response.status_code == 200
    body = response.json()
    assert body["contacts"] == []
    assert body["query"] == "anything"
    assert "indrasnet_error" in body


def test_search_empty_exception_string_does_not_swallow_error(client, monkeypatch):
    """ReadTimeout's str() is empty — must not return '' as indrasnet_error
    (silently hides the failure). Helper falls back to exception class name."""
    import httpx

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            raise httpx.ReadTimeout("")  # empty message

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _MockClient)
    response = client.get(URL_SEARCH + "?q=anything")
    body = response.json()
    # Either the empty message or the class name — but never silently blank.
    assert body.get("indrasnet_error"), \
        f"expected a non-empty indrasnet_error, got {body!r}"

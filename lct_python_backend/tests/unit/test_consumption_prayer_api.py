"""Tests for the manual consumption-prayer trigger endpoint.

Mounts just the consumption_prayer_api router with FastAPI TestClient so
we don't need the full backend up. The IndrasNet client is patched at
the module boundary so tests run offline.
"""

from __future__ import annotations

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lct_python_backend import consumption_prayer_api
from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
)


@pytest.fixture(autouse=True)
def _enable_indrasnet(monkeypatch):
    """These tests exercise the IndrasNet-backed paths, so the capability gate
    (ADR-034 §D2) must be ON. A real owner deployment sets INDRASNET_BASE_URL;
    without it the gate now fails closed (no hardcoded fallback), which is the
    point of the gate but would short-circuit these fetch tests."""
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://test-indras:7777")
    monkeypatch.delenv("ENABLE_INDRASNET", raising=False)


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


# ---------------------------------------------------------------------------
# _fetch_indrasnet_contacts — the live IndrasNet fetch. The /known-contacts
# endpoint no longer calls this inline (it serves from the cache); this
# function is now exercised by the background cache refresher and /search.
# ---------------------------------------------------------------------------


def _httpx_mock(payload=None, *, raise_exc=None, json_raises=False):
    """Mock httpx.AsyncClient: returns `payload` as JSON, raises `raise_exc`
    from .get(), or raises ValueError from .json() when json_raises."""
    class _MockResponse:
        status_code = 200
        def raise_for_status(self): pass
        def json(self):
            if json_raises:
                raise ValueError("not json")
            return payload

    class _MockClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            if raise_exc is not None:
                raise raise_exc
            return _MockResponse()

    return _MockClient


@pytest.mark.asyncio
async def test_fetch_preserves_order_and_ranking_fields(monkeypatch):
    """IndrasNet returns contacts ordered by last_activity DESC. _fetch must
    preserve that order and pass through ranking + privacy fields."""
    payload = [
        {"contact_id": "c_zoe", "display_name": "Zoe",
         "last_activity": "2026-05-18 20:48:38+00:00",
         "item_count": 1248, "external_llm_ok": 0, "privacy_tier": "T3",
         "obsidian_note_path": "/x"},
        {"contact_id": "c_alice", "display_name": "Alice",
         "last_activity": "2026-05-18 19:00:00+00:00",
         "item_count": 88, "external_llm_ok": 1, "privacy_tier": "T2",
         "extra_field": "ignored"},
        {"contact_id": "c_bob", "display_name": "Bob",
         "last_activity": "2026-02-23 09:30:21+00:00", "item_count": 5},
    ]
    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _httpx_mock(payload))
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert err is None
    assert [c["display_name"] for c in contacts] == ["Zoe", "Alice", "Bob"]
    zoe = contacts[0]
    assert zoe["item_count"] == 1248
    assert zoe["external_llm_ok"] is False  # 0 normalized to bool
    assert zoe["privacy_tier"] == "T3"
    assert contacts[1]["external_llm_ok"] is True  # 1 → True
    bob = contacts[2]
    assert bob["external_llm_ok"] is False  # missing → safe default
    assert bob["privacy_tier"] is None
    assert "obsidian_note_path" not in zoe
    assert "extra_field" not in contacts[1]


@pytest.mark.asyncio
async def test_fetch_handles_dict_response_shape(monkeypatch):
    """IndrasNet may return {contacts:[...]} instead of a bare list."""
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _httpx_mock({"contacts": [{"contact_id": "c_x", "display_name": "X"}]}),
    )
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert err is None
    assert contacts[0]["display_name"] == "X"


@pytest.mark.asyncio
async def test_fetch_filters_invalid_entries(monkeypatch):
    """Entries missing contact_id or display_name are dropped silently."""
    payload = [
        {"contact_id": "c_ok", "display_name": "OK"},
        {"contact_id": "c_no_name"},
        {"display_name": "No ID"},
        {"contact_id": "c_empty", "display_name": "   "},
        "not_a_dict",
    ]
    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _httpx_mock(payload))
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert err is None
    assert [c["display_name"] for c in contacts] == ["OK"]


@pytest.mark.asyncio
async def test_fetch_returns_error_on_indrasnet_failure(monkeypatch):
    """Unreachable IndrasNet → (empty, error string). Never raises."""
    import httpx as _httpx
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _httpx_mock(raise_exc=_httpx.ConnectError("Tailscale down")),
    )
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert contacts == []
    assert err and "Tailscale down" in err


@pytest.mark.asyncio
async def test_fetch_degrades_when_indrasnet_disabled(monkeypatch):
    """ADR-034 §D2: when the gate is OFF (public profile), the picker must
    degrade to (empty, reason) — never 500 and never dial the owner's box.
    httpx must NOT be touched (we fail closed before any network call)."""
    monkeypatch.setenv("ENABLE_INDRASNET", "0")

    def _boom(*a, **k):
        raise AssertionError("disabled gate must not make an HTTP call")

    monkeypatch.setattr(consumption_prayer_api.httpx, "AsyncClient", _boom)
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert contacts == []
    assert err and "disabled" in err.lower()


@pytest.mark.asyncio
async def test_fetch_returns_error_on_non_json(monkeypatch):
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient", _httpx_mock(json_raises=True),
    )
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert contacts == []
    assert err == "non-JSON response"


@pytest.mark.asyncio
async def test_fetch_empty_exception_string_falls_back_to_class_name(monkeypatch):
    """ReadTimeout's str() is empty — error must never be a blank string
    (a blank error silently hides the failure)."""
    import httpx as _httpx
    monkeypatch.setattr(
        consumption_prayer_api.httpx, "AsyncClient",
        _httpx_mock(raise_exc=_httpx.ReadTimeout("")),
    )
    contacts, err = await consumption_prayer_api._fetch_indrasnet_contacts(limit=50)
    assert contacts == []
    assert err  # non-empty — falls back to the exception class name


# ---------------------------------------------------------------------------
# /known-contacts endpoint — now cache-backed. Serves the last-known-good
# list from services/contacts_cache and revalidates in the background.
# ---------------------------------------------------------------------------


def _cache_client():
    """TestClient with the DB session dependency stubbed (the endpoint's
    cache reads are patched separately, so the session is never used)."""
    app = FastAPI()
    app.include_router(consumption_prayer_api.router)

    async def _fake_session():
        yield object()

    app.dependency_overrides[get_async_session] = _fake_session
    return TestClient(app)


def _patch_cache(monkeypatch, cache_value):
    """Patch read_contacts_cache to return cache_value and stub
    warm_contacts_cache to record calls (no real background task)."""
    warm_calls = []

    async def _fake_read(_db):
        return cache_value

    monkeypatch.setattr(consumption_prayer_api, "read_contacts_cache", _fake_read)
    monkeypatch.setattr(
        consumption_prayer_api, "warm_contacts_cache",
        lambda: warm_calls.append(1),
    )
    return warm_calls


def _fresh_cache(contacts):
    import datetime
    return {
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "contacts": contacts,
    }


def test_endpoint_serves_cached_contacts(monkeypatch):
    contacts = [{"contact_id": f"c{i}", "display_name": f"P{i}"} for i in range(10)]
    _patch_cache(monkeypatch, _fresh_cache(contacts))
    r = _cache_client().get(URL_KNOWN)
    assert r.status_code == 200
    body = r.json()
    assert body["cached"] is True
    assert body["stale"] is False
    assert [c["display_name"] for c in body["contacts"]] == [f"P{i}" for i in range(10)]


def test_endpoint_slices_to_limit(monkeypatch):
    contacts = [{"contact_id": f"c{i}", "display_name": f"P{i}"} for i in range(60)]
    _patch_cache(monkeypatch, _fresh_cache(contacts))
    client = _cache_client()
    assert len(client.get(URL_KNOWN + "?limit=5").json()["contacts"]) == 5
    assert len(client.get(URL_KNOWN).json()["contacts"]) == consumption_prayer_api.PICKER_DEFAULT_LIMIT


def test_endpoint_clamps_limit_to_max(monkeypatch):
    contacts = [{"contact_id": f"c{i}", "display_name": f"P{i}"} for i in range(300)]
    _patch_cache(monkeypatch, _fresh_cache(contacts))
    n = len(_cache_client().get(URL_KNOWN + "?limit=9999").json()["contacts"])
    assert n == consumption_prayer_api.PICKER_MAX_LIMIT


def test_endpoint_cold_cache_returns_empty_and_schedules_warm(monkeypatch):
    """No cache yet → empty list + a background refresh scheduled."""
    warm_calls = _patch_cache(monkeypatch, None)
    body = _cache_client().get(URL_KNOWN).json()
    assert body["contacts"] == []
    assert body["cached"] is False
    assert len(warm_calls) == 1


def test_endpoint_stale_cache_still_serves_and_revalidates(monkeypatch):
    """A stale cache is still served (beats empty) and triggers a refresh."""
    import datetime
    old = (datetime.datetime.now(datetime.timezone.utc)
           - datetime.timedelta(hours=2)).isoformat()
    stale = {"fetched_at": old,
             "contacts": [{"contact_id": "c1", "display_name": "Stale Sam"}]}
    warm_calls = _patch_cache(monkeypatch, stale)
    body = _cache_client().get(URL_KNOWN).json()
    assert body["cached"] is True
    assert body["stale"] is True
    assert body["contacts"][0]["display_name"] == "Stale Sam"
    assert len(warm_calls) == 1


# ---------------------------------------------------------------------------
# /known-contacts/search — long-tail lookup. Still a live IndrasNet call
# (search queries are unbounded — not cacheable like the top-N list).
# ---------------------------------------------------------------------------

URL_SEARCH = "/api/consumption-prayer/known-contacts/search"


def _capture_params_client(captured: dict, payload):
    """MockClient that records the params= the proxy sent to IndrasNet."""
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

"""Unit tests for indrasnet_client — uses httpx MockTransport.

These cover the contract with the sibling IndrasNet /api/prayers/match route
without needing a running server. The error policy from AGENTS.md
(§Error Logging — no silent failures) is the most load-bearing thing tested
here: a hidden network failure that silently swallows real prayers would
defeat the whole point of the feature.

Test Intent:
- Keep each IndrasNet HTTP contract encoded at the client boundary.
- Verify live prayer detection sends evidence/provenance to the new route.
- Ensure upstream transport/protocol failures never degrade silently.
"""

import json

import httpx
import pytest

from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetDisabled,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
    detect_lct_prayer,
    get_indrasnet_base_url,
    get_match_timeout_seconds,
    get_pending_discussions,
    indrasnet_enabled,
    match_prayers,
)


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """Each test starts with no INDRASNET_* env vars unless it sets them."""
    for var in (
        "INDRASNET_BASE_URL",
        "INDRASNET_MATCH_TIMEOUT_SECONDS",
        "ENABLE_INDRASNET",
    ):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# Capability gate (ADR-034 §D2) — fail CLOSED, no hardcoded fallback
# ---------------------------------------------------------------------------

def test_base_url_env_override(monkeypatch):
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://localhost:9999/")
    # Trailing slash stripped
    assert get_indrasnet_base_url() == "http://localhost:9999"


def test_disabled_when_nothing_configured():
    """No URL + no flag → disabled, and resolving the URL fails CLOSED
    (no silent fall-back to the owner's live instance — the old bug)."""
    assert indrasnet_enabled() is False
    with pytest.raises(IndrasNetDisabled):
        get_indrasnet_base_url()


def test_enabled_via_url_only(monkeypatch):
    """Owner profile: URL set, flag unset → enabled (backward compatible)."""
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://localhost:9999")
    assert indrasnet_enabled() is True
    assert get_indrasnet_base_url() == "http://localhost:9999"


def test_empty_url_is_disabled(monkeypatch):
    """Empty URL is 'not configured' → disabled (no hardcoded default)."""
    monkeypatch.setenv("INDRASNET_BASE_URL", "")
    assert indrasnet_enabled() is False
    with pytest.raises(IndrasNetDisabled):
        get_indrasnet_base_url()


def test_explicit_flag_off_overrides_set_url(monkeypatch):
    """Public-profile kill switch: ENABLE_INDRASNET=0 disables even if a URL
    leaked into the env."""
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://localhost:9999")
    monkeypatch.setenv("ENABLE_INDRASNET", "0")
    assert indrasnet_enabled() is False
    with pytest.raises(IndrasNetDisabled):
        get_indrasnet_base_url()


def test_explicit_flag_on_without_url_fails_closed(monkeypatch):
    """ENABLE_INDRASNET=1 but no URL → enabled gate, but resolving refuses to
    guess an endpoint (fails closed rather than dialing a hardcoded IP)."""
    monkeypatch.setenv("ENABLE_INDRASNET", "1")
    assert indrasnet_enabled() is True
    with pytest.raises(IndrasNetDisabled):
        get_indrasnet_base_url()


def test_explicit_flag_on_with_url(monkeypatch):
    monkeypatch.setenv("ENABLE_INDRASNET", "true")
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://localhost:9999")
    assert indrasnet_enabled() is True
    assert get_indrasnet_base_url() == "http://localhost:9999"


def test_disabled_is_subclass_of_unavailable():
    """Callers that already degrade on IndrasNetUnavailable get 'disabled'
    handling for free."""
    assert issubclass(IndrasNetDisabled, IndrasNetUnavailable)


def test_timeout_default():
    assert get_match_timeout_seconds() == 5.0


def test_timeout_env_override(monkeypatch):
    monkeypatch.setenv("INDRASNET_MATCH_TIMEOUT_SECONDS", "2.5")
    assert get_match_timeout_seconds() == 2.5


def test_timeout_invalid_env_falls_back(monkeypatch):
    monkeypatch.setenv("INDRASNET_MATCH_TIMEOUT_SECONDS", "not-a-number")
    assert get_match_timeout_seconds() == 5.0


# ---------------------------------------------------------------------------
# Happy path — mock 200 with matches
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_match_prayers_returns_full_body(monkeypatch):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "matches": [
                    {
                        "instance_id": 412,
                        "prayer_type": "Remind",
                        "args": {"title": "money and parental relationships"},
                        "score": 0.42,
                        "breakdown": {"recency_factor": 0.9},
                        "days_ago": 32,
                    }
                ],
                "query": {
                    "topic_hints": ["money", "parents"],
                    "filtered_types": ["Remind", "Connect"],
                    "candidate_count": 1,
                    "returned_count": 1,
                    "threshold": 0.05,
                },
            },
        )

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    body = await match_prayers(
        context_text="I want to bring up the money stuff with my parents",
        topic_hints=["money", "parents"],
        max_results=3,
        base_url="http://test-indras:7777",
    )

    assert captured["url"] == "http://test-indras:7777/api/prayers/match"
    assert captured["payload"] == {
        "context_text": "I want to bring up the money stuff with my parents",
        "topic_hints": ["money", "parents"],
        "max_results": 3,
        "min_score": 0.05,
    }
    assert len(body["matches"]) == 1
    assert body["matches"][0]["instance_id"] == 412
    assert body["query"]["candidate_count"] == 1


@pytest.mark.asyncio
async def test_empty_matches_is_a_valid_response(monkeypatch):
    """200 with matches=[] is normal — not a failure case."""
    def handler(request):
        return httpx.Response(200, json={"matches": [], "query": {"candidate_count": 27, "returned_count": 0, "threshold": 0.05}})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    body = await match_prayers(context_text="completely unrelated topic", base_url="http://x")
    assert body["matches"] == []
    assert body["query"]["candidate_count"] == 27


# ---------------------------------------------------------------------------
# Error paths — these MUST be loud, not silent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_connect_error_raises_unavailable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("connection refused")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetUnavailable) as exc_info:
        await match_prayers(context_text="x", base_url="http://nope:7777")
    assert "unreachable" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_read_timeout_raises_unavailable(monkeypatch):
    def handler(request):
        raise httpx.ReadTimeout("too slow")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetUnavailable) as exc_info:
        await match_prayers(context_text="x", base_url="http://x")
    assert "timed out" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_4xx_raises_client_error(monkeypatch):
    def handler(request):
        return httpx.Response(400, text="bad payload")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetClientError):
        await match_prayers(context_text="x", base_url="http://x")


@pytest.mark.asyncio
async def test_5xx_raises_server_error(monkeypatch):
    def handler(request):
        return httpx.Response(503, text="overloaded")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetServerError):
        await match_prayers(context_text="x", base_url="http://x")


@pytest.mark.asyncio
async def test_non_json_body_raises_protocol_error(monkeypatch):
    def handler(request):
        return httpx.Response(200, text="<html>not json</html>")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetProtocolError):
        await match_prayers(context_text="x", base_url="http://x")


@pytest.mark.asyncio
async def test_missing_matches_key_raises_protocol_error(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"unexpected": "shape"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetProtocolError) as exc_info:
        await match_prayers(context_text="x", base_url="http://x")
    assert "matches" in str(exc_info.value)


# ---------------------------------------------------------------------------
# get_pending_discussions
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pending_happy_path_by_contact_id(monkeypatch):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        return httpx.Response(200, json={
            "contact": {"contact_id": "c_sahil", "display_name": "Sahil"},
            "note_path": "/path/Sahil.md",
            "status": "ok",
            "items": [
                {"text": "discuss money", "prayer_id": 412, "added_at": "...", "source": "p_a"},
                {"text": "check Deer Park", "prayer_id": 433, "added_at": "...", "source": None},
            ],
            "item_count": 2,
        })

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    body = await get_pending_discussions("c_sahil", base_url="http://test:7777")

    assert captured["method"] == "GET"
    assert captured["url"] == "http://test:7777/api/contacts/c_sahil/pending-discussions"
    assert body["item_count"] == 2
    assert body["status"] == "ok"
    assert body["items"][0]["prayer_id"] == 412


@pytest.mark.asyncio
async def test_pending_url_encodes_display_name_with_spaces(monkeypatch):
    captured: dict = {}

    def handler(request):
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"items": [], "item_count": 0, "status": "ok"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    await get_pending_discussions("Sahil Saxena", base_url="http://x")
    # Space encoded as %20, slashes safe-escaped
    assert "Sahil%20Saxena" in captured["url"]


@pytest.mark.asyncio
async def test_pending_url_encodes_unicode_name(monkeypatch):
    captured: dict = {}

    def handler(request):
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"items": [], "item_count": 0, "status": "ok"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    await get_pending_discussions("Bhīṣma", base_url="http://x")
    # Unicode is percent-encoded
    assert "%C4%AB" in captured["url"] or "Bh%C4%AB" in captured["url"]


@pytest.mark.asyncio
async def test_pending_empty_contact_ref_raises_client_error():
    with pytest.raises(IndrasNetClientError, match="non-empty"):
        await get_pending_discussions("")

    with pytest.raises(IndrasNetClientError, match="non-empty"):
        await get_pending_discussions("   ")


@pytest.mark.asyncio
async def test_pending_404_raises_client_error(monkeypatch):
    def handler(request):
        return httpx.Response(404, json={"detail": "Contact not found"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetClientError) as exc_info:
        await get_pending_discussions("c_nope", base_url="http://x")
    assert "404" in str(exc_info.value)


@pytest.mark.asyncio
async def test_pending_connect_failure_raises_unavailable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("dns failure")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetUnavailable):
        await get_pending_discussions("c_x", base_url="http://nope")


@pytest.mark.asyncio
async def test_pending_5xx_raises_server_error(monkeypatch):
    def handler(request):
        return httpx.Response(500, text="kaboom")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetServerError):
        await get_pending_discussions("c_x", base_url="http://x")


@pytest.mark.asyncio
async def test_pending_non_json_raises_protocol_error(monkeypatch):
    def handler(request):
        return httpx.Response(200, text="<html>oops</html>")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetProtocolError):
        await get_pending_discussions("c_x", base_url="http://x")


@pytest.mark.asyncio
async def test_pending_missing_items_key_raises_protocol_error(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"contact": "x", "status": "ok"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetProtocolError) as exc_info:
        await get_pending_discussions("c_x", base_url="http://x")
    assert "items" in str(exc_info.value)


# ---------------------------------------------------------------------------
# detect_lct_prayer
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lct_prayer_detect_posts_evidence_and_returns_cards(monkeypatch):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "ok": True,
                "conversation_id": "conv-1",
                "decision": {
                    "urgency": "now",
                    "surface_mode": "interrupt",
                    "auto_actuate": True,
                },
                "cards": [
                    {
                        "card_id": "fetch_1",
                        "card_type": "fetch",
                        "status": "executed",
                        "results": [],
                    },
                ],
            },
        )

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    body = await detect_lct_prayer(
        signal_text="fetch: Deer Park thread",
        selected_text="Deer Park thread",
        conversation_id="conv-1",
        source="lct_manual_fetch",
        max_results=4,
        base_url="http://test:7777",
    )

    assert captured["url"] == "http://test:7777/api/lct/prayers/detect"
    assert captured["payload"]["signal_text"] == "fetch: Deer Park thread"
    assert captured["payload"]["selected_text"] == "Deer Park thread"
    assert captured["payload"]["conversation_id"] == "conv-1"
    assert captured["payload"]["source"] == "lct_manual_fetch"
    assert captured["payload"]["max_results"] == 4
    assert body["cards"][0]["status"] == "executed"


@pytest.mark.asyncio
async def test_lct_prayer_detect_missing_contract_raises_protocol_error(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"ok": True, "cards": []})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetProtocolError) as exc_info:
        await detect_lct_prayer(signal_text="fetch: x", base_url="http://x")
    assert "decision/cards" in str(exc_info.value)


@pytest.mark.asyncio
async def test_lct_prayer_detect_5xx_raises_server_error(monkeypatch):
    def handler(request):
        return httpx.Response(503, text="offline")

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", _async_client_with_transport(transport))

    with pytest.raises(IndrasNetServerError):
        await detect_lct_prayer(signal_text="fetch: x", base_url="http://x")


# ---------------------------------------------------------------------------
# Helper: build an AsyncClient class that injects MockTransport
# ---------------------------------------------------------------------------

def _async_client_with_transport(transport):
    """Returns a class that behaves like httpx.AsyncClient but uses the given transport.

    monkeypatch.setattr on the httpx module replaces AsyncClient globally for
    the test, so the client wrapped in our `async with httpx.AsyncClient(...)`
    uses MockTransport instead of real network.
    """
    real_cls = httpx.AsyncClient

    class _MockedAsyncClient(real_cls):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    return _MockedAsyncClient

"""Unit tests for indrasnet_client — uses httpx MockTransport.

These cover the contract with the sibling IndrasNet /api/prayers/match route
without needing a running server. The error policy from AGENTS.md
(§Error Logging — no silent failures) is the most load-bearing thing tested
here: a hidden network failure that silently swallows real prayers would
defeat the whole point of the feature.
"""

import json

import httpx
import pytest

from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
    get_indrasnet_base_url,
    get_match_timeout_seconds,
    match_prayers,
)


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """Each test starts with no INDRASNET_* env vars unless it sets them."""
    for var in ("INDRASNET_BASE_URL", "INDRASNET_MATCH_TIMEOUT_SECONDS"):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# Config defaults
# ---------------------------------------------------------------------------

def test_default_base_url():
    assert get_indrasnet_base_url() == "http://100.81.65.74:7777"


def test_base_url_env_override(monkeypatch):
    monkeypatch.setenv("INDRASNET_BASE_URL", "http://localhost:9999/")
    # Trailing slash stripped
    assert get_indrasnet_base_url() == "http://localhost:9999"


def test_base_url_empty_env_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("INDRASNET_BASE_URL", "")
    assert get_indrasnet_base_url() == "http://100.81.65.74:7777"


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

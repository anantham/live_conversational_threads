"""Join-path tests for POST /api/attendee/meetings (M0 — "prove the bot joins").

Hermetic: no real Attendee, no Docker, no websocket. We stub the bridge's
MeetingSession + registry and ``attendee_client`` so the endpoint's guardrails
and dispatch contract are exercised:

- not configured → 400
- non-http meeting_url → 422
- dedup reuses a live session (no second bot)
- dry_run never dispatches a real bot
- a configured install dispatches create_bot and returns bot_id/viewer_ws

The REAL bot join (a live Chrome joining Google Meet) is a manual smoke test —
these tests pin the code path up to that boundary.
"""

from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/lct_test")

from lct_python_backend import attendee_api  # noqa: E402
from lct_python_backend.services import attendee_bridge  # noqa: E402
from lct_python_backend.services import attendee_client  # noqa: E402

MEET_URL = "https://meet.google.com/abc-defg-hij"


async def _noop_async(*args, **kwargs):
    return None


class _FakeSession:
    def __init__(self, *, conversation_id, meeting_url, bot_name):
        self.conversation_id = conversation_id
        self.meeting_url = meeting_url
        self.bot_name = bot_name
        self.bot_id = None
        self.status = "starting"
        self.bot_state = None

    async def start(self):
        self.status = "joining"

    async def close(self, reason="closed"):
        self.status = "error" if reason == "create_bot_failed" else "ended"

    def attach_bot(self, bot_id):
        self.bot_id = bot_id


def _stub_bridge(monkeypatch, *, live_url=None):
    """Stub the bridge so create_meeting never opens a real websocket."""
    monkeypatch.setattr(attendee_bridge, "MeetingSession", _FakeSession)
    monkeypatch.setattr(attendee_bridge, "register", _noop_async)
    monkeypatch.setattr(attendee_bridge, "bind_bot", _noop_async)

    def get_by_meeting_url(url):
        if live_url is not None and url.split("?")[0] == live_url:
            fake = _FakeSession(conversation_id="conv-live", meeting_url=url, bot_name="LCT")
            fake.bot_id = "bot-live"
            fake.status = "recording"
            fake.bot_state = "recording"
            return fake
        return None

    monkeypatch.setattr(attendee_bridge, "get_by_meeting_url", get_by_meeting_url)


def _stub_client(monkeypatch, *, configured=True, bot=None):
    monkeypatch.setattr(attendee_client, "is_configured", lambda: configured)

    async def fake_create_bot(**kwargs):
        return bot or {"id": "bot-1", "state": "joining"}

    monkeypatch.setattr(attendee_client, "create_bot", fake_create_bot)


# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------

def test_create_meeting_not_configured_returns_400(monkeypatch):
    _stub_client(monkeypatch, configured=False)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url=MEET_URL)
        )

    resp = asyncio.run(_run())
    assert resp.status_code == 400
    assert "not configured" in resp.body.decode().lower()


def test_create_meeting_non_http_url_returns_422(monkeypatch):
    _stub_client(monkeypatch, configured=True)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url="meet.google.com/abc")
        )

    resp = asyncio.run(_run())
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Dedup (reuse a live session, dispatch no second bot)
# ---------------------------------------------------------------------------

def test_create_meeting_dedups_live_session(monkeypatch):
    _stub_client(monkeypatch, configured=True)
    _stub_bridge(monkeypatch, live_url=MEET_URL)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url=MEET_URL)
        )

    resp = asyncio.run(_run())
    assert resp["conversation_id"] == "conv-live"
    assert resp["deduplicated"] is True
    assert resp["bot_id"] == "bot-live"
    assert resp["viewer_ws"] == "/ws/meeting/conv-live"


# ---------------------------------------------------------------------------
# Dry-run (no real bot)
# ---------------------------------------------------------------------------

def test_create_meeting_dry_run_dispatches_no_bot(monkeypatch):
    _stub_client(monkeypatch, configured=True)
    _stub_bridge(monkeypatch)
    monkeypatch.setenv("ATTENDEE_ALLOW_DRY_RUN", "1")
    called = []

    async def spy_create_bot(**kwargs):
        called.append(kwargs)
        return {"id": "should-not-exist", "state": "joining"}

    monkeypatch.setattr(attendee_client, "create_bot", spy_create_bot)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url=MEET_URL, dry_run=True)
        )

    resp = asyncio.run(_run())
    assert resp["dry_run"] is True
    assert resp["conversation_id"]
    assert resp["viewer_ws"] == f"/ws/meeting/{resp['conversation_id']}"
    assert called == []  # a real bot was never dispatched


def test_create_meeting_dry_run_flag_ignored_without_env(monkeypatch):
    """dry_run=True without ATTENDEE_ALLOW_DRY_RUN=1 must fall through to a real bot."""
    _stub_client(monkeypatch, configured=True)
    _stub_bridge(monkeypatch)
    monkeypatch.delenv("ATTENDEE_ALLOW_DRY_RUN", raising=False)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url=MEET_URL, dry_run=True)
        )

    resp = asyncio.run(_run())
    assert resp.get("dry_run") is not True
    assert resp["bot_id"] == "bot-1"


# ---------------------------------------------------------------------------
# Real dispatch contract
# ---------------------------------------------------------------------------

def test_create_meeting_dispatches_bot_and_returns_viewer(monkeypatch):
    _stub_client(monkeypatch, configured=True)
    _stub_bridge(monkeypatch)

    async def _run():
        return await attendee_api.create_meeting(
            attendee_api.CreateMeetingRequest(meeting_url=MEET_URL, bot_name="LCT Live Graph")
        )

    resp = asyncio.run(_run())
    assert resp["bot_id"] == "bot-1"
    assert resp["conversation_id"]
    assert resp["viewer_ws"] == f"/ws/meeting/{resp['conversation_id']}"
    assert resp.get("deduplicated") is not True

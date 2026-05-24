"""Unit tests for the auto consumption-match runner (#17).

The runner is the thin glue between the detector, IndrasNet client, and the
WS send. These tests pin the wiring contract:
  - feature flag gates the WS-session call entirely
  - no match → no IndrasNet call, no WS send
  - match (name-grounded) → fetch contact_name from match, NOT fallback
  - match (agnostic, fallback set) → fetch fallback contact
  - match (agnostic, no fallback) → skip (we don't know whose agenda)
  - IndrasNet failure → swallowed, no WS send, no exception propagated
  - dedupe → identical (phrase, contact) within window suppressed
  - dedupe window expires → fires again
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

import pytest

from lct_python_backend.services import consumption_match_runner as runner
from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetUnavailable,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class RecordingSender:
    """async-callable that records every payload it's given."""

    def __init__(self) -> None:
        self.sent: List[Dict[str, Any]] = []

    async def __call__(self, payload: Dict[str, Any]) -> None:
        self.sent.append(payload)


def make_fetch(body: Dict[str, Any]):
    async def _fetch(contact_ref: str) -> Dict[str, Any]:
        return {"contact_ref_called_with": contact_ref, **body}
    return _fetch


def make_failing_fetch(exc: Exception):
    async def _fetch(contact_ref: str) -> Dict[str, Any]:
        raise exc
    return _fetch


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in ("AGENDA_QUERY_DETECTOR_ENABLED", "AGENDA_QUERY_PATTERNS"):
        monkeypatch.delenv(var, raising=False)


def test_should_run_off_by_default():
    assert runner.should_run() is False


def test_should_run_when_flag_enabled(monkeypatch):
    monkeypatch.setenv("AGENDA_QUERY_DETECTOR_ENABLED", "true")
    assert runner.should_run() is True


# ---------------------------------------------------------------------------
# No-match path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_match_does_nothing():
    sender = RecordingSender()
    fetch = make_fetch({"items": []})
    out = await runner.run_match_for_segment(
        segment_text="hey what's up did you watch the movie",
        contact_names=["Sahil"],
        fallback_contact_ref=None,
        conversation_id="conv-1",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is None
    assert sender.sent == []


# ---------------------------------------------------------------------------
# Match resolution: name-grounded vs fallback
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_name_grounded_match_uses_matched_name_not_fallback():
    sender = RecordingSender()
    fetch = make_fetch({
        "contact": {"contact_id": "c_sahil", "display_name": "Sahil"},
        "items": [{"text": "review draft"}],
        "item_count": 1,
    })
    out = await runner.run_match_for_segment(
        segment_text="what's pending with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref="Vinay",  # different person — should be ignored
        conversation_id="conv-2",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is not None
    assert out["contact_ref_called_with"] == "sahil"
    assert len(sender.sent) == 1
    payload = sender.sent[0]
    assert payload["type"] == "consumption_match"
    assert payload["source"] == "auto"
    assert payload["match_source"] == "name-grounded"
    assert payload["conversation_id"] == "conv-2"
    assert payload["item_count"] == 1


@pytest.mark.asyncio
async def test_agnostic_match_uses_fallback_contact():
    sender = RecordingSender()
    fetch = make_fetch({"contact": {"display_name": "Vinay"}, "items": [], "item_count": 0})
    out = await runner.run_match_for_segment(
        segment_text="what was pending again",
        contact_names=[],
        fallback_contact_ref="Vinay",
        conversation_id="conv-3",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is not None
    assert out["contact_ref_called_with"] == "Vinay"
    assert len(sender.sent) == 1


@pytest.mark.asyncio
async def test_agnostic_match_no_fallback_skips():
    sender = RecordingSender()
    fetched = []

    async def _fetch(contact_ref):
        fetched.append(contact_ref)
        return {"items": []}

    out = await runner.run_match_for_segment(
        segment_text="what was pending again",
        contact_names=[],
        fallback_contact_ref=None,
        conversation_id="conv-4",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=_fetch,
    )
    assert out is None
    assert sender.sent == []
    assert fetched == []  # never called IndrasNet


@pytest.mark.asyncio
async def test_name_grounded_wins_over_agnostic_in_same_segment():
    """If both pass-1 (name-grounded) and pass-2 (agnostic) would match,
    pass-1 wins because it's more specific."""
    sender = RecordingSender()
    fetch = make_fetch({"contact": {"display_name": "Sahil"}, "items": [], "item_count": 0})
    out = await runner.run_match_for_segment(
        # "agenda with sahil" matches name-grounded; "what's on the agenda"
        # also matches contact-agnostic.
        segment_text="what's on the agenda with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref="Vinay",
        conversation_id="conv-5",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is not None
    assert out["contact_ref_called_with"] == "sahil"
    assert out["match_source"] == "name-grounded"


# ---------------------------------------------------------------------------
# IndrasNet failure handling
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_indrasnet_unavailable_is_swallowed():
    sender = RecordingSender()
    fetch = make_failing_fetch(IndrasNetUnavailable("connection refused"))
    out = await runner.run_match_for_segment(
        segment_text="agenda with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref=None,
        conversation_id="conv-6",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is None
    assert sender.sent == []


@pytest.mark.asyncio
async def test_indrasnet_404_is_swallowed():
    sender = RecordingSender()
    fetch = make_failing_fetch(IndrasNetClientError("404 — contact not found"))
    out = await runner.run_match_for_segment(
        segment_text="pending with unknownperson",
        contact_names=["UnknownPerson"],
        fallback_contact_ref=None,
        conversation_id="conv-7",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert out is None
    assert sender.sent == []


@pytest.mark.asyncio
async def test_ws_send_failure_is_swallowed():
    fetch = make_fetch({"contact": {"display_name": "Sahil"}, "items": [], "item_count": 0})

    async def failing_send(payload):
        raise RuntimeError("ws closed")

    out = await runner.run_match_for_segment(
        segment_text="agenda with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref=None,
        conversation_id="conv-8",
        deduper=runner.ConsumptionMatchDeduper(),
        send_ws_event=failing_send,
        fetch_pending_discussions=fetch,
    )
    # The runner caught the WS exception and returned None — no propagation
    # would have crashed the asyncio task.
    assert out is None


# ---------------------------------------------------------------------------
# Dedupe
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_identical_match_within_window_is_deduped():
    sender = RecordingSender()
    fetch = make_fetch({"contact": {"display_name": "Sahil"}, "items": [], "item_count": 0})
    dedupe = runner.ConsumptionMatchDeduper(window_seconds=60.0)

    first = await runner.run_match_for_segment(
        segment_text="agenda with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref=None,
        conversation_id="c",
        deduper=dedupe,
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    second = await runner.run_match_for_segment(
        segment_text="agenda with sahil",
        contact_names=["Sahil"],
        fallback_contact_ref=None,
        conversation_id="c",
        deduper=dedupe,
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert first is not None
    assert second is None  # deduped
    assert len(sender.sent) == 1


@pytest.mark.asyncio
async def test_different_contacts_not_deduped():
    sender = RecordingSender()
    fetch = make_fetch({"items": [], "item_count": 0})
    dedupe = runner.ConsumptionMatchDeduper(window_seconds=60.0)

    await runner.run_match_for_segment(
        segment_text="agenda with sahil",
        contact_names=["Sahil", "Vinay"],
        fallback_contact_ref=None,
        conversation_id="c",
        deduper=dedupe,
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    await runner.run_match_for_segment(
        segment_text="agenda with vinay",
        contact_names=["Sahil", "Vinay"],
        fallback_contact_ref=None,
        conversation_id="c",
        deduper=dedupe,
        send_ws_event=sender,
        fetch_pending_discussions=fetch,
    )
    assert len(sender.sent) == 2


def test_deduper_fires_after_window_expires(monkeypatch):
    """Direct unit test on ConsumptionMatchDeduper — easier to control
    time than mocking time.monotonic across an async runner."""
    fake_time = [1000.0]
    monkeypatch.setattr(runner.time, "monotonic", lambda: fake_time[0])

    d = runner.ConsumptionMatchDeduper(window_seconds=30.0)
    assert d.should_fire("agenda with sahil", "Sahil") is True
    assert d.should_fire("agenda with sahil", "Sahil") is False

    fake_time[0] += 31.0  # past the window
    assert d.should_fire("agenda with sahil", "Sahil") is True


def test_deduper_prunes_stale_entries(monkeypatch):
    """Long sessions shouldn't grow the dedupe dict unbounded."""
    fake_time = [1000.0]
    monkeypatch.setattr(runner.time, "monotonic", lambda: fake_time[0])

    d = runner.ConsumptionMatchDeduper(window_seconds=10.0)
    d.should_fire("p1", "c1")
    fake_time[0] += 100  # well past 2× window
    # Adding any new entry triggers prune
    d.should_fire("p2", "c2")
    assert ("p1", "c1") not in d._last_fired
    assert ("p2", "c2") in d._last_fired

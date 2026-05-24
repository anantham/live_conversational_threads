"""
Auto-detect consumption-match runner — wires the agenda-query detector into
the live STT pipeline.

For each finalized transcript segment, this runs the detector against the
known-contacts list and, on match, fetches IndrasNet's pending-discussions
for that contact, then ships a `consumption_match` WS event back to the
client. The frontend's existing chip (already wired for the manual path)
lights up with the items count; per the UX decision (2026-05-24), the
drawer does NOT auto-open on auto-matches — the user clicks the chip when
ready, so the live conversation isn't visually interrupted.

This module is the deliberately-thin bridge between three already-built
pieces: `agenda_query_detector` (#16), `indrasnet_client.get_pending_discussions`
(#15), and the WS session (`stt_ws_session.WsSessionContext`). Each piece
has its own tests; this runner has integration tests covering the wiring.

Feature flag: respects `AGENDA_QUERY_DETECTOR_ENABLED` (off by default).
When disabled, `should_run()` returns False and the WS session can skip
calling this entirely.

Dedupe: in-process per-session, keyed on (phrase, contact). The refinement
pass can re-emit the same final under a different speaker label; without
dedupe the user would see the same chip refresh twice. Window is short
(30s) so a genuine repeated query later in the conversation still surfaces.
"""

from __future__ import annotations

import datetime
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from lct_python_backend.services.agenda_query_detector import (
    AgendaQueryResult,
    detect_agenda_query,
    is_enabled,
)
from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
    get_pending_discussions,
)

logger = logging.getLogger("lct_backend")


# How long to suppress an identical (phrase, contact) match. Background
# refinement can re-finalize the same utterance with new speaker labels;
# without this the chip would refresh redundantly. A genuine repeated query
# 30s later is still surfaced — that's a long enough gap to be intentional.
DEDUPE_WINDOW_SECONDS: float = 30.0


def should_run() -> bool:
    """Feature-flag gate. Mirrors agenda_query_detector.is_enabled() so the
    WS session can short-circuit without importing the detector internals."""
    return is_enabled()


def _resolve_contact_ref(
    match: AgendaQueryResult,
    fallback_contact_ref: Optional[str],
) -> Optional[str]:
    """Pick which contact to look up.

    Name-grounded matches carry the contact_name the speaker named (e.g.
    "pending with Sahil" → matched_contact_name="sahil"). That ALWAYS wins
    over the conversation's selected participant — the user verbally chose
    Sahil. Contact-agnostic matches fall back to whatever participant the
    conversation was started with. If neither is set, return None — the
    caller will skip the lookup (we don't know whose agenda to fetch).
    """
    if match.matched_contact_name:
        return match.matched_contact_name
    if fallback_contact_ref and fallback_contact_ref.strip():
        return fallback_contact_ref.strip()
    return None


class ConsumptionMatchDeduper:
    """In-process per-session dedupe of (phrase, contact_ref) matches.

    Plain dict keyed on the tuple → last-fired monotonic timestamp. Entries
    older than DEDUPE_WINDOW_SECONDS are cleaned up opportunistically on
    each call so the dict can't grow unbounded across a long session.
    """

    def __init__(self, *, window_seconds: float = DEDUPE_WINDOW_SECONDS) -> None:
        self._window = float(window_seconds)
        self._last_fired: Dict[Tuple[str, str], float] = {}

    def should_fire(self, phrase: str, contact_ref: str) -> bool:
        """True if this (phrase, contact) hasn't fired within the window.
        Side-effect: records the fire time if returning True, and prunes
        stale entries."""
        key = (str(phrase or "").lower().strip(), str(contact_ref or "").lower().strip())
        now = time.monotonic()
        last = self._last_fired.get(key)
        if last is not None and (now - last) < self._window:
            return False

        # Prune entries older than 2× window — keeps the dict bounded.
        cutoff = now - (2 * self._window)
        stale_keys = [k for k, t in self._last_fired.items() if t < cutoff]
        for k in stale_keys:
            self._last_fired.pop(k, None)

        self._last_fired[key] = now
        return True


async def run_match_for_segment(
    *,
    segment_text: str,
    contact_names: List[str],
    fallback_contact_ref: Optional[str],
    conversation_id: Optional[str],
    deduper: ConsumptionMatchDeduper,
    send_ws_event: Callable[[Dict[str, Any]], Any],
    fetch_pending_discussions: Callable[..., Any] = get_pending_discussions,
) -> Optional[Dict[str, Any]]:
    """Run the detector on one finalized segment and, on match, fetch
    pending-discussions and emit a WS event.

    Returns the payload that was sent on match (for tests / telemetry), or
    None on no-match / skip / failure. Failures are logged but never raised
    — this runs in a fire-and-forget task so a raised exception would
    become an unhandled task error in the asyncio loop.

    Args:
        segment_text: the finalized transcript text just emitted.
        contact_names: known contact display_names (for name-grounded
            template expansion). Empty/None → only contact-agnostic phrases
            check, and only fire if fallback_contact_ref is set.
        fallback_contact_ref: the conversation's selected participant
            display_name (or contact_id). Used when the detector matches a
            contact-agnostic phrase. None → those matches are skipped.
        conversation_id: passed through to the WS event for the frontend's
            audit trail.
        deduper: per-session dedupe state (see ConsumptionMatchDeduper).
        send_ws_event: async callable that ships the dict to the WebSocket.
            Injected so tests don't need a real WS — and so the WS session
            owns the actual `_safe_send_json(self.websocket, ...)` wrapper.
        fetch_pending_discussions: IndrasNet lookup; injectable for tests.
    """
    match = detect_agenda_query(segment_text, contact_names=contact_names or [])
    if not match.matched:
        return None

    contact_ref = _resolve_contact_ref(match, fallback_contact_ref)
    if not contact_ref:
        # Contact-agnostic phrase fired but the conversation has no
        # participant set, so we can't say WHOSE agenda. Log and skip.
        logger.info(
            "[consumption-match] auto-detect SKIP (no contact) phrase=%r "
            "source=%s segment=%r",
            match.phrase, match.source, segment_text[:100],
        )
        return None

    if not deduper.should_fire(match.phrase, contact_ref):
        logger.debug(
            "[consumption-match] auto-detect SKIP (deduped) phrase=%r contact=%r",
            match.phrase, contact_ref,
        )
        return None

    logger.info(
        "[consumption-match] auto-detect FIRE phrase=%r source=%s contact=%r "
        "conv=%s segment=%r",
        match.phrase, match.source, contact_ref, conversation_id,
        segment_text[:120],
    )

    try:
        body = await fetch_pending_discussions(contact_ref)
    except IndrasNetUnavailable as exc:
        logger.warning(
            "[consumption-match] IndrasNet unavailable for contact=%r: %s",
            contact_ref, exc,
        )
        return None
    except IndrasNetClientError as exc:
        # 404 (contact unknown) and 400 (bad ref) both land here. Log info
        # not error — a verbal name that isn't in IndrasNet's contact list
        # is a legitimate outcome, not a bug.
        logger.info(
            "[consumption-match] IndrasNet client error for contact=%r: %s",
            contact_ref, exc,
        )
        return None
    except (IndrasNetServerError, IndrasNetProtocolError) as exc:
        logger.warning(
            "[consumption-match] IndrasNet error for contact=%r: %s",
            contact_ref, exc,
        )
        return None
    except IndrasNetError as exc:
        logger.warning(
            "[consumption-match] unexpected IndrasNet error for contact=%r: %s",
            contact_ref, exc,
        )
        return None

    payload = {
        "type": "consumption_match",
        "source": "auto",
        "conversation_id": conversation_id,
        "matched_phrase": match.phrase,
        "match_source": match.source,
        "triggered_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "selected_text": segment_text,
        **(body if isinstance(body, dict) else {}),
    }

    try:
        result = send_ws_event(payload)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:  # noqa: BLE001 — fire-and-forget, never raise
        logger.warning("[consumption-match] WS send failed: %s", exc)
        return None

    return payload

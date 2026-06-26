"""Live-prayer card runner — the thin bridge from a finalized STT segment to a
passive ``prayer_card`` WS event.

Flow per finalized segment (fire-and-forget; never blocks or crashes live STT):
  detect (M5 fuzzy) -> execute (fetch via IndrasNet retrieval | factcheck via M5)
  -> build a prayer_card -> ship it over the WS.

UX contract (the user's design): cards are AMBIENT, never an interrupt. The frontend
shows a subtle pulsing dot + a stack that ages; this runner just emits the card and
lets the client decide when/whether to surface it. So we do NOT honor IndrasNet's
``surface_mode``/``auto_actuate`` — every result becomes a passive card.

Feature flag: ``LIVE_PRAYER_CARDS_ENABLED`` (off by default). Scope: fetch + factcheck.
"""

from __future__ import annotations

import datetime
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from lct_python_backend.services.env_helpers import env_bool, env_float
from lct_python_backend.services.live_prayer import detector as _detector
from lct_python_backend.services.live_prayer import factcheck as _factcheck

logger = logging.getLogger("lct_backend")

DEDUPE_WINDOW_SECONDS: float = env_float("LIVE_PRAYER_DEDUPE_WINDOW_SECONDS", 45.0)


def should_run() -> bool:
    """Feature-flag gate, mirrored so the WS session can short-circuit."""
    return env_bool("LIVE_PRAYER_CARDS_ENABLED", default=False)


class LivePrayerDeduper:
    """Per-session dedupe keyed on (card_type, normalized query). STT refinement
    can re-finalize the same utterance; without this the user sees the card twice."""

    def __init__(self, *, window_seconds: float = DEDUPE_WINDOW_SECONDS) -> None:
        self._window = float(window_seconds)
        self._last: Dict[Tuple[str, str], float] = {}

    def should_fire(self, card_type: str, query: str) -> bool:
        key = (str(card_type or "").lower(), " ".join(str(query or "").lower().split())[:120])
        now = time.monotonic()
        last = self._last.get(key)
        if last is not None and (now - last) < self._window:
            return False
        cutoff = now - (2 * self._window)
        for k in [k for k, t in self._last.items() if t < cutoff]:
            self._last.pop(k, None)
        self._last[key] = now
        return True


async def _run_fetch(query, conversation_id, session_id, participants) -> Dict[str, Any]:
    """Reuse IndrasNet's already-built fetch executor (detect router runs retrieval
    and returns ready cards). We pass an explicit 'fetch:' signal so its deterministic
    pattern-matcher actuates a Fetch."""
    from lct_python_backend.services.indrasnet_client import detect_lct_prayer
    body = await detect_lct_prayer(
        signal_text=f"fetch: {query}",
        conversation_id=conversation_id,
        session_id=session_id,
        participants=participants or [],
        source="lct_live",
        max_results=5,
    )
    cards = body.get("cards") if isinstance(body.get("cards"), list) else []
    fetch_card = next((c for c in cards if isinstance(c, dict)), {})
    return {
        "results": fetch_card.get("results", []),
        "indrasnet_decision": body.get("decision", {}),
        "title": fetch_card.get("title") or "Fetch results",
    }


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


async def run_for_segment(
    *,
    segment_text: str,
    conversation_id: Optional[str],
    session_id: Optional[str],
    participants: Optional[List[Dict[str, Any]]],
    deduper: LivePrayerDeduper,
    send_ws_event: Callable[[Dict[str, Any]], Any],
    providers: Optional[List[Dict[str, Any]]] = None,
    detect_fn: Callable[..., Awaitable[Any]] = _detector.detect,
    fetch_fn: Callable[..., Awaitable[Dict[str, Any]]] = _run_fetch,
    factcheck_fn: Callable[..., Awaitable[Dict[str, Any]]] = _factcheck.factcheck,
) -> Optional[Dict[str, Any]]:
    """Detect a trigger in one segment and, on hit, execute + emit a prayer_card.
    Returns the payload sent (for tests), or None. Never raises.

    ``providers`` is the session's runtime LLM provider list (DB-loaded, passed from
    the WS session) so that the Settings UI controls the live-prayer LLM route."""
    trigger = await detect_fn(segment_text, providers=providers)
    if trigger is None:
        return None

    if not deduper.should_fire(trigger.type, trigger.query):
        logger.debug("[live-prayer] SKIP (deduped) type=%s query=%r", trigger.type, trigger.query[:60])
        return None

    card_id = f"{trigger.type}_{uuid.uuid4().hex[:12]}"
    base = {
        "type": "prayer_card",
        "card_id": card_id,
        "card_type": trigger.type,
        "conversation_id": conversation_id,
        "triggered_at": _now_iso(),
        "detection": {"confidence": trigger.confidence, "segment_text": segment_text},
        "status": "executed",
    }

    try:
        if trigger.type == "fetch":
            res = await fetch_fn(trigger.query, conversation_id, session_id, participants)
            payload = {**base, "query": trigger.query,
                       "title": res.get("title") or "Fetch results",
                       "results": res.get("results", []),
                       "indrasnet_decision": res.get("indrasnet_decision", {})}
        else:  # factcheck
            verdict = await factcheck_fn(trigger.query, providers=providers)
            payload = {**base, "claim": trigger.query,
                       "title": f"Fact-check: {verdict.get('verdict', 'UNVERIFIABLE')}",
                       "verdict": verdict}
    except Exception as exc:  # noqa: BLE001 — fire-and-forget
        logger.warning("[live-prayer] execute failed type=%s: %s", trigger.type, type(exc).__name__)
        payload = {**base, "status": "error", "query": trigger.query,
                   "error": type(exc).__name__}

    logger.info("[live-prayer] CARD type=%s status=%s conv=%s query=%r",
                trigger.type, payload["status"], conversation_id, trigger.query[:80])
    try:
        result = send_ws_event(payload)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:  # noqa: BLE001
        logger.warning("[live-prayer] WS send failed: %s", exc)
        return None
    return payload

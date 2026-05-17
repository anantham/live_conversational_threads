"""
Agenda-query phrase detector.

Runs on each finalized live segment to decide: did the speaker explicitly
ask to see the pending-discussions list for the current contact? This is
the explicit-verbal-trigger path the user described as MVP scope —
distinct from implicit reaching-for detection (which lives in the
mothballed consumption_trigger.py).

Examples that should match (case-insensitive substring):
  "I pray I could see the agenda for this conversation"
  "what was that thing we said we'd discuss"
  "remind me what we wanted to talk about"
  "what's pending with you and me"

Examples that should NOT match:
  "we should talk about money" (a new prayer, not a query)
  "agenda items 1 through 5" (probably referencing a written document)

Design choices:
  - Substring match, case-insensitive. Fast, deterministic, no LLM.
  - Conservative phrase list — false positives interrupt the conversation,
    which is worse than missing some queries (user can always rephrase).
  - Patterns tunable via AGENDA_QUERY_PATTERNS env var (semicolon-
    separated) without code change — for adding personal phrasings.

Returns:
  AgendaQueryResult(matched: bool, phrase: str, source: "default"|"custom"|"")
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger("lct_backend")


# Hand-curated trigger phrases. Each is matched as a case-insensitive
# substring. Phrases are intentionally specific — generic words like
# "agenda" or "pending" alone would surface on too many false positives.
DEFAULT_TRIGGER_PHRASES: List[str] = [
    # "I pray to see" framing — direct user-coined invocation
    "i pray to see",
    "i pray i could see",
    "i wish i could see",
    "wish i could see what",
    # Agenda framing
    "agenda for this conversation",
    "agenda for this chat",
    "agenda for our",
    "agenda for today",
    "what's on our agenda",
    "what is on our agenda",
    "what's on the agenda",
    "what is on the agenda",
    # Pending-discussion framing
    "what was pending",
    "what's pending",
    "what is pending",
    "pending discussions",
    "pending to discuss",
    "pending to talk about",
    # Reach-back framing
    "what did we want to discuss",
    "what did we want to talk about",
    "what were we going to discuss",
    "what were we going to talk about",
    "what did we say we'd discuss",
    "what did we say we'd talk about",
    "what did we earmark",
    "what did we save for",
    # "Remind me" framing
    "remind me what we",
    "remind me what i wanted",
    # List framing
    "show me the list",
    "show me what we",
]


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class AgendaQueryResult:
    matched: bool
    phrase: str = ""
    source: str = ""  # "default" | "custom" | ""

    def to_dict(self) -> dict:
        return {
            "matched": self.matched,
            "phrase": self.phrase,
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def is_enabled() -> bool:
    """Feature flag. Off by default — explicit opt-in."""
    return os.getenv("AGENDA_QUERY_DETECTOR_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _load_custom_phrases() -> List[str]:
    """
    Parse AGENDA_QUERY_PATTERNS env var (semicolon-separated phrases) for
    per-deployment additions to the default trigger list. Empty / unset →
    no custom phrases.
    """
    raw = os.getenv("AGENDA_QUERY_PATTERNS", "").strip()
    if not raw:
        return []
    phrases = [p.strip().lower() for p in raw.split(";") if p.strip()]
    return phrases


def get_active_phrases(custom_only: bool = False) -> List[tuple]:
    """
    Returns (phrase, source) tuples in match-priority order. Custom phrases
    come first so deployment-specific overrides match before defaults
    (useful for tracking which custom phrases are firing in telemetry).

    custom_only=True restricts to env-supplied patterns — useful for tests
    that want a deterministic minimal set.
    """
    custom = _load_custom_phrases()
    out = [(p, "custom") for p in custom]
    if not custom_only:
        out.extend((p, "default") for p in DEFAULT_TRIGGER_PHRASES)
    return out


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

def detect_agenda_query(segment_text: Optional[str]) -> AgendaQueryResult:
    """
    Decide whether `segment_text` contains an explicit agenda-query phrase.

    Returns immediately on the FIRST matching phrase (no need to find all
    matches). Phrases are checked case-insensitively as substrings.

    No exceptions — empty/None input is a clean no-match. This runs on every
    segment, so it must never raise.
    """
    if not segment_text:
        return AgendaQueryResult(matched=False)

    text = segment_text.lower()
    for phrase, source in get_active_phrases():
        if phrase in text:
            logger.info(
                "[agenda_query_detector] MATCH phrase=%r source=%s in segment=%r",
                phrase, source, segment_text[:100],
            )
            return AgendaQueryResult(matched=True, phrase=phrase, source=source)

    return AgendaQueryResult(matched=False)

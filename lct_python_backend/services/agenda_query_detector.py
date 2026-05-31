"""
Agenda-query phrase detector.

Runs on each finalized live segment to decide: did the speaker explicitly
ask to see the pending-discussions list for the current contact? This is
the explicit-verbal-trigger path the user described as MVP scope —
distinct from implicit reaching-for detection (which lives in the
mothballed experimental/consumption_trigger.py).

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
    # ----- "I pray / wish to see" family — user-coined invocation -----
    "i pray to see",
    "i pray i could see",
    "i pray we could",
    "i pray we had",
    "i wish i could see",
    "wish i could see what",
    "wish i had a",
    "wish i could remember",
    # ----- "Agenda" family — formal meeting framing -----
    "agenda for this conversation",
    "agenda for this chat",
    "agenda for our",
    "agenda for today",
    "what's on our agenda",
    "what is on our agenda",
    "what's on the agenda",
    "what is on the agenda",
    "what's our agenda",
    "what is our agenda",
    "what was the agenda",
    "agenda items",
    "what's on the docket",
    "what is on the docket",
    "what's on our docket",
    "what is on our docket",
    # ----- "Pending" family — queue / inbox framing -----
    "what was pending",
    "what's pending",
    "what is pending",
    "pending discussions",
    "pending to discuss",
    "pending to talk about",
    "pending things",
    "outstanding items",
    "open threads",
    "open items",
    "open loops",
    "stuff we're sitting on",
    "stuff we are sitting on",
    # ----- "Reach-back" family — memory-jog framing -----
    "what did we want to discuss",
    "what did we want to talk about",
    "what were we going to discuss",
    "what were we going to talk about",
    "what did we say we'd discuss",
    "what did we say we'd talk about",
    "what did we earmark",
    "what did we save for",
    "what did we leave hanging",
    "what's left over",
    "what did we put off",
    "what did we set aside",
    # "thing we" requires the verb context — narrower than 'that thing' alone
    "what was the thing we wanted",
    "what was the thing we were going",
    "what was the thing we said",
    # ----- "Remind me" family — explicit request -----
    "remind me what we",
    "remind me what i wanted",
    "remind me what was",
    "can you remind me what",
    "help me remember what",
    "what was that we wanted",
    # ----- "List" family -----
    "show me the list",
    "show me what we",
    "give me the list",
    "what's on my list",
    "run me through the list",
    "check our list",
]


# Name-grounded phrase templates. {NAME} is substituted with the current
# conversation's contact display_name (lowercased) when the detector is
# given a contact_name. These catch phrasings where the user references
# the OTHER person by name without using the generic agenda vocabulary —
# e.g., "pending with Sahil" wouldn't match any default phrase but is
# clearly an agenda query when Sahil is the selected contact.
#
# Templates require both the name AND a pending/agenda/reach-back token
# co-occurring, so they don't fire on general conversation about that
# person ("what did Sahil say about the movie" — not an agenda query).
NAME_GROUNDED_TEMPLATES: List[str] = [
    "pending with {NAME}",
    "with {NAME} pending",
    "agenda with {NAME}",
    "{NAME} agenda",
    "outstanding with {NAME}",
    "what did {NAME} say we'd",
    "what were we going to discuss with {NAME}",
    "what did {NAME} and i",
    "what was {NAME} and i",
    "last time {NAME} and i",
    "what {NAME} said we should discuss",
    "what {NAME} said we should talk about",
]


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class AgendaQueryResult:
    """
    Outcome of one segment's detector pass.

    `matched_contact_name` is set ONLY when the match came from a
    name-grounded template (source="name-grounded"). In that case the
    caller should look up the pending discussions for THAT contact —
    overriding any contact the conversation was started with. The user
    can verbally "switch" to another person's agenda mid-conversation by
    naming them.

    When source="default" or "custom", matched_contact_name is None and
    the caller falls back to the conversation's selected contact (if any).
    """
    matched: bool
    phrase: str = ""
    source: str = ""  # "default" | "custom" | "name-grounded" | ""
    matched_contact_name: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "matched": self.matched,
            "phrase": self.phrase,
            "source": self.source,
            "matched_contact_name": self.matched_contact_name,
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
    Returns (phrase, source) tuples for contact-agnostic phrases, in match-
    priority order. Custom phrases come first so deployment-specific
    overrides match before defaults (useful for telemetry attribution).

    Does NOT include name-grounded templates — those are computed per call
    in get_name_grounded_phrases() because they depend on the caller's
    contact list.

    custom_only=True restricts to env-supplied patterns — useful for tests
    that want a deterministic minimal set.
    """
    custom = _load_custom_phrases()
    out = [(p, "custom") for p in custom]
    if not custom_only:
        out.extend((p, "default") for p in DEFAULT_TRIGGER_PHRASES)
    return out


def get_name_grounded_phrases(contact_names: List[str]) -> List[tuple]:
    """
    Expand NAME_GROUNDED_TEMPLATES across all known contact names.

    Returns (phrase, source, contact_name) tuples. The caller (the detector)
    will pull the matching contact_name out into the AgendaQueryResult so
    downstream can fetch THAT contact's pending discussions — even if the
    conversation was started for a different person.

    contact_names can be None / empty — returns []. Each name is lowercased
    and stripped before substitution; duplicates are deduped.
    """
    if not contact_names:
        return []

    seen = set()
    out = []
    for raw_name in contact_names:
        if not raw_name:
            continue
        name = str(raw_name).strip().lower()
        if not name or name in seen:
            continue
        seen.add(name)
        for tpl in NAME_GROUNDED_TEMPLATES:
            phrase = tpl.replace("{NAME}", name)
            out.append((phrase, "name-grounded", name))
    return out


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

def detect_agenda_query(
    segment_text: Optional[str],
    contact_names: Optional[List[str]] = None,
) -> AgendaQueryResult:
    """
    Decide whether `segment_text` contains an explicit agenda-query phrase.

    Matches in two passes — name-grounded FIRST:
      1. Name-grounded phrases templated against each name in contact_names
         ("pending with sahil", "agenda with vinay", ...) — match →
         result.source is "name-grounded", matched_contact_name is set.
      2. Contact-agnostic phrases ("what was pending", "i pray to see", ...)
         — match → result.source is "default" or "custom",
         matched_contact_name is None.

    Name-grounded wins ties because when the user explicitly names a
    contact ("what's pending with Vinay"), they're asking for THAT
    person's list — even if the segment also contains a generic agenda
    phrase. The specific overrides the general.

    Args:
        segment_text: the finalized segment to inspect.
        contact_names: list of known contact display_names to watch.
            When None / empty, only contact-agnostic phrases are checked.

    Returns:
        AgendaQueryResult. Caller should:
          - if matched_contact_name is set → fetch pending discussions for
            that name (overrides any conversation-selected contact)
          - else → fetch for the conversation's selected contact (if any)

    No exceptions raised — empty/None input is a clean no-match. This runs
    on every finalized segment, so it must never block the live path.
    """
    if not segment_text:
        return AgendaQueryResult(matched=False)

    text = segment_text.lower()

    # Pass 1: name-grounded across all known contacts — specific overrides general
    for phrase, source, contact_name in get_name_grounded_phrases(contact_names or []):
        if phrase in text:
            logger.info(
                "[agenda_query_detector] MATCH (name-grounded) phrase=%r "
                "contact=%r in segment=%r",
                phrase, contact_name, segment_text[:100],
            )
            return AgendaQueryResult(
                matched=True, phrase=phrase, source=source,
                matched_contact_name=contact_name,
            )

    # Pass 2: contact-agnostic
    for phrase, source in get_active_phrases():
        if phrase in text:
            logger.info(
                "[agenda_query_detector] MATCH (agnostic) phrase=%r source=%s "
                "in segment=%r", phrase, source, segment_text[:100],
            )
            return AgendaQueryResult(
                matched=True, phrase=phrase, source=source,
                matched_contact_name=None,
            )

    return AgendaQueryResult(matched=False)

"""Deterministic grounding gate for cross-conversation synthesis.

The root-cause fix for LLM synthesis confabulation (see the grounded-synthesis
plan, docs/plans/2026-06-17-grounded-synthesis-productization.md): before a
synthesized claim is trusted, the claim-unit backing it must carry a VERBATIM
quote that literally appears in its own source transcript. This module IS that
gate — pure, deterministic, no LLM, quota-proof. It mirrors the per-conversation
``source_ref`` invariant (P0) at the cross-conversation layer.

IMPORTANT — what this gate proves, and what it does NOT (codex review 2026-06-17):
  * PROVES: the quote is not fabricated — it exists, character-for-character
    (modulo whitespace/case), in the cited source.
  * does NOT prove: that the *claim* attached to the quote is true; that the
    quote is actually spoken by the attributed speaker; that a 60-char prefix
    match isn't followed by a hallucinated tail; or that a downstream synthesis
    follows from the units it cites. Those need the Stage-3 citation verifier
    (``grounded_synthesis.verify_citations``).

So the number this module reports is a QUOTE-MISMATCH DROP RATE, not a
"confabulation rate." Calling it the latter overstates what existence-checking
can establish.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

# Default probe: compare the first ``PROBE_LEN`` chars of a normalized quote.
# A prefix (not the whole quote) is matched so a model that copies a real opening
# but drifts at the end is still anchored to a real location — at the documented
# cost that a hallucinated *tail* can slip past (the citation verifier covers
# that). Short quotes (< MIN_LEN) are matched whole.
PROBE_LEN = 60
MIN_LEN = 20


@dataclass
class ClaimUnit:
    """One extracted assertion + the verbatim quote that evidences it."""

    claim: str
    quote: str
    speaker: str
    date: str = ""
    title: str = ""
    conversation_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "claim": self.claim,
            "quote": self.quote,
            "speaker": self.speaker,
            "date": self.date,
            "title": self.title,
            "conversation_id": self.conversation_id,
        }


@dataclass
class GroundingResult:
    """Outcome of running the gate over one conversation's extracted units."""

    grounded: List[ClaimUnit] = field(default_factory=list)
    dropped: List[ClaimUnit] = field(default_factory=list)
    examples: List[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.grounded) + len(self.dropped)

    @property
    def drop_rate(self) -> float:
        """Quote-mismatch drop rate as a percentage (NOT a confabulation rate)."""
        return (len(self.dropped) / self.total * 100.0) if self.total else 0.0

    def merge(self, other: "GroundingResult") -> "GroundingResult":
        self.grounded.extend(other.grounded)
        self.dropped.extend(other.dropped)
        self.examples.extend(other.examples)
        return self


def normalize(s: Optional[str]) -> str:
    """Collapse whitespace + lowercase. The single normalization used on BOTH
    sides of every comparison so the gate is symmetric and reproducible."""
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def is_grounded(
    quote: Optional[str],
    source: Optional[str],
    *,
    probe_len: int = PROBE_LEN,
    min_len: int = MIN_LEN,
) -> bool:
    """True iff ``quote`` (normalized) literally appears in ``source``.

    A quote of length >= ``min_len`` is anchored by its first ``probe_len``
    normalized chars; a shorter quote must match whole. An empty quote is never
    grounded (fail-closed: no evidence → dropped).
    """
    q = normalize(quote)
    if not q:
        return False
    probe = q[:probe_len] if len(q) >= min_len else q
    if not probe:
        return False
    return probe in normalize(source)


def _coerce_unit(
    raw: Union[ClaimUnit, Dict[str, Any]],
    meta: Optional[Dict[str, Any]],
) -> ClaimUnit:
    meta = meta or {}
    if isinstance(raw, ClaimUnit):
        unit = raw
    else:
        unit = ClaimUnit(
            claim=str(raw.get("claim", "") or ""),
            quote=str(raw.get("quote", "") or ""),
            speaker=str(raw.get("speaker", "") or ""),
            date=str(raw.get("date", "") or ""),
            title=str(raw.get("title", "") or ""),
            conversation_id=str(raw.get("conversation_id", "") or ""),
        )
    # Stamp conversation metadata when the extractor didn't carry it per-unit.
    unit.date = unit.date or str(meta.get("date", "") or "")
    unit.title = unit.title or str(meta.get("title", "") or "")
    unit.conversation_id = unit.conversation_id or str(meta.get("conversation_id", "") or "")
    return unit


def ground_units(
    units: List[Union[ClaimUnit, Dict[str, Any]]],
    source: str,
    *,
    meta: Optional[Dict[str, Any]] = None,
    max_examples: int = 12,
    probe_len: int = PROBE_LEN,
    min_len: int = MIN_LEN,
) -> GroundingResult:
    """Partition ``units`` into grounded / dropped against ``source``.

    ``meta`` (date/title/conversation_id) is stamped onto units that lack it.
    Dropped units are kept (not silently discarded) so the drop set is an
    observability signal — the drop set IS the measured quote-mismatch rate.
    """
    result = GroundingResult()
    for raw in units or []:
        unit = _coerce_unit(raw, meta)
        if is_grounded(unit.quote, source, probe_len=probe_len, min_len=min_len):
            result.grounded.append(unit)
        else:
            result.dropped.append(unit)
            if len(result.examples) < max_examples:
                result.examples.append(
                    f'[{unit.date or "?"}] "{unit.quote[:70]}" => {unit.claim[:70]}'
                )
    return result

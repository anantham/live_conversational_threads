"""Privacy redaction for the synthesis frontier path — consume, don't author.

Real names are replaced by pseudonyms BEFORE any text leaves the box for an
external engine, and restored only in the LCT-local result. IndrasNet owns the
CANONICAL redaction map (its ``core/config.py``); LCT keeps only a local mirror
keyed by ``map_id`` for restore-on-display, and ideally fetches the canonical map
in PR#2 (no fetch endpoint exists yet — ``core/config.py`` REDACTION_MAP is still
a static "Placeholder for MVP" constant).

CODEX-REVIEW FIXES BAKED IN (2026-06-17), vs the throwaway .tmp_privacy_redact.py:
  * redaction is CASE-INSENSITIVE (the old ``re.sub`` had no IGNORECASE, so a
    lowercase "vatsal" would have leaked);
  * the leak scan is ALSO case-insensitive (the old ``\\b...\\b`` would not even
    have CAUGHT a lowercase leak — a double bug);
  * optional email/handle scrubbing as defense-in-depth;
  * restore handles bracketed ("[Friend A]") and bracketless ("Friend A") forms.

The leak direction (real name -> external) is privacy-critical and fail-closed:
``assert_clean`` raises if any forbidden token survives. The restore direction
(pseudonym -> real, on local display) is cosmetic; a miss shows the pseudonym,
never a privacy breach.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Local MIRROR of IndrasNet's canonical map. Marked clearly: LCT must not treat
# this as authoritative — PR#2 fetches the signed canonical map by id. This exists
# only so the frontier path and its tests are exercisable before that lands.
_DEFAULT_FORWARD: Dict[str, str] = {
    "Vatsal Mehra": "[Friend A]",
    "Vatsal": "[Friend A]",
    "Sahil": "[Friend B]",
    "Bhishmaraj S": "[Friend C]",
    "Bhishmaraj": "[Friend C]",
    "Bhishma": "[Friend C]",
}

# Generic PII patterns scrubbed regardless of the name map (defense in depth).
# Handle charset includes . and - so "@vatsal.mehra"/"@vatsal-mehra" scrub whole.
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_HANDLE_RE = re.compile(r"(?<![A-Za-z0-9_])@[A-Za-z0-9_][A-Za-z0-9_.-]*")


@dataclass
class RedactionMap:
    """A forward (real->pseudonym) map plus the derived reverse + forbidden set.

    ``map_id`` is the canonical IndrasNet map version this mirrors (None for the
    built-in default). ``scrub_pii`` toggles the generic email/handle scrubbing.
    """

    forward: Dict[str, str]
    map_id: Optional[str] = None
    scrub_pii: bool = True
    reverse: Dict[str, str] = field(default_factory=dict)
    forbidden: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # Build reverse (pseudonym -> SHORTEST real name) + bracketless variants.
        # Multiple real names map to one pseudonym ("Vatsal Mehra" and "Vatsal" both
        # -> "[Friend A]"); restore is cosmetic/local, so pick the shortest, most
        # conversational form deterministically.
        buckets: Dict[str, List[str]] = {}
        for real, pseud in self.forward.items():
            buckets.setdefault(pseud, []).append(real)
        rev: Dict[str, str] = {pseud: min(reals, key=len) for pseud, reals in buckets.items()}
        for pseud in list(rev):
            if pseud.startswith("[") and pseud.endswith("]"):
                rev.setdefault(pseud[1:-1], rev[pseud])
        self.reverse = rev
        # Forbidden = every real token that must never reach an external engine.
        # Dedup case-insensitively but keep one representative spelling.
        seen = set()
        forb: List[str] = []
        for real in self.forward:
            key = real.lower()
            if key not in seen:
                seen.add(key)
                forb.append(real)
        self.forbidden = forb


def default_redaction_map() -> RedactionMap:
    """The built-in LOCAL MIRROR. Not authoritative — see module docstring."""
    return RedactionMap(forward=dict(_DEFAULT_FORWARD), map_id=None)


def redact(text: str, rmap: Optional[RedactionMap] = None) -> str:
    """Replace every real name (CASE-INSENSITIVE) with its pseudonym.

    Longest source names first so "Vatsal Mehra" is handled before "Vatsal".
    Then optionally scrub emails/handles.
    """
    rmap = rmap or default_redaction_map()
    out = text or ""
    # Scrub structured PII (emails/handles) BEFORE name replacement so a
    # name-bearing handle/email is removed whole (codex finding #6: "@vatsal_mehra"
    # must become "[handle]", not "@[Friend A]_mehra" leaving a "_mehra" fragment).
    if rmap.scrub_pii:
        out = _EMAIL_RE.sub("[email]", out)
        out = _HANDLE_RE.sub("[handle]", out)
    for name in sorted(rmap.forward, key=len, reverse=True):
        out = re.sub(re.escape(name), rmap.forward[name], out, flags=re.IGNORECASE)
    return out


def restore(text: str, rmap: Optional[RedactionMap] = None) -> str:
    """Bring real names back into a LOCAL-ONLY result (cosmetic, best-effort).

    Handles bracketed and bracketless pseudonyms, longest first, case-insensitive
    but word-bounded for the bracketless form so we don't rewrite "friend a"
    appearing mid-prose by accident.
    """
    rmap = rmap or default_redaction_map()
    out = text or ""
    for pseud in sorted(rmap.reverse, key=len, reverse=True):
        real = rmap.reverse[pseud]
        if pseud.startswith("[") and pseud.endswith("]"):
            out = re.sub(re.escape(pseud), real, out, flags=re.IGNORECASE)
        else:
            out = re.sub(rf"\b{re.escape(pseud)}\b", real, out, flags=re.IGNORECASE)
    return out


def leaks(text: str, rmap: Optional[RedactionMap] = None) -> Dict[str, int]:
    """Return {real_name: count} for any forbidden token present (CASE-INSENSITIVE).

    This is the gate that decides whether text is safe to send externally.
    """
    rmap = rmap or default_redaction_map()
    found: Dict[str, int] = {}
    for name in rmap.forbidden:
        n = len(re.findall(rf"\b{re.escape(name)}\b", text or "", flags=re.IGNORECASE))
        if n:
            found[name] = n
    return found


def assert_clean(text: str, rmap: Optional[RedactionMap] = None) -> None:
    """Hard stop: raise PermissionError if any real friend name survives.

    Called on the OUTBOUND (already-redacted) payload right before an external
    engine call. Fail-closed by construction.
    """
    lk = leaks(text, rmap)
    if lk:
        raise PermissionError(
            f"PRIVACY LEAK — refusing external send. Real names present: {lk}"
        )

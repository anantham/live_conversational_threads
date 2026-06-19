"""LLM-fuzzy detection of EXPLICIT live-prayer triggers (fetch / fact-check).

Explicit-only by design: the speaker must actually invoke a command word — but the
transcript comes from imperfect STT, so the command may be garbled ("vact check",
"fact czech", "fetched up"). A deterministic substring match would miss those, so we
use the local LLM as a *fuzzy* recognizer: it decides whether the segment contains an
explicit fetch/fact-check invocation (tolerating phonetic/edit-distance garbling) and
extracts the query/claim. Ordinary questions WITHOUT an invocation do NOT fire (that's
the implicit/ambient mode, deliberately out of scope for now).

A cheap pre-gate skips the LLM on segments too short or with no plausible trigger token
nearby — keeps M5 load sane even at "run on every finalized segment" cadence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from lct_python_backend.services.live_prayer import _llm

logger = logging.getLogger("lct_backend")

VALID_TYPES = {"fetch", "factcheck"}
_MIN_CHARS = 12
_MIN_WORDS = 3

_PROMPT = """You are a strict trigger detector for a live conversation assistant. The text below is ONE finalized speech-to-text segment, and STT may have GARBLED words.

Decide if the speaker EXPLICITLY invoked one of exactly two commands (tolerate phonetic / spelling errors from STT):
- "fetch"  — invoking the word "fetch" (garbled forms: vetch, fetched, fed, fetch up, fetchup) OR a clear "look up / pull up" command, to retrieve information. Extract what they want fetched as "query".
- "factcheck" — invoking "fact check" / "factcheck" (garbled: fact czech, vact check, fact chek) OR "verify that ...", to check a claim. Extract the claim to verify as "query".

Rules:
- Fire ONLY on an explicit command invocation. An ordinary question or statement with NO command word is "none".
- Be tolerant of STT garbling of the COMMAND word, but do not invent a command that isn't there.
- "query" must be the actual thing to fetch / the claim to check, in clean text (fix obvious STT errors), not the command word.

Output ONLY JSON: {"type":"fetch"|"factcheck"|"none","query":"<clean query or claim, or empty>","confidence":0.0-1.0}

SEGMENT:
"""


@dataclass
class DetectedTrigger:
    type: str           # "fetch" | "factcheck"
    query: str          # what to fetch / the claim to check
    confidence: float
    segment_text: str


def _pregate(text: str) -> bool:
    """Only skip trivial backchannels ("yeah", "mm-hmm ok"). We deliberately do NOT
    require a literal trigger token — STT garbles the command word ("vetch", "vact
    check"), so anything substantive goes to the LLM (the user chose max recall)."""
    if not text:
        return False
    stripped = text.strip()
    return len(stripped) >= _MIN_CHARS and len(stripped.split()) >= _MIN_WORDS


async def detect(
    segment_text: str,
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
    min_confidence: float = 0.55,
) -> Optional[DetectedTrigger]:
    """Return a DetectedTrigger if the segment explicitly invokes fetch/factcheck,
    else None. Never raises (live path)."""
    if not _pregate(segment_text):
        return None
    data = await _llm.call_json(_PROMPT + segment_text.strip(), providers=providers, max_tokens=200)
    t = str(data.get("type", "none")).strip().lower()
    if t not in VALID_TYPES:
        return None
    query = str(data.get("query", "") or "").strip()
    if not query:
        return None
    try:
        conf = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    if conf < min_confidence:
        logger.debug("[live-prayer] trigger below confidence (%.2f): %r", conf, query[:60])
        return None
    logger.info("[live-prayer] DETECT type=%s conf=%.2f query=%r", t, conf, query[:80])
    return DetectedTrigger(type=t, query=query, confidence=conf, segment_text=segment_text)

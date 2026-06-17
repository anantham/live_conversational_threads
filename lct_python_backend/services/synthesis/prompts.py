"""Versioned prompt templates for grounded cross-conversation synthesis.

Kept as module constants (not inline strings) so prompt changes are reviewable
in diff and the version travels with the artifact. All templates use ``str.format``
named placeholders; the orchestrator fills them.

PROMPT_VERSION bumps whenever a template changes in a way that could shift output
shape — it is stamped into the synthesis artifact for provenance.
"""

from __future__ import annotations

PROMPT_VERSION = "1.0.0"

# Stage 1 — grounded extraction. The HARD rule is verbatim-copy: a unit only
# exists if a real quote can be copied. This is what removes fabrication at the
# source (constrain to "extract verbatim", not "narrate freely").
EXTRACT_UNITS = """From this ONE conversation between {participants}, extract the substantive claim-units (the important assertions, agreements, disagreements, decisions, confessions).

For EACH unit output:
- "claim": one specific sentence — what was asserted/agreed/disagreed. Concrete, not generic.
- "quote": a VERBATIM substring COPIED EXACTLY from the transcript that evidences it (20-200 chars; it MUST appear character-for-character).
- "speaker": which participant said the quote (use their name exactly as it appears in the transcript).

Output ONLY JSON: {{"units":[{{"claim":...,"quote":...,"speaker":...}}, ...]}}
NEVER invent a quote — only include a unit if you can copy a real verbatim quote. If a quote is not a real substring, drop the unit. Aim for the 8-25 most important units.

TRANSCRIPT:
{transcript}
"""

# Stage 3 — synthesis over GROUNDED units only. The model relates verified facts;
# it cannot introduce a fact/quote/date absent from the units.
SYNTHESIZE = """You are mapping the intellectual relationship between {participants} using ONLY the grounded claim-units below. Each unit is a verbatim-quoted, dated fact that has been machine-verified to exist in its source.

Synthesize across them (clean markdown):
1. RECURRING CRUXES (questions/tensions they return to; how each stands; how it evolved)
2. DURABLE AGREEMENTS
3. LIVE DISAGREEMENTS (steelman both sides; did the position move?)
4. THE ARC (by phase, chronological)
5. OPEN LOOPS

HARD RULES:
- Every point MUST be built only from the units below, and MUST cite the unit id(s) it uses in square brackets, e.g. [u12] or [u12] [u13]. (Each unit is labelled with its id and date.)
- Do NOT introduce any fact, quote, or date not present in the units.
- If something isn't in the units, you don't know it — leave it out.

GROUNDED UNITS (labelled [id · date]):
{units}
"""

# Stage 3b — citation/entailment verifier. Checks a SINGLE synthesized point
# against ONLY the grounded units it cites (cheap: claim + a few units, never the
# whole transcript). This is the second-line check the existence-gate cannot do:
# does the point actually FOLLOW from its cited units, by the right speaker?
VERIFY_CITATION = """You are adversarially fact-checking ONE synthesized point against ONLY the grounded units it cites. A grounded unit is a verbatim quote + speaker + date already machine-verified to exist in the source.

Judge the point on TWO axes:
1. ENTAILMENT — does the point actually follow from the cited units, or does it overstate / add unsupported detail?
2. ATTRIBUTION — if the point attributes a stance to a specific person, do the cited units actually show THAT speaker saying it?

Output EXACTLY one line of JSON:
{{"verdict":"SUPPORTED|OVERSTATED|UNSUPPORTED","speaker_ok":true|false,"reason":"<=20 words"}}
- SUPPORTED: follows cleanly from the cited units.
- OVERSTATED: partly true but exaggerated or adds detail not in the units.
- UNSUPPORTED: not shown by the cited units, or contradicted.

CITED GROUNDED UNITS:
{units}

POINT UNDER REVIEW:
{point}
"""

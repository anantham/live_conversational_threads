"""Grounded, provenance-first cross-conversation synthesis (the orchestrator).

Stage 1  EXTRACT  : per conversation, pull claim-units each carrying a verbatim
                    quote + speaker (engine chosen per policy; local by default).
Stage 2  GATE     : deterministic quote-existence check (``grounding`` module).
                    Ungrounded units are DROPPED — the drop set is the measured
                    quote-mismatch rate.
Stage 3  SYNTHESIZE: relate ONLY the grounded units; dates ride from metadata so
                    the model never types a date (mis-dating impossible).
Stage 3b VERIFY   : NEW citation/entailment check the existence-gate cannot do —
                    for each synthesized point, confirm it follows from the units
                    it cites, by the right speaker. Second-line, best-effort.

Privacy: every model call goes through ``synthesis_engine.run_stage`` (local stays
on-box; external is consent-gated + redacted). Frontier is dark while
``LCT_LOCAL_ONLY`` is on, so PR#1 runs entirely local.
"""

from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lct_python_backend.services.synthesis import (
    contact_policy,
    grounding,
    prompts,
    synthesis_engine,
)
from lct_python_backend.services.synthesis.grounding import ClaimUnit

logger = logging.getLogger(__name__)

_DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_UNIT_REF_RE = re.compile(r"\b(u\d+)\b")


class SynthesisRefused(PermissionError):
    """Raised when a participant's policy forbids processing the data at all."""


@dataclass
class Conversation:
    """One source conversation fed to the synthesizer."""

    text: str
    date: str = ""
    title: str = ""
    conversation_id: str = ""


@dataclass
class CitationVerdict:
    point: str
    cited_refs: List[str]  # unit ids (preferred) or dates the point cited
    verdict: str  # SUPPORTED | OVERSTATED | UNSUPPORTED | UNCHECKED
    speaker_ok: bool
    reason: str

    @property
    def is_clean(self) -> bool:
        return self.verdict == "SUPPORTED" and self.speaker_ok


@dataclass
class SynthesisResult:
    markdown: str
    grounded_units: List[ClaimUnit] = field(default_factory=list)
    dropped_units: List[ClaimUnit] = field(default_factory=list)
    drop_examples: List[str] = field(default_factory=list)
    citation_verdicts: List[CitationVerdict] = field(default_factory=list)
    engine: str = "local"
    prompt_version: str = prompts.PROMPT_VERSION

    @property
    def quote_mismatch_rate(self) -> float:
        total = len(self.grounded_units) + len(self.dropped_units)
        return (len(self.dropped_units) / total * 100.0) if total else 0.0

    @property
    def citation_tally(self) -> Dict[str, int]:
        tally = {"SUPPORTED": 0, "OVERSTATED": 0, "UNSUPPORTED": 0, "UNCHECKED": 0}
        for v in self.citation_verdicts:
            tally[v.verdict] = tally.get(v.verdict, 0) + 1
        return tally

    def to_dict(self) -> Dict[str, Any]:
        return {
            "markdown": self.markdown,
            "engine": self.engine,
            "prompt_version": self.prompt_version,
            "quote_mismatch_rate": round(self.quote_mismatch_rate, 1),
            "grounded_units": [u.to_dict() for u in self.grounded_units],
            "dropped_units": [u.to_dict() for u in self.dropped_units],
            "drop_examples": self.drop_examples,
            "citation_tally": self.citation_tally,
            "citation_verdicts": [
                {
                    "point": v.point,
                    "cited_refs": v.cited_refs,
                    "verdict": v.verdict,
                    "speaker_ok": v.speaker_ok,
                    "reason": v.reason,
                }
                for v in self.citation_verdicts
            ],
        }


def _parse_json(s: str) -> Dict[str, Any]:
    """Tolerant JSON extraction from an LLM response (handles fences/prose)."""
    s = (s or "").strip()
    if "```" in s:
        m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
        if m:
            s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        s = s[i:j + 1]
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return {}


def extract_units(
    conv: Conversation,
    *,
    participants: str,
    engine: str,
    providers: Optional[List[Dict[str, Any]]],
    policies: Optional[List[contact_policy.ContactPrivacyPolicy]],
    timeout: float,
    retries: int = 2,
) -> List[ClaimUnit]:
    """Stage 1 for one conversation: extract grounded-candidate units."""
    prompt = prompts.EXTRACT_UNITS.format(participants=participants, transcript=conv.text)
    last_err = ""
    for _ in range(max(1, retries)):
        try:
            out = synthesis_engine.run_stage(
                engine, prompt, policies=policies, want_json=True,
                providers=providers, timeout=timeout,
            )
            raw = _parse_json(out).get("units", [])
            meta = {"date": conv.date, "title": conv.title, "conversation_id": conv.conversation_id}
            return [grounding._coerce_unit(u, meta) for u in raw if isinstance(u, dict)]
        except Exception as exc:  # noqa: BLE001 — best-effort per conversation
            last_err = f"{type(exc).__name__}: {exc}"
            logger.warning("[synthesis] extract failed for %s: %s", conv.date or conv.title, last_err)
    return []


def _units_blob(units: List[ClaimUnit]) -> str:
    return "\n".join(
        f'- [{u.unit_id} · {u.date}] {u.speaker}: "{u.quote}"  =>  {u.claim}' for u in units
    )


def verify_citations(
    markdown: str,
    grounded_units: List[ClaimUnit],
    *,
    engine: str,
    providers: Optional[List[Dict[str, Any]]],
    policies: Optional[List[contact_policy.ContactPrivacyPolicy]],
    timeout: float,
    max_points: int = 60,
) -> List[CitationVerdict]:
    """Stage 3b: check each synthesized point against ONLY the units it cites.

    This is the second-line check the existence-gate cannot perform (entailment +
    speaker attribution). Best-effort: a model judges {point, cited-units}, which
    is cheap. A point is checked against the EXACT units it cites by id ([u12]);
    only when it cites no resolvable id do we fall back to coarse date-grouping
    (which can over-match when several units share a date). Points citing neither
    an id nor a date are skipped.
    """
    by_id: Dict[str, ClaimUnit] = {u.unit_id: u for u in grounded_units if u.unit_id}
    by_date: Dict[str, List[ClaimUnit]] = {}
    for u in grounded_units:
        by_date.setdefault(u.date, []).append(u)

    verdicts: List[CitationVerdict] = []
    seen = set()
    for line in markdown.splitlines():
        point = line.strip().lstrip("-*# ").strip()
        ids = list(dict.fromkeys(_UNIT_REF_RE.findall(point)))
        dates = sorted(set(_DATE_RE.findall(point)))
        if (not ids and not dates) or len(point) < 25 or point in seen:
            continue
        seen.add(point)
        if len(verdicts) >= max_points:
            break
        # Prefer EXACT cited units (by id); fall back to date-grouping only when no
        # id resolves (finding #3: date-only keying can falsely support a claim).
        cited = [by_id[i] for i in ids if i in by_id]
        if cited:
            refs = [u.unit_id for u in cited]
        else:
            cited = [u for d in dates for u in by_date.get(d, [])]
            refs = dates
        if not cited:
            verdicts.append(CitationVerdict(point, ids or dates, "UNSUPPORTED", False, "no grounded unit for cited ref(s)"))
            continue
        prompt = prompts.VERIFY_CITATION.format(units=_units_blob(cited), point=point)
        try:
            out = synthesis_engine.run_stage(
                engine, prompt, policies=policies, want_json=True,
                providers=providers, timeout=timeout,
            )
            j = _parse_json(out)
            verdict = str(j.get("verdict", "UNCHECKED")).upper()
            if verdict not in {"SUPPORTED", "OVERSTATED", "UNSUPPORTED"}:
                verdict = "UNCHECKED"
            verdicts.append(CitationVerdict(
                point, refs, verdict,
                bool(j.get("speaker_ok", False)),
                str(j.get("reason", ""))[:200],
            ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[synthesis] citation verify failed: %s", type(exc).__name__)
            verdicts.append(CitationVerdict(point, refs, "UNCHECKED", False, f"verify error: {type(exc).__name__}"))
    return verdicts


def synthesize(
    conversations: List[Conversation],
    *,
    participants: str = "the two participants",
    engine: str = "local",
    contact_ids: Optional[List[str]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    verify: bool = True,
    max_workers: int = 2,
    extract_timeout: float = 600.0,
    synth_timeout: float = 1800.0,
    verify_timeout: float = 300.0,
) -> SynthesisResult:
    """Run the full grounded synthesis. ``engine`` defaults to local (PR#1).

    When ``contact_ids`` are given, each contact's policy is fetched and the
    engine is resolved most-restrictively; a frontier engine that any participant
    forbids (or that ``LCT_LOCAL_ONLY`` forbids) downgrades to local.
    """
    policies: Optional[List[contact_policy.ContactPrivacyPolicy]] = None
    if contact_ids:
        policies = [contact_policy.fetch_policy(cid) for cid in contact_ids]
        decision = contact_policy.resolve_engine(policies, engine)
        if decision.engine == "none":
            raise SynthesisRefused(f"refusing to synthesize: {decision.reason}")
        if decision.engine != engine:
            logger.info("[synthesis] engine %r -> %r (%s)", engine, decision.engine, decision.reason)
        engine = decision.engine

    convos = sorted(conversations, key=lambda c: c.date)
    logger.info("[synthesis] %d conversations, engine=%s", len(convos), engine)

    # Stage 1 — parallel extraction.
    gate = grounding.GroundingResult()
    extracted: List[tuple] = []
    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as ex:
        futs = {
            ex.submit(
                extract_units, c, participants=participants, engine=engine,
                providers=providers, policies=policies, timeout=extract_timeout,
            ): c for c in convos
        }
        for fut in as_completed(futs):
            c = futs[fut]
            units = fut.result()
            extracted.append((c, units))

    # Stage 2 — deterministic grounding gate (in chronological order).
    extracted.sort(key=lambda t: t[0].date)
    for c, units in extracted:
        gate.merge(grounding.ground_units(units, c.text))
    gate.grounded.sort(key=lambda u: u.date)
    for i, u in enumerate(gate.grounded):
        u.unit_id = f"u{i + 1}"  # stable id so synthesis cites the EXACT unit
    logger.info(
        "[synthesis] gate: %d grounded, %d dropped (%.0f%% quote-mismatch)",
        len(gate.grounded), len(gate.dropped), gate.drop_rate,
    )

    # Stage 3 — synthesis over grounded units only.
    units_blob = _units_blob(gate.grounded)
    synth_md = synthesis_engine.run_stage(
        engine, prompts.SYNTHESIZE.format(participants=participants, units=units_blob),
        policies=policies, providers=providers, timeout=synth_timeout,
    )

    # Stage 3b — citation/entailment verification (best-effort).
    verdicts: List[CitationVerdict] = []
    if verify and gate.grounded:
        verdicts = verify_citations(
            synth_md, gate.grounded, engine=engine, providers=providers,
            policies=policies, timeout=verify_timeout,
        )

    return SynthesisResult(
        markdown=synth_md,
        grounded_units=gate.grounded,
        dropped_units=gate.dropped,
        drop_examples=gate.examples,
        citation_verdicts=verdicts,
        engine=engine,
    )


def render_report(result: SynthesisResult, *, participants: str = "the two participants") -> str:
    """Render the full markdown artifact (synthesis + provenance + verification).

    Honest scoping (codex finding #2): the deterministic gate applies to the UNITS
    (grounded or dropped). The synthesis PROSE is constrained to grounded units and
    then verified — it is NOT auto-pruned, so any point that fails verification is
    surfaced PROMINENTLY at the top rather than silently presented as established.
    """
    tally = result.citation_tally
    flagged = [v for v in result.citation_verdicts if not v.is_clean]
    lines = [
        f"# Grounded synthesis ({participants})",
        "",
        f"_Provenance-first: {len(result.grounded_units)} machine-verified grounded units; "
        f"{len(result.dropped_units)} ungrounded dropped ({result.quote_mismatch_rate:.0f}% "
        f"quote-mismatch rate — quotes that were not verbatim, NOT a measure of claim truth). "
        f"Engine: {result.engine}. Prompt v{result.prompt_version}._",
        "",
    ]
    if result.citation_verdicts:
        lines += [
            f"_Citation check (advisory, second-line): SUPPORTED {tally['SUPPORTED']} · "
            f"OVERSTATED {tally['OVERSTATED']} · UNSUPPORTED {tally['UNSUPPORTED']} · "
            f"UNCHECKED {tally['UNCHECKED']}. The synthesis is constrained to grounded units "
            f"and then verified; it is not auto-pruned._",
            "",
        ]
    if flagged:
        lines += [
            f"> ⚠ **{len(flagged)} synthesized point(s) did NOT pass citation verification** "
            f"(overstated / unsupported / wrong speaker / unchecked) — treat as unverified:",
            "",
        ]
        for v in flagged:
            lines.append(f"> - **{v.verdict}** (speaker_ok={v.speaker_ok}) — {v.point}  \n>   {v.reason}")
        lines.append("")
    lines += [result.markdown, "", "---", "", "# Grounded unit index ([id · date] → verbatim source)", "", _units_blob(result.grounded_units)]
    if result.citation_verdicts:
        lines += ["", "---", "", "# Citation verification (per synthesized point)", ""]
        for v in result.citation_verdicts:
            flag = "" if v.is_clean else " ⚠"
            refs = " ".join(v.cited_refs)
            lines.append(f"- **{v.verdict}**{flag} (speaker_ok={v.speaker_ok}) [{refs}] — {v.point}\n  - {v.reason}")
    return "\n".join(lines)

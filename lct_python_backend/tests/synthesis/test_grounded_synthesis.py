"""Integration test for the grounded synthesis orchestrator (engine mocked)."""

import json

from lct_python_backend.services.synthesis import grounded_synthesis
from lct_python_backend.services.synthesis.grounded_synthesis import (
    Conversation,
    render_report,
    synthesize,
)

CONV_A = Conversation(
    text="Aditya: We should ship the portal next week.\nVatsal: Sounds good to me.",
    date="2025-01-01", title="Portal talk", conversation_id="a",
)
CONV_B = Conversation(
    text="Vatsal: Honestly the schema needs work first.\nAditya: Fair point.",
    date="2025-02-01", title="Schema talk", conversation_id="b",
)


def _fake_run_stage(engine, prompt, **kwargs):
    """Dispatch by the unique marker of each stage's prompt."""
    if "fact-checking ONE synthesized point" in prompt:  # Stage 3b VERIFY
        return json.dumps({"verdict": "SUPPORTED", "speaker_ok": True, "reason": "matches units"})
    if "RECURRING CRUXES" in prompt:  # Stage 3 SYNTHESIZE — cite unit ids
        return "## Cruxes\n- They debated shipping vs schema readiness [u1] [u2]"
    if "extract the substantive claim-units" in prompt:  # Stage 1 EXTRACT
        if "portal" in prompt:
            return json.dumps({"units": [
                {"claim": "ship portal", "quote": "We should ship the portal next week", "speaker": "Aditya"},
                {"claim": "FABRICATED", "quote": "the portal goes live tomorrow at dawn", "speaker": "Aditya"},
            ]})
        return json.dumps({"units": [
            {"claim": "schema first", "quote": "the schema needs work first", "speaker": "Vatsal"},
        ]})
    return "{}"


def test_synthesize_drops_paraphrase_and_keeps_grounded(monkeypatch):
    monkeypatch.setattr(grounded_synthesis.synthesis_engine, "run_stage", _fake_run_stage)
    result = synthesize([CONV_A, CONV_B], participants="Aditya and Vatsal", engine="local")

    # 2 verbatim units survive; the planted paraphrase is dropped.
    assert len(result.grounded_units) == 2
    assert len(result.dropped_units) == 1
    assert result.dropped_units[0].claim == "FABRICATED"
    assert 30 < result.quote_mismatch_rate < 40

    # Synthesis markdown is present and the citation verifier ran.
    assert "debated" in result.markdown
    assert result.citation_verdicts
    assert result.citation_verdicts[0].verdict == "SUPPORTED"
    assert result.citation_tally["SUPPORTED"] >= 1


def test_dates_ride_from_metadata_not_model(monkeypatch):
    monkeypatch.setattr(grounded_synthesis.synthesis_engine, "run_stage", _fake_run_stage)
    result = synthesize([CONV_A, CONV_B], participants="Aditya and Vatsal", engine="local")
    dates = {u.date for u in result.grounded_units}
    assert dates == {"2025-01-01", "2025-02-01"}


def test_render_report_includes_provenance_index(monkeypatch):
    monkeypatch.setattr(grounded_synthesis.synthesis_engine, "run_stage", _fake_run_stage)
    result = synthesize([CONV_A, CONV_B], participants="Aditya and Vatsal", engine="local")
    report = render_report(result, participants="Aditya and Vatsal")
    assert "Grounded unit index" in report
    assert "quote-mismatch rate" in report
    assert "Citation verification" in report

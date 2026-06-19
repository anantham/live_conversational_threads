"""Tests for the P0 provenance contract — the pure read-model + export helpers
that make a conversation graph AUDITABLE against its raw transcript (the
"no-arbitrary-compression" constraint from docs/plans/2026-06-08-lct-indrasnet-pipeline.md).

These lock in the just-shipped P0 behavior so P1 (the structured RawTurn ingest
contract) can build on a tested foundation — the plan's §129 precondition:
"do NOT start P1/P2 until P0's provenance contract is tested."

All three functions are pure (operate on plain objects + dicts), so no DB.
"""

from dataclasses import dataclass, field
from typing import Any, List, Optional

from lct_python_backend.services.conversation_reader import (
    _compute_source_ref,
    build_coverage_summary,
    build_full_transcript_for_export,
)


@dataclass
class MockNode:
    utterance_ids: List[Any] = field(default_factory=list)
    source_ref: Optional[dict] = None


@dataclass
class MockUtt:
    text: str = ""
    sequence_number: Optional[int] = None
    speaker_id: str = "?"
    speaker_name: Optional[str] = None
    id: Any = None  # coverage now intersects node refs with persisted ids


# ---------------------------------------------------------------------------
# _compute_source_ref — the deterministic provenance anchor
# ---------------------------------------------------------------------------


def test_compute_source_ref_prefers_persisted():
    # A persisted Node.source_ref always wins — the derived path (which would
    # include utterance "b") must NOT override it.
    persisted = {"utterance_ids": ["a"], "source_identifiers": ["meet:1"], "start_seq": 1, "end_seq": 1}
    node = MockNode(utterance_ids=["a", "b"], source_ref=persisted)
    assert _compute_source_ref(node, {}, {}) is persisted


def test_compute_source_ref_derives_from_utterance_ids():
    node = MockNode(utterance_ids=["u1", "u2", "u3"])
    seq_by_id = {"u1": 5, "u2": 2, "u3": 9}
    srcid_by_id = {"u1": "meet:5", "u2": "meet:2", "u3": "meet:9"}
    ref = _compute_source_ref(node, seq_by_id, srcid_by_id)
    assert ref["utterance_ids"] == ["u1", "u2", "u3"]
    assert ref["source_identifiers"] == ["meet:5", "meet:2", "meet:9"]
    assert ref["start_seq"] == 2  # min seq
    assert ref["end_seq"] == 9  # max seq


def test_compute_source_ref_none_when_no_utterances():
    # Honesty: a node referencing no utterances yields None, so the viewer shows
    # "unauditable" rather than faking coverage.
    assert _compute_source_ref(MockNode(utterance_ids=[]), {}, {}) is None


def test_compute_source_ref_tolerates_ids_missing_from_maps():
    # utterance ids are preserved verbatim, but only resolvable ids contribute
    # source_identifiers / seqs.
    node = MockNode(utterance_ids=["u1", "ghost"])
    ref = _compute_source_ref(node, {"u1": 3}, {"u1": "meet:3"})
    assert ref["utterance_ids"] == ["u1", "ghost"]
    assert ref["source_identifiers"] == ["meet:3"]
    assert ref["start_seq"] == 3
    assert ref["end_seq"] == 3


def test_compute_source_ref_seqs_none_when_nothing_resolves():
    ref = _compute_source_ref(MockNode(utterance_ids=["ghost"]), {}, {})
    assert ref["utterance_ids"] == ["ghost"]
    assert ref["source_identifiers"] == []
    assert ref["start_seq"] is None
    assert ref["end_seq"] is None


# ---------------------------------------------------------------------------
# build_full_transcript_for_export — verbatim, ordered, speaker-tagged
# ---------------------------------------------------------------------------


def test_full_transcript_empty_inputs():
    assert build_full_transcript_for_export([]) == ""
    assert build_full_transcript_for_export(None) == ""


def test_full_transcript_orders_by_sequence_and_prefers_speaker_name():
    utts = [
        MockUtt(text="second", sequence_number=2, speaker_id="B"),
        MockUtt(text="first", sequence_number=1, speaker_name="Alice", speaker_id="A"),
    ]
    assert build_full_transcript_for_export(utts) == "[Alice] first\n[B] second"


def test_full_transcript_skips_blank_text():
    utts = [
        MockUtt(text="   ", sequence_number=1, speaker_id="A"),
        MockUtt(text="real", sequence_number=2, speaker_id="B"),
    ]
    assert build_full_transcript_for_export(utts) == "[B] real"


def test_full_transcript_none_sequence_sorts_last():
    utts = [
        MockUtt(text="no-seq", sequence_number=None, speaker_id="X"),
        MockUtt(text="seq0", sequence_number=0, speaker_id="Y"),
    ]
    assert build_full_transcript_for_export(utts) == "[Y] seq0\n[X] no-seq"


def test_full_transcript_speaker_falls_back_to_question_mark():
    utts = [MockUtt(text="hi", sequence_number=1, speaker_id="", speaker_name=None)]
    assert build_full_transcript_for_export(utts) == "[?] hi"


# ---------------------------------------------------------------------------
# build_coverage_summary — honest graph-vs-source coverage
# ---------------------------------------------------------------------------


def test_coverage_summary_unions_overlapping_ids():
    graph = [
        {"source_ref": {"utterance_ids": ["u1", "u2"]}},
        {"source_ref": {"utterance_ids": ["u2", "u3"]}},  # u2 overlaps → union, not sum
    ]
    # 4 persisted turns; nodes cover u1,u2,u3 (u4 persisted but uncovered).
    utts = [MockUtt(id="u1"), MockUtt(id="u2"), MockUtt(id="u3"), MockUtt(id="u4")]
    summary = build_coverage_summary(graph, utts)
    assert summary["total_turns"] == 4
    assert summary["covered_turns"] == 3  # {u1, u2, u3}
    assert summary["pct"] == 75.0
    assert summary["auditable"] is True


def test_coverage_summary_ignores_unpersisted_referenced_ids():
    # A node references an id that was never persisted (dropped empty-text row or
    # a hallucinated id). The intersection guard must NOT count it — otherwise
    # covered could exceed total (pct > 100). codex/gemini PR #63 finding.
    graph = [{"source_ref": {"utterance_ids": ["u1", "ghost"]}}]
    summary = build_coverage_summary(graph, [MockUtt(id="u1"), MockUtt(id="u2")])
    assert summary["total_turns"] == 2
    assert summary["covered_turns"] == 1  # only u1; "ghost" not persisted
    assert summary["pct"] == 50.0
    assert summary["auditable"] is True


def test_coverage_summary_unauditable_when_no_node_has_provenance():
    graph = [{"source_ref": None}, {"id": "x"}]  # no node carries source_ref
    summary = build_coverage_summary(graph, [MockUtt(id="u1"), MockUtt(id="u2"), MockUtt(id="u3")])
    assert summary["auditable"] is False
    assert summary["pct"] is None
    assert summary["covered_turns"] == 0
    assert summary["total_turns"] == 3


def test_coverage_summary_empty_inputs():
    assert build_coverage_summary([], []) == {
        "total_turns": 0,
        "covered_turns": 0,
        "pct": None,
        "auditable": False,
    }


def test_coverage_summary_pct_is_rounded_one_dp():
    graph = [{"source_ref": {"utterance_ids": ["u1"]}}]
    utts = [MockUtt(id="u1"), MockUtt(id="u2"), MockUtt(id="u3")]  # 1/3 = 33.33%
    summary = build_coverage_summary(graph, utts)
    assert summary["pct"] == 33.3

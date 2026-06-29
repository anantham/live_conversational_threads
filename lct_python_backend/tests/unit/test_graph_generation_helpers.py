"""Unit tests for graph_generation_service.py pure-logic helpers.

No DB or LLM — all functions tested here are side-effect-free.

Covers:
- truncate_summary: None/empty safety, exact-limit boundary, word-boundary truncation
- speaker_initials: empty/None → "SP", single-word, multi-word initials, uppercase
- build_turn_based_nodes: grouping, speaker transitions, empty utterances, None text,
  None speaker_id, timestamp propagation, node_name format
- build_temporal_edge_payload: empty list, single node, multi-node edge count and
  relationship_type, UUID generation
"""

import uuid
from dataclasses import dataclass, field
from typing import Optional

import pytest

from lct_python_backend.services.graph_generation_service import (
    GeneratedNodeSpec,
    build_temporal_edge_payload,
    build_turn_based_nodes,
    speaker_initials,
    truncate_summary,
)


# ---------------------------------------------------------------------------
# Minimal utterance stub (mirrors the fields build_turn_based_nodes reads)
# ---------------------------------------------------------------------------

@dataclass
class _Utt:
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    speaker_id: Optional[str] = "Alice"
    speaker_name: Optional[str] = None
    text: Optional[str] = "hello"
    timestamp_start: Optional[float] = None
    timestamp_end: Optional[float] = None


# ---------------------------------------------------------------------------
# truncate_summary
# ---------------------------------------------------------------------------

class TestTruncateSummary:
    def test_none_returns_empty(self):
        assert truncate_summary(None) == ""

    def test_empty_string_returns_empty(self):
        assert truncate_summary("") == ""

    def test_short_text_unchanged(self):
        assert truncate_summary("hello world") == "hello world"

    def test_exactly_at_limit_not_truncated(self):
        text = "a" * 320
        result = truncate_summary(text, limit=320)
        assert result == text

    def test_one_over_limit_truncated(self):
        text = "word " * 65  # 325 chars
        result = truncate_summary(text, limit=320)
        assert len(result) <= 320 + 3  # +3 for "..."
        assert result.endswith("...")

    def test_word_boundary_respected(self):
        # "hello world" truncated at limit=5 should cut before "world"
        result = truncate_summary("hello world", limit=5)
        # rsplit cuts at the last space before limit — "hello" is 5 chars, no space before it
        # so it returns "hello..." (or just truncates at the first word)
        assert "world" not in result
        assert result.endswith("...")

    def test_whitespace_stripped_before_check(self):
        assert truncate_summary("  hello  ") == "hello"

    def test_custom_limit(self):
        result = truncate_summary("one two three four five", limit=10)
        assert len(result) <= 10 + 3  # +3 for "..."


# ---------------------------------------------------------------------------
# speaker_initials
# ---------------------------------------------------------------------------

class TestSpeakerInitials:
    def test_none_returns_sp(self):
        assert speaker_initials(None) == "SP"

    def test_empty_string_returns_sp(self):
        # value or "Speaker" → "Speaker" → parts = ["Speaker"] → "SP"
        assert speaker_initials("") == "SP"

    def test_single_word_first_two_chars(self):
        assert speaker_initials("Alice") == "AL"

    def test_single_char_word(self):
        assert speaker_initials("A") == "A"

    def test_two_word_first_letters(self):
        assert speaker_initials("Alice Brown") == "AB"

    def test_multi_word_uses_first_two(self):
        assert speaker_initials("John Paul Smith") == "JP"

    def test_uppercase_result(self):
        result = speaker_initials("alice")
        assert result == result.upper()

    def test_whitespace_only_returns_sp(self):
        assert speaker_initials("   ") == "SP"

    def test_speaker_label_with_number(self):
        # "SPEAKER_01" → single part → first 2 chars
        result = speaker_initials("SPEAKER_01")
        assert isinstance(result, str)
        assert len(result) >= 1


# ---------------------------------------------------------------------------
# build_turn_based_nodes
# ---------------------------------------------------------------------------

class TestBuildTurnBasedNodes:
    def test_empty_returns_empty(self):
        assert build_turn_based_nodes([]) == []

    def test_single_utterance_single_node(self):
        nodes = build_turn_based_nodes([_Utt(speaker_id="A", text="Hello")])
        assert len(nodes) == 1
        assert nodes[0].speaker_id == "A"

    def test_same_speaker_grouped(self):
        utts = [
            _Utt(speaker_id="A", text="First"),
            _Utt(speaker_id="A", text="Second"),
            _Utt(speaker_id="A", text="Third"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert len(nodes) == 1
        assert "First" in nodes[0].summary
        assert "Second" in nodes[0].summary

    def test_speaker_transition_creates_new_node(self):
        utts = [
            _Utt(speaker_id="A", text="Hello"),
            _Utt(speaker_id="B", text="World"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert len(nodes) == 2
        assert nodes[0].speaker_id == "A"
        assert nodes[1].speaker_id == "B"

    def test_alternating_speakers(self):
        utts = [
            _Utt(speaker_id="A", text="1"),
            _Utt(speaker_id="B", text="2"),
            _Utt(speaker_id="A", text="3"),
            _Utt(speaker_id="B", text="4"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert len(nodes) == 4

    def test_none_speaker_id_normalized_to_unknown(self):
        utts = [_Utt(speaker_id=None, text="Hello")]
        nodes = build_turn_based_nodes(utts)
        assert len(nodes) == 1
        assert nodes[0].speaker_id == "unknown"

    def test_none_text_skipped_in_summary(self):
        utts = [
            _Utt(speaker_id="A", text=None),
            _Utt(speaker_id="A", text="real content"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert "real content" in nodes[0].summary

    def test_all_none_text_falls_back_to_no_content(self):
        utts = [_Utt(speaker_id="A", text=None)]
        nodes = build_turn_based_nodes(utts)
        assert "(No content)" in nodes[0].summary

    def test_node_name_includes_initials_bracket(self):
        utts = [_Utt(speaker_id="A", speaker_name="Alice Brown", text="Hello")]
        nodes = build_turn_based_nodes(utts)
        assert "[AB]" in nodes[0].node_name

    def test_timestamp_propagated(self):
        utts = [
            _Utt(speaker_id="A", text="1", timestamp_start=1.0, timestamp_end=2.0),
            _Utt(speaker_id="A", text="2", timestamp_start=2.5, timestamp_end=4.0),
        ]
        nodes = build_turn_based_nodes(utts)
        assert nodes[0].start_time == 1.0
        assert nodes[0].end_time == 4.0

    def test_utterance_ids_collected(self):
        uid1 = uuid.uuid4()
        uid2 = uuid.uuid4()
        utts = [
            _Utt(id=uid1, speaker_id="A", text="Hello"),
            _Utt(id=uid2, speaker_id="A", text="World"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert uid1 in nodes[0].utterance_ids
        assert uid2 in nodes[0].utterance_ids

    def test_each_node_has_unique_id(self):
        utts = [
            _Utt(speaker_id="A", text="1"),
            _Utt(speaker_id="B", text="2"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert nodes[0].id != nodes[1].id

    def test_each_node_has_unique_chunk_id(self):
        utts = [
            _Utt(speaker_id="A", text="1"),
            _Utt(speaker_id="B", text="2"),
        ]
        nodes = build_turn_based_nodes(utts)
        assert nodes[0].chunk_id != nodes[1].chunk_id

    def test_whitespace_only_speaker_id_normalized(self):
        utts = [_Utt(speaker_id="   ", text="Hello")]
        nodes = build_turn_based_nodes(utts)
        assert nodes[0].speaker_id == "unknown"


# ---------------------------------------------------------------------------
# build_temporal_edge_payload
# ---------------------------------------------------------------------------

class TestBuildTemporalEdgePayload:
    def _spec(self):
        return GeneratedNodeSpec(
            id=uuid.uuid4(),
            node_name="test",
            summary="test",
            speaker_id="A",
            utterance_ids=[],
            start_time=None,
            end_time=None,
            chunk_id=uuid.uuid4(),
        )

    def test_empty_list_returns_empty(self):
        assert build_temporal_edge_payload([]) == []

    def test_single_node_returns_empty(self):
        assert build_temporal_edge_payload([self._spec()]) == []

    def test_two_nodes_returns_one_edge(self):
        a, b = self._spec(), self._spec()
        edges = build_temporal_edge_payload([a, b])
        assert len(edges) == 1

    def test_n_nodes_returns_n_minus_one_edges(self):
        specs = [self._spec() for _ in range(5)]
        edges = build_temporal_edge_payload(specs)
        assert len(edges) == 4

    def test_edge_source_and_target_ids_correct(self):
        a, b = self._spec(), self._spec()
        edges = build_temporal_edge_payload([a, b])
        assert edges[0]["source_node_id"] == a.id
        assert edges[0]["target_node_id"] == b.id

    def test_edge_relationship_type_is_temporal(self):
        edges = build_temporal_edge_payload([self._spec(), self._spec()])
        assert edges[0]["relationship_type"] == "temporal"

    def test_edge_strength_is_one(self):
        edges = build_temporal_edge_payload([self._spec(), self._spec()])
        assert edges[0]["strength"] == 1.0

    def test_edge_has_unique_id(self):
        specs = [self._spec() for _ in range(3)]
        edges = build_temporal_edge_payload(specs)
        ids = [e["id"] for e in edges]
        assert len(set(ids)) == len(ids)

    def test_sequential_chain_order(self):
        a, b, c = self._spec(), self._spec(), self._spec()
        edges = build_temporal_edge_payload([a, b, c])
        assert edges[0]["source_node_id"] == a.id
        assert edges[0]["target_node_id"] == b.id
        assert edges[1]["source_node_id"] == b.id
        assert edges[1]["target_node_id"] == c.id

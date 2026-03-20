"""Tests for import persistence pure helpers — contextual relation parsing,
speaker turn calculation, and participant summaries.

These cover the data-normalization logic that sits between LLM output and
database writes, where silent data loss is most dangerous.
"""

from dataclasses import dataclass
from typing import List, Optional

import pytest

from lct_python_backend.services.import_persistence import (
    _iter_contextual_relations,
    _looks_like_single_contextual_relation_object,
    calculate_speaker_turns,
    build_participant_summaries,
)


# ---------------------------------------------------------------------------
# Mock transcript for speaker tests
# ---------------------------------------------------------------------------


@dataclass
class MockUtterance:
    speaker: str
    text: str = ""


@dataclass
class MockTranscript:
    utterances: List[MockUtterance]
    participants: Optional[List[str]] = None

    def __post_init__(self):
        if self.participants is None:
            self.participants = list({u.speaker for u in self.utterances})


# ---------------------------------------------------------------------------
# _iter_contextual_relations
# ---------------------------------------------------------------------------


class TestIterContextualRelations:
    def test_dict_of_strings(self):
        """LLM returns {"NodeA": "relates to...", "NodeB": "supports..."}"""
        value = {"NodeA": "relates to X", "NodeB": "supports Y"}
        result = list(_iter_contextual_relations(value))
        assert len(result) == 2
        assert ("NodeA", "relates to X") in result
        assert ("NodeB", "supports Y") in result

    def test_list_of_objects(self):
        """LLM returns [{"related_node_name": "X", "relation_text": "Y"}, ...]"""
        value = [
            {"related_node_name": "NodeA", "relation_text": "contrasts with"},
            {"related_node_name": "NodeB", "relation_text": "supports"},
        ]
        result = list(_iter_contextual_relations(value))
        assert len(result) == 2

    def test_single_object(self):
        """LLM returns a single relation object (not wrapped in list)."""
        value = {"related_node_name": "NodeA", "relation_text": "depends on"}
        result = list(_iter_contextual_relations(value))
        assert len(result) == 1
        assert result[0] == ("NodeA", "depends on")

    def test_duplicate_related_node_first_extracted_then_fallthrough(self):
        """When _add rejects a duplicate, the fallthrough to item.items()
        leaks raw dict keys as node names. This is a known bug — the
        continue on line 84 only fires when _add succeeds.
        """
        value = [
            {"related_node_name": "X", "relation_text": "first relation"},
            {"related_node_name": "X", "relation_text": "second relation"},
        ]
        result = list(_iter_contextual_relations(value))
        # BUG: second item falls through to item.items(), yielding
        # ("related_node_name", "X") and ("relation_text", "second relation")
        # as separate "relations" — dict keys become node names.
        assert result[0] == ("X", "first relation")
        assert len(result) == 3  # 1 real + 2 leaked key-value pairs

    def test_empty_related_node_leaks_via_fallthrough(self):
        """Empty related_node causes _add to return None, then item.items()
        fallthrough yields the raw dict keys. Known bug.
        """
        value = [{"related_node_name": "", "relation_text": "something"}]
        result = list(_iter_contextual_relations(value))
        # BUG: yields ("relation_text", "something") via fallthrough
        assert len(result) == 1

    def test_empty_relation_text_leaks_via_fallthrough(self):
        """Empty relation_text causes _add to return None, then item.items()
        fallthrough yields raw dict keys. Known bug.
        """
        value = [{"related_node_name": "Node", "relation_text": ""}]
        result = list(_iter_contextual_relations(value))
        # BUG: yields ("related_node_name", "Node") via fallthrough
        assert len(result) == 1

    def test_none_input(self):
        result = list(_iter_contextual_relations(None))
        assert result == []

    def test_empty_dict(self):
        result = list(_iter_contextual_relations({}))
        assert result == []

    def test_empty_list(self):
        result = list(_iter_contextual_relations([]))
        assert result == []

    def test_alternative_key_names(self):
        """LLM uses 'relatedNode' and 'description' instead of canonical names."""
        value = {"relatedNode": "NodeA", "description": "explains why"}
        result = list(_iter_contextual_relations(value))
        assert len(result) == 1


# ---------------------------------------------------------------------------
# _looks_like_single_contextual_relation_object
# ---------------------------------------------------------------------------


class TestLooksLikeSingleContextualRelationObject:
    def test_canonical_keys(self):
        assert _looks_like_single_contextual_relation_object(
            {"related_node_name": "X", "relation_text": "Y"}
        ) is True

    def test_unknown_keys_rejected(self):
        assert _looks_like_single_contextual_relation_object(
            {"node_title": "X", "summary": "Y"}
        ) is False

    def test_empty_dict(self):
        assert _looks_like_single_contextual_relation_object({}) is False

    def test_non_dict(self):
        assert _looks_like_single_contextual_relation_object("string") is False
        assert _looks_like_single_contextual_relation_object(42) is False


# ---------------------------------------------------------------------------
# calculate_speaker_turns
# ---------------------------------------------------------------------------


class TestCalculateSpeakerTurns:
    def test_single_speaker(self):
        transcript = MockTranscript([MockUtterance("Alice")] * 5)
        assert calculate_speaker_turns(transcript) == 1

    def test_alternating_speakers(self):
        transcript = MockTranscript([
            MockUtterance("Alice"),
            MockUtterance("Bob"),
            MockUtterance("Alice"),
            MockUtterance("Bob"),
        ])
        assert calculate_speaker_turns(transcript) == 4

    def test_consecutive_same_speaker(self):
        transcript = MockTranscript([
            MockUtterance("Alice"),
            MockUtterance("Alice"),
            MockUtterance("Bob"),
        ])
        assert calculate_speaker_turns(transcript) == 2

    def test_empty_transcript(self):
        transcript = MockTranscript([])
        assert calculate_speaker_turns(transcript) == 1


# ---------------------------------------------------------------------------
# build_participant_summaries
# ---------------------------------------------------------------------------


class TestBuildParticipantSummaries:
    def test_basic(self):
        transcript = MockTranscript([
            MockUtterance("Alice", "Hello"),
            MockUtterance("Bob", "Hi"),
            MockUtterance("Alice", "How are you"),
        ])
        summaries = build_participant_summaries(transcript)
        assert len(summaries) == 2
        alice = next(s for s in summaries if s["name"] == "Alice")
        assert alice["utterance_count"] == 2

    def test_empty_transcript(self):
        transcript = MockTranscript([])
        summaries = build_participant_summaries(transcript)
        assert summaries == []

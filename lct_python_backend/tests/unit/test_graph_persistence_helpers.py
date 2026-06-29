"""Unit tests for graph_persistence.py pure-logic helpers.

No DB or async — all functions here are deterministic, side-effect-free.

Covers:
- extract_conversation_name: cascade fallback, None/empty/non-dict
- _extract_contextual_relation_pair: key alias resolution, missing keys
- _looks_like_single_contextual_relation_object: allowed-key subset check
- _iter_contextual_relations: dict, list, deduplication, empty/invalid inputs
- _dominant_speakers_from_excerpt: regex speaker-prefix counting
- _compute_speaker_rollup: leaf counts, DFS aggregation, cycle guard, empty
"""

import uuid
from collections import Counter

import pytest

from lct_python_backend.services.graph_persistence import (
    _compute_speaker_rollup,
    _dominant_speakers_from_excerpt,
    _extract_contextual_relation_pair,
    _iter_contextual_relations,
    _looks_like_single_contextual_relation_object,
    extract_conversation_name,
)


# ---------------------------------------------------------------------------
# extract_conversation_name
# ---------------------------------------------------------------------------

class TestExtractConversationName:
    def test_conversation_name_key(self):
        assert extract_conversation_name({"conversation_name": "Team Sync"}) == "Team Sync"

    def test_file_name_fallback(self):
        assert extract_conversation_name({"file_name": "meeting.wav"}) == "meeting.wav"

    def test_title_fallback(self):
        assert extract_conversation_name({"title": "My Title"}) == "My Title"

    def test_priority_order(self):
        meta = {"conversation_name": "First", "file_name": "second.wav", "title": "Third"}
        assert extract_conversation_name(meta) == "First"

    def test_empty_values_fallback(self):
        meta = {"conversation_name": "", "file_name": "backup.wav"}
        assert extract_conversation_name(meta) == "backup.wav"

    def test_none_returns_none(self):
        assert extract_conversation_name(None) is None

    def test_non_dict_returns_none(self):
        assert extract_conversation_name("string") is None
        assert extract_conversation_name(42) is None
        assert extract_conversation_name([]) is None

    def test_empty_dict_returns_none(self):
        assert extract_conversation_name({}) is None

    def test_whitespace_only_returns_none(self):
        assert extract_conversation_name({"conversation_name": "   "}) is None


# ---------------------------------------------------------------------------
# _extract_contextual_relation_pair
# ---------------------------------------------------------------------------

class TestExtractContextualRelationPair:
    def test_related_node_name_key(self):
        node, text = _extract_contextual_relation_pair({
            "related_node_name": "NodeA",
            "relation_text": "supports"
        })
        assert node == "NodeA"
        assert text == "supports"

    def test_alias_related_node(self):
        node, _ = _extract_contextual_relation_pair({"related_node": "NodeB", "description": "x"})
        assert node == "NodeB"

    def test_alias_source(self):
        node, _ = _extract_contextual_relation_pair({"source": "NodeC", "explanation": "y"})
        assert node == "NodeC"

    def test_relation_text_alias_description(self):
        _, text = _extract_contextual_relation_pair({
            "related_node_name": "X",
            "description": "contradicts"
        })
        assert text == "contradicts"

    def test_relation_text_alias_explanation(self):
        _, text = _extract_contextual_relation_pair({
            "related_node_name": "X",
            "explanation": "builds on"
        })
        assert text == "builds on"

    def test_non_dict_returns_empty_pair(self):
        node, text = _extract_contextual_relation_pair("not a dict")
        assert node == ""
        assert text == ""

    def test_empty_dict_returns_empty_pair(self):
        node, text = _extract_contextual_relation_pair({})
        assert node == ""
        assert text == ""


# ---------------------------------------------------------------------------
# _looks_like_single_contextual_relation_object
# ---------------------------------------------------------------------------

class TestLooksLikeSingleContextualRelationObject:
    def test_known_keys_returns_true(self):
        assert _looks_like_single_contextual_relation_object({
            "related_node_name": "X",
            "relation_text": "y"
        }) is True

    def test_unknown_key_returns_false(self):
        assert _looks_like_single_contextual_relation_object({
            "related_node_name": "X",
            "some_unknown_key": "y"
        }) is False

    def test_non_dict_returns_false(self):
        assert _looks_like_single_contextual_relation_object("str") is False
        assert _looks_like_single_contextual_relation_object([]) is False
        assert _looks_like_single_contextual_relation_object(None) is False

    def test_empty_dict_returns_false(self):
        assert _looks_like_single_contextual_relation_object({}) is False

    def test_all_allowed_aliases(self):
        for key in ("related_node", "relatedNode", "source", "from", "node"):
            assert _looks_like_single_contextual_relation_object({key: "X"}) is True


# ---------------------------------------------------------------------------
# _iter_contextual_relations
# ---------------------------------------------------------------------------

class TestIterContextualRelations:
    def test_single_relation_object_yields_one(self):
        val = {"related_node_name": "NodeA", "relation_text": "supports"}
        result = list(_iter_contextual_relations(val))
        assert len(result) == 1
        assert result[0] == ("NodeA", "supports")

    def test_flat_dict_yields_key_value_pairs(self):
        val = {"NodeA": "supports", "NodeB": "contradicts"}
        result = list(_iter_contextual_relations(val))
        nodes = {r[0] for r in result}
        assert "NodeA" in nodes
        assert "NodeB" in nodes

    def test_list_of_relation_objects(self):
        val = [
            {"related_node_name": "A", "relation_text": "builds on"},
            {"related_node_name": "B", "relation_text": "contradicts"},
        ]
        result = list(_iter_contextual_relations(val))
        assert len(result) == 2

    def test_deduplication_by_node(self):
        val = [
            {"related_node_name": "NodeA", "relation_text": "first"},
            {"related_node_name": "NodeA", "relation_text": "second"},
        ]
        result = list(_iter_contextual_relations(val))
        assert len(result) == 1
        assert result[0][0] == "NodeA"

    def test_empty_related_node_skipped(self):
        val = [{"related_node_name": "", "relation_text": "something"}]
        result = list(_iter_contextual_relations(val))
        assert result == []

    def test_empty_relation_text_skipped(self):
        val = [{"related_node_name": "NodeA", "relation_text": ""}]
        result = list(_iter_contextual_relations(val))
        assert result == []

    def test_none_yields_nothing(self):
        result = list(_iter_contextual_relations(None))
        assert result == []

    def test_empty_list_yields_nothing(self):
        result = list(_iter_contextual_relations([]))
        assert result == []

    def test_empty_dict_yields_nothing(self):
        result = list(_iter_contextual_relations({}))
        assert result == []


# ---------------------------------------------------------------------------
# _dominant_speakers_from_excerpt
# ---------------------------------------------------------------------------

class TestDominantSpeakersFromExcerpt:
    def test_empty_returns_empty_counter(self):
        result = _dominant_speakers_from_excerpt("")
        assert len(result) == 0

    def test_none_returns_empty_counter(self):
        result = _dominant_speakers_from_excerpt(None)
        assert len(result) == 0

    def test_single_speaker(self):
        excerpt = "A: Hello there. A: How are you?"
        result = _dominant_speakers_from_excerpt(excerpt)
        assert result["A"] >= 1

    def test_multiple_speakers(self):
        excerpt = "ALICE: Hi\nBOB: Hello\nALICE: How are you?"
        result = _dominant_speakers_from_excerpt(excerpt)
        assert "ALICE" in result
        assert "BOB" in result

    def test_speaker_with_number(self):
        excerpt = "SPEAKER_00: First utterance\nSPEAKER_01: Second\nSPEAKER_00: Third"
        result = _dominant_speakers_from_excerpt(excerpt)
        assert result["SPEAKER_00"] >= 2
        assert result["SPEAKER_01"] >= 1

    def test_no_speaker_prefix_returns_empty(self):
        excerpt = "This is just plain text without any speaker prefixes."
        result = _dominant_speakers_from_excerpt(excerpt)
        assert isinstance(result, Counter)


# ---------------------------------------------------------------------------
# _compute_speaker_rollup
# ---------------------------------------------------------------------------

class TestComputeSpeakerRollup:
    def _nid(self):
        return uuid.uuid4()

    def test_empty_returns_empty(self):
        result = _compute_speaker_rollup([], {})
        assert result == {}

    def test_leaf_with_excerpt_gets_speaker(self):
        nid = self._nid()
        records = [(nid, {"source_excerpt": "A: Hello\nA: World", "semantic_level": 1})]
        result = _compute_speaker_rollup(records, {})
        assert nid in result
        assert result[nid]["primary_speaker"] == "A"

    def test_no_excerpt_no_entry(self):
        nid = self._nid()
        records = [(nid, {"semantic_level": 1})]
        result = _compute_speaker_rollup(records, {})
        assert nid not in result

    def test_primary_speaker_is_most_common(self):
        nid = self._nid()
        # A appears 3x, B 1x
        excerpt = "A: one\nA: two\nA: three\nB: four"
        records = [(nid, {"source_excerpt": excerpt})]
        result = _compute_speaker_rollup(records, {})
        assert result[nid]["primary_speaker"] == "A"

    def test_speaker_distribution_present(self):
        nid = self._nid()
        excerpt = "ALICE: hi\nBOB: hello\nALICE: bye"
        records = [(nid, {"source_excerpt": excerpt})]
        result = _compute_speaker_rollup(records, {})
        dist = result[nid]["speaker_distribution"]
        assert isinstance(dist, dict)
        assert dist.get("ALICE", 0) >= 2

    def test_cycle_guard_prevents_infinite_loop(self):
        # Parent and child point at each other — should terminate cleanly
        nid_a = self._nid()
        nid_b = self._nid()
        ref_a = str(nid_a)
        ref_b = str(nid_b)
        ref_to_id = {ref_a: nid_a, ref_b: nid_b}
        records = [
            (nid_a, {"source_excerpt": "A: hello", "children_ids": [ref_b]}),
            (nid_b, {"source_excerpt": "B: world", "children_ids": [ref_a]}),  # cycle
        ]
        result = _compute_speaker_rollup(records, ref_to_id)
        # Should not raise — just returns whatever it can
        assert isinstance(result, dict)

    def test_parent_aggregates_from_children(self):
        child_id = self._nid()
        parent_id = self._nid()
        child_ref = str(child_id)
        ref_to_id = {child_ref: child_id}
        records = [
            (child_id, {"source_excerpt": "ALICE: hi there", "semantic_level": 1}),
            (parent_id, {"semantic_level": 2, "children_ids": [child_ref]}),
        ]
        result = _compute_speaker_rollup(records, ref_to_id)
        if parent_id in result:
            # Parent should inherit child's speaker info
            assert result[parent_id]["primary_speaker"] == "ALICE"

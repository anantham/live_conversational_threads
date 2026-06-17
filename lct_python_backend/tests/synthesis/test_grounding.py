"""Tests for the deterministic grounding gate."""

from lct_python_backend.services.synthesis.grounding import (
    ground_units,
    is_grounded,
    normalize,
)

SOURCE = (
    "Aditya: We should ship the portal next week, it is basically ready to go.\n"
    "Vatsal: I disagree, the schema needs serious work first before anyone sees it."
)


class TestIsGrounded:
    def test_verbatim_present_is_grounded(self):
        assert is_grounded("We should ship the portal next week", SOURCE)

    def test_paraphrase_is_not_grounded(self):
        # Plausible but never said this way → must be dropped.
        assert not is_grounded("the portal launches tomorrow morning", SOURCE)

    def test_case_and_whitespace_insensitive(self):
        assert is_grounded("WE  SHOULD   ship   the PORTAL next week", SOURCE)

    def test_short_quote_must_match_whole(self):
        assert is_grounded("schema needs serious work", SOURCE)
        assert not is_grounded("schema rewrite now", SOURCE)

    def test_empty_quote_never_grounded(self):
        assert not is_grounded("", SOURCE)
        assert not is_grounded(None, SOURCE)

    def test_prefix_match_is_the_documented_limitation(self):
        # A real 60-char prefix with a HALLUCINATED tail still passes the gate -
        # this is the known limit the Stage-3 citation verifier exists to cover.
        long_real_prefix = "We should ship the portal next week, it is basically ready to go"
        assert len(normalize(long_real_prefix)) >= 60
        assert is_grounded(long_real_prefix + " and we already told the investors", SOURCE)


class TestGroundUnits:
    def test_partitions_grounded_and_dropped(self):
        units = [
            {"claim": "ship portal", "quote": "We should ship the portal next week", "speaker": "Aditya"},
            {"claim": "fabricated", "quote": "the portal launches tomorrow morning", "speaker": "Aditya"},
            {"claim": "schema first", "quote": "the schema needs serious work first", "speaker": "Vatsal"},
        ]
        res = ground_units(units, SOURCE, meta={"date": "2025-01-01", "title": "T"})
        assert len(res.grounded) == 2
        assert len(res.dropped) == 1
        assert res.dropped[0].claim == "fabricated"
        assert 30 < res.drop_rate < 40  # 1/3

    def test_meta_is_stamped_onto_units(self):
        units = [{"claim": "c", "quote": "the schema needs serious work first", "speaker": "Vatsal"}]
        res = ground_units(units, SOURCE, meta={"date": "2025-02-02", "title": "Talk", "conversation_id": "cid"})
        assert res.grounded[0].date == "2025-02-02"
        assert res.grounded[0].conversation_id == "cid"

    def test_examples_capture_drops(self):
        units = [{"claim": "x", "quote": "never said this at all", "speaker": "Aditya"}]
        res = ground_units(units, SOURCE)
        assert res.examples and "never said this" in res.examples[0]

    def test_empty_input(self):
        res = ground_units([], SOURCE)
        assert res.total == 0
        assert res.drop_rate == 0.0

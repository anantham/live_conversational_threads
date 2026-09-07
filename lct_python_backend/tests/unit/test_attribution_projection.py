"""Audited metadata updates must not reauthor earlier claims or evidence."""
import copy

from lct_python_backend.services.transcript.attribution_projection import apply_attribution_projection


def test_revision_flags_affected_interpretations_without_rewriting_them():
    state = {"nodes": [{"id": "n", "chunk_id": "c", "summary": "S0 argued X", "speaker_id": "S0"},
                       {"id": "other", "chunk_id": "d", "summary": "Unrelated"}],
             "utterance_chunk_map": {"c": ["u"], "d": ["v"]}, "interpretation_revision": "old"}
    before = copy.deepcopy(state)
    changes = [{"utterance_id": "u", "original_speaker_id": "S0", "current_speaker_id": "S1",
                "original_revision": 0, "current_revision": 1, "evidence_segment_ids": ["segment"]}]
    projected = apply_attribution_projection(state, changes)
    assert projected["nodes"][0]["attribution_review_required"] is True
    assert projected["nodes"][0]["summary"] == "S0 argued X"
    assert projected["nodes"][0]["speaker_id"] == "S0"
    assert projected["nodes"][0]["source_attributions"] == changes
    assert "attribution_review_required" not in projected["nodes"][1]
    assert projected["interpretation_revision"] != "old"
    assert state == before

"""Audited speaker changes are distinct from rewriting transcript evidence."""
import copy

import pytest

from lct_python_backend.services.transcript.attribution_revisions import record_attribution_change, validate_attribution_history


def snapshot(speaker, revision):
    return {"speaker_id": speaker, "speaker_revision": revision, "speaker_source": "diarization", "speaker_confidence": .9}


def test_receipts_preserve_prior_metadata_and_chain_to_current_attribution():
    metadata = {"unrelated": {"keep": True}}
    before = copy.deepcopy(metadata)
    updated = record_attribution_change(metadata, snapshot("S0", 0), snapshot("S1", 1), ["segment-1"])
    updated = record_attribution_change(updated, snapshot("S1", 1), snapshot("S2", 2), ["segment-2"])
    receipts = validate_attribution_history("S0", 0, "S2", 2, updated)
    assert [entry["evidence_segment_ids"] for entry in receipts] == [["segment-1"], ["segment-2"]]
    assert metadata == before
    assert updated["unrelated"] == before["unrelated"]


@pytest.mark.parametrize("old,new,evidence", [(snapshot("S0", 0), snapshot("S1", 2), ["s"]),
                                              (snapshot("S0", 0), snapshot("S1", 1), [])])
def test_unproven_or_skipped_revision_is_rejected(old, new, evidence):
    with pytest.raises(ValueError):
        record_attribution_change({}, old, new, evidence)


def test_unexplained_change_and_corrupted_chain_are_rejected():
    with pytest.raises(ValueError):
        validate_attribution_history("S0", 0, "S1", 1, {})
    metadata = record_attribution_change({}, snapshot("S0", 0), snapshot("S1", 1), ["s"])
    with pytest.raises(ValueError):
        validate_attribution_history("S0", 0, "someone-else", 1, metadata)


def test_can_validate_from_later_committed_revision_without_rewriting_old_receipts():
    metadata = record_attribution_change({}, snapshot("S0", 0), snapshot("S1", 1), ["s1"])
    metadata = record_attribution_change(metadata, snapshot("S1", 1), snapshot("S2", 2), ["s2"])
    assert len(validate_attribution_history("S1", 1, "S2", 2, metadata)) == 1

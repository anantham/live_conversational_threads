"""Applied interpretation changes never rewrite historical source evidence."""
import copy
import pytest
from lct_python_backend.services.transcript.passage_projection import project_interpretations
from lct_python_backend.services.transcript.passage_journal import JournalConflict


def test_overlay_changes_only_supported_applied_fields_and_detaches_state():
    state = {"nodes": [{"id": "n", "summary": "Old", "source_excerpt": "Exact original",
                        "utterance_ids": ["u"], "thread_id": "original-thread"}],
             "chunks": {"c": "Exact original"}, "revision": 1}
    original = copy.deepcopy(state)
    canonical = {"n": {"node_name": "Corrected title", "summary": "Corrected meaning",
                       "key_points": ["Corrected keyword"], "source_excerpt": "Not source",
                       "thread_id": "not-an-applied-structural-revision"}}
    projected = project_interpretations(state, canonical)
    assert projected["nodes"][0]["summary"] == "Corrected meaning"
    assert projected["nodes"][0]["source_excerpt"] == "Exact original"
    assert projected["nodes"][0]["utterance_ids"] == ["u"]
    assert projected["nodes"][0]["thread_id"] == "original-thread"
    assert state == original
    canonical["n"]["summary"] = "Later correction"
    assert project_interpretations(state, canonical)["interpretation_revision"] != projected["interpretation_revision"]


def test_missing_canonical_node_requires_reconciliation_not_resurrection():
    with pytest.raises(JournalConflict, match="missing"):
        project_interpretations({"nodes": [{"id": "deleted"}]}, {})

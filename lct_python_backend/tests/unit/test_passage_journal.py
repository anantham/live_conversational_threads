"""Journal contract: scoped, contiguous, immutable, idempotent source commits.

Pure validation tests precede implementation. Real Postgres transaction/restart
tests belong alongside these; a mock session is not proof of durable recovery.
"""
import copy
import pytest

from lct_python_backend.services.transcript.passage_journal import (
    JournalConflict, build_record, restore_records,
)


def source(i):
    return {"id": f"u-{i}", "sequence_number": i, "text": f"Exact source {i}.",
            "speaker_id": "SPEAKER_00", "timestamp_start": i * 10, "timestamp_end": i * 10 + 2}


def patch(i):
    return {"nodes": [{"id": f"n-{i}", "chunk_id": f"c-{i}", "thread_id": "still-open"}],
            "chunks": {f"c-{i}": f"Exact source {i}."},
            "utterance_chunk_map": {f"c-{i}": [f"u-{i}"]}}


def test_restore_preserves_graph_source_and_cursor_without_reinterpreting():
    records = [build_record(1, 0, [source(1)], patch(1)), build_record(2, 1, [source(2)], patch(2))]
    original = copy.deepcopy(records)
    state = restore_records(records)
    assert state["committed_through"] == 2
    assert [n["id"] for n in state["nodes"]] == ["n-1", "n-2"]
    assert state["chunks"] == {"c-1": "Exact source 1.", "c-2": "Exact source 2."}
    assert state["utterance_chunk_map"] == {"c-1": ["u-1"], "c-2": ["u-2"]}
    assert records == original


@pytest.mark.parametrize("change", ["gap", "duplicate_node", "tamper", "changed_predecessor"])
def test_corrupt_or_divergent_history_fails_closed(change):
    first = build_record(1, 0, [source(1)], patch(1))
    second_patch = patch(2)
    if change == "duplicate_node":
        second_patch["nodes"][0]["id"] = "n-1"
    second = build_record(2, 1, [source(2)], second_patch)
    if change == "tamper":
        second["sources"][0]["text"] = "Changed after commit"
    if change == "changed_predecessor":
        second = build_record(2, 0, [source(2)], patch(2))
    with pytest.raises(JournalConflict):
        restore_records([second] if change == "gap" else [first, second])


def test_record_detaches_mutable_caller_data():
    sources, graph = [source(1)], patch(1)
    record = build_record(1, 0, sources, graph)
    sources[0]["text"] = "oops"
    graph["nodes"].clear()
    assert record["sources"][0]["text"] == "Exact source 1."
    assert len(record["patch"]["nodes"]) == 1


@pytest.mark.parametrize("change", ["foreign_source", "rewritten_source", "unbound_node"])
def test_checkpoint_cannot_launder_unbound_or_rewritten_source(change):
    graph = patch(1)
    if change == "foreign_source":
        graph["utterance_chunk_map"]["c-1"] = ["another-conversation"]
    elif change == "rewritten_source":
        graph["chunks"]["c-1"] = "A paraphrase is not original evidence."
    else:
        graph["nodes"][0]["chunk_id"] = "missing"
    with pytest.raises(JournalConflict):
        build_record(1, 0, [source(1)], graph)

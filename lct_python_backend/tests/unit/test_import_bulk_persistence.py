"""Tests for import_bulk_persistence helpers."""

from __future__ import annotations

from lct_python_backend.services.import_bulk_persistence import (
    derive_conversation_name,
    stitch_utterance_chunk_ids,
)


def test_derive_conversation_name_from_nodes():
    nodes = [
        {"node_name": "Alpha"},
        {"node_name": "Beta"},
    ]
    assert derive_conversation_name(nodes, "fallback") == "Alpha / Beta"


def test_stitch_utterance_chunk_ids_matches_substring():
    processor = type("P", (), {"chunk_dict": {"c1": "Hello world from the meeting"}})()
    utterances = [{"text": "hello world"}]
    telemetry: dict = {}
    stitch_utterance_chunk_ids(
        processor=processor,
        final_source_utterances=utterances,
        telemetry=telemetry,
        conversation_id="conv-1",
        log=__import__("logging").getLogger("test"),
    )
    assert utterances[0]["chunk_id"] == "c1"
    assert telemetry["utterance_chunk_stitched"] == 1
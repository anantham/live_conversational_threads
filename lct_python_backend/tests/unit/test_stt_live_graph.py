from lct_python_backend.services.stt.stt_live_graph import (
    build_draft_graph_patch,
    build_speaker_reconciliation_patch,
)


def test_build_draft_graph_patch_uses_stable_ids_and_primary_speaker():
    patch = build_draft_graph_patch(
        "We should probably call Anand tomorrow morning",
        node_id="draft-node-1",
        chunk_id="draft-chunk-1",
        speaker_segments=[
            {"speaker": "SPEAKER_01", "text": "We should probably"},
            {"speaker": "SPEAKER_01", "text": "call Anand tomorrow morning"},
        ],
        predecessor_id="node-final-9",
    )

    assert patch["kind"] == "draft"
    assert patch["chunks"] == {
        "draft-chunk-1": "We should probably call Anand tomorrow morning"
    }
    assert patch["nodes"][0]["id"] == "draft-node-1"
    assert patch["nodes"][0]["chunk_id"] == "draft-chunk-1"
    assert patch["nodes"][0]["speaker_id"] == "SPEAKER_01"
    assert patch["nodes"][0]["predecessor"] == "node-final-9"
    assert patch["nodes"][0]["is_draft"] is True


def test_build_speaker_reconciliation_patch_targets_latest_matching_chunk():
    existing_json = [
        {"id": "node-old", "chunk_id": "chunk-old", "speaker_id": None, "node_name": "Older"},
        {"id": "node-new", "chunk_id": "chunk-new", "speaker_id": None, "node_name": "Newest"},
    ]
    chunk_dict = {
        "chunk-old": "We talked about books yesterday",
        "chunk-new": "I think love is mostly attention and repeated care",
    }

    patch = build_speaker_reconciliation_patch(
        existing_json,
        chunk_dict,
        source_text="love is mostly attention and repeated care",
        segments=[
            {"speaker": "SPEAKER_00", "text": "love is mostly attention"},
            {"speaker": "SPEAKER_00", "text": "and repeated care"},
        ],
    )

    assert patch is not None
    assert patch["kind"] == "speaker_reconciliation"
    assert patch["chunk_id"] == "chunk-new"
    assert patch["speaker_id"] == "SPEAKER_00"
    assert [node["id"] for node in patch["nodes"]] == ["node-new"]
    assert patch["nodes"][0]["speaker_id"] == "SPEAKER_00"
    assert patch["chunks"]["chunk-new"].startswith("[SPEAKER_00]:")

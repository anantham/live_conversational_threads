"""Checkpoint/resume error coverage for POST /api/import/process-file."""

from unittest.mock import AsyncMock

import lct_python_backend.services.import_pipeline.import_bulk_checkpoint_flow as checkpoint_flow
from lct_python_backend.tests.unit.import_api_test_support import (
    build_test_client,
    load_import_api_with_stubs,
    local_stt_settings,
    parse_sse_events,
)

def test_process_file_error_event_surfaces_resume_metadata(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value=local_stt_settings()),
    )
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    monkeypatch.setattr(checkpoint_flow, "compute_file_hash", lambda _path: "fake-audio-hash")
    monkeypatch.setattr(
        checkpoint_flow,
        "find_checkpoint",
        AsyncMock(
            return_value={
                "conversation_id": "resume-conversation",
                "total_chunks": 4,
                "completed_chunks": 2,
                "completed_chunk_texts": [
                    {"index": 1, "text": "cached one"},
                    {"index": 2, "text": "cached two"},
                ],
            }
        ),
    )

    async def _raise(*args, **kwargs):
        raise RuntimeError("stt provider request failed (503)")

    monkeypatch.setattr(import_api, "transcribe_uploaded_file", _raise)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    error_payload = [payload for name, payload in events if name == "error"][-1]
    resumed_transcripts = [
        payload
        for name, payload in events
        if name == "transcript" and payload.get("resumed") is True
    ]
    assert error_payload["retryable"] is True
    assert error_payload["resume_available"] is True
    assert error_payload["checkpoint_chunks"] == 2
    assert error_payload["checkpoint_total_chunks"] == 4
    assert error_payload["failure_stage"] == "transcribing"
    assert error_payload["telemetry"]["checkpoint_chunks"] == 2
    assert error_payload["telemetry"]["checkpoint_total_chunks"] == 4
    assert error_payload["telemetry"]["resume_available"] is True
    assert [item["text"] for item in resumed_transcripts] == ["cached one", "cached two"]

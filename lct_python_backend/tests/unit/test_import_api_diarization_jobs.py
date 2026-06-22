"""Async diarization job endpoints and enqueue handoff."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from lct_python_backend.tests.unit.import_api_test_support import (
    build_test_client,
    load_import_api_with_stubs,
    parse_sse_events,
)

def test_process_file_enqueues_async_diarization_job_for_audio(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    stt_settings = {
        "provider": "parakeet",
        "provider_http_urls": {"parakeet": "http://localhost:9000/v1/audio/transcriptions"},
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    monkeypatch.setattr(import_api, "_is_async_import_diarization_enabled", lambda: True)
    monkeypatch.setattr(
        import_api,
        "_copy_temp_upload_for_async_job",
        lambda *args, **kwargs: Path("/tmp/import_diar_job_test.wav"),
    )
    enqueue_mock = AsyncMock(return_value={"job_id": "job-123", "status": "pending"})
    monkeypatch.setattr(import_api, "_enqueue_import_diarization_job", enqueue_mock)
    monkeypatch.setattr(
        import_api,
        "transcribe_uploaded_file",
        AsyncMock(
            return_value=SimpleNamespace(
                transcript_text="alpha\nbeta\ngamma",
                source_type="audio",
                metadata={"provider": "parakeet"},
            )
        ),
    )

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "alpha beta gamma"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    diarization_job = done_payload.get("diarization_job")
    assert diarization_job is not None
    assert diarization_job["id"] == "job-123"
    assert diarization_job["status"] == "pending"
    assert diarization_job["status_url"] == "/api/import/diarization-jobs/job-123"
    assert diarization_job["events_url"] == "/api/import/diarization-jobs/job-123/events"
    assert done_payload["telemetry"].get("async_diarization_job_id") == "job-123"
    enqueue_mock.assert_awaited_once()
    enqueue_kwargs = enqueue_mock.await_args.kwargs
    assert enqueue_kwargs["provider_override"] is None
    assert enqueue_kwargs["stt_settings"] == stt_settings
def test_get_diarization_job_status_endpoint(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    status_mock = AsyncMock(
        return_value={
            "job_id": "job-xyz",
            "status": "running",
            "event_cursor": 4,
            "telemetry": {"queue_wait_ms": 10},
        }
    )
    monkeypatch.setattr(import_api, "_get_import_diarization_job", status_mock)

    response = client.get("/api/import/diarization-jobs/job-xyz")
    assert response.status_code == 200
    payload = response.json()
    assert payload["job_id"] == "job-xyz"
    assert payload["status"] == "running"
    status_mock.assert_awaited_once()
def test_get_diarization_job_status_404(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)
    monkeypatch.setattr(import_api, "_get_import_diarization_job", AsyncMock(return_value=None))

    response = client.get("/api/import/diarization-jobs/missing-job")
    assert response.status_code == 404
    assert "missing-job" in response.json()["detail"]
def test_get_diarization_job_events_endpoint(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    events_mock = AsyncMock(
        return_value={
            "job_id": "job-xyz",
            "status": "running",
            "cursor": 2,
            "next_cursor": 3,
            "events": [
                {
                    "seq": 3,
                    "type": "patch",
                    "created_at": "2026-02-25T12:00:00Z",
                    "payload": {"nodes": [], "chunks": {"c1": "hello"}},
                }
            ],
        }
    )
    monkeypatch.setattr(import_api, "_get_import_diarization_job_events", events_mock)

    response = client.get("/api/import/diarization-jobs/job-xyz/events?cursor=2")
    assert response.status_code == 200
    payload = response.json()
    assert payload["job_id"] == "job-xyz"
    assert payload["next_cursor"] == 3
    assert payload["events"][0]["seq"] == 3
    events_mock.assert_awaited_once()
    assert events_mock.await_args.kwargs["cursor"] == 2
def test_get_diarization_job_events_cursor_must_be_non_negative(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    response = client.get("/api/import/diarization-jobs/job-xyz/events?cursor=-1")
    assert response.status_code == 400
    assert response.json()["detail"] == "cursor must be >= 0"

import importlib
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_import_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.import_api", None)
    return importlib.import_module("lct_python_backend.import_api")


def _build_test_client(import_api_module):
    app = FastAPI()
    app.include_router(import_api_module.router)
    return TestClient(app)


def _parse_sse_events(raw_stream: str):
    events = []
    current_event = "message"
    data_lines = []

    for line in raw_stream.splitlines():
        if line == "":
            if data_lines:
                payload = json.loads("\n".join(data_lines))
                events.append((current_event, payload))
            current_event = "message"
            data_lines = []
            continue

        if line.startswith("event:"):
            current_event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())

    if data_lines:
        payload = json.loads("\n".join(data_lines))
        events.append((current_event, payload))
    return events


def test_process_file_streams_graph_and_done_events(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(
        import_api,
        "transcribe_uploaded_file",
        AsyncMock(
            return_value=SimpleNamespace(
                transcript_text="alpha\nbeta\ngamma",
                source_type="text",
                metadata={"file_kind": "text"},
            )
        ),
    )

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None):
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
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    event_names = [name for name, _ in events]
    assert "status" in event_names
    assert "transcript" in event_names
    assert "graph" in event_names
    assert "done" in event_names

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["node_count"] == 1
    assert done_payload["chunk_count"] == 1


def test_process_file_passes_provider_override_to_transcriber(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    stt_settings = {
        "provider": "whisper",
        "provider_http_urls": {"whisper": "http://localhost:5092/v1/audio/transcriptions"},
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    transcribe_mock = AsyncMock(
        return_value=SimpleNamespace(
            transcript_text="audio segment",
            source_type="audio",
            metadata={"provider": "senko"},
        )
    )
    monkeypatch.setattr(import_api, "transcribe_uploaded_file", transcribe_mock)

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "audio segment"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        data={"provider": "senko"},
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        _ = list(response.iter_text())

    kwargs = transcribe_mock.await_args.kwargs
    assert kwargs["provider_override"] == "senko"
    assert kwargs["stt_settings"] == stt_settings


def test_process_file_streams_error_event_when_transcriber_fails(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))

    async def _raise(*args, **kwargs):
        raise RuntimeError("transcriber boom")

    monkeypatch.setattr(import_api, "transcribe_uploaded_file", _raise)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    error_events = [payload for name, payload in events if name == "error"]
    assert error_events, "expected an SSE error event"
    assert "transcriber boom" in error_events[0]["message"]


def test_process_file_streams_processor_status_context(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(
        import_api,
        "transcribe_uploaded_file",
        AsyncMock(
            return_value=SimpleNamespace(
                transcript_text="alpha\nbeta\ngamma",
                source_type="text",
                metadata={"file_kind": "text"},
            )
        ),
    )

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None):
            self._send_update = send_update
            self._send_status = send_status
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            await self._send_status("warning", "accumulate warning", {"stage": "accumulate"})

        async def flush(self):
            await self._send_status(
                "warning",
                "generation warning",
                {"stage": "generate_lct_json"},
            )
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "alpha beta gamma"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    status_events = [payload for name, payload in events if name == "status"]
    assert any(item.get("stage") == "accumulate" and item.get("progress") == 0.65 for item in status_events)
    assert any(
        item.get("stage") == "generate_lct_json" and item.get("progress") == 0.85
        for item in status_events
    )

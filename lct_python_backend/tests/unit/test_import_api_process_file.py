import asyncio
import importlib
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

try:
    from google import genai as _google_genai  # noqa: F401
except ImportError:
    google_module = sys.modules.get("google")
    if google_module is None:
        google_module = types.ModuleType("google")
        sys.modules["google"] = google_module

    genai_module = types.ModuleType("google.genai")

    class _UnavailableGenaiClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("google-genai test stub should not be used at runtime")

    genai_module.Client = _UnavailableGenaiClient
    types_module = types.ModuleType("google.genai.types")
    genai_module.types = types_module
    setattr(google_module, "genai", genai_module)
    sys.modules["google.genai"] = genai_module
    sys.modules["google.genai.types"] = types_module

try:
    from pydub import AudioSegment as _PydubAudioSegment  # noqa: F401
except ImportError:
    pydub_module = types.ModuleType("pydub")

    class _StubAudioSegment:
        pass

    silence_module = types.ModuleType("pydub.silence")
    silence_module.detect_silence = lambda *args, **kwargs: []
    pydub_module.AudioSegment = _StubAudioSegment
    pydub_module.silence = silence_module
    sys.modules["pydub"] = pydub_module
    sys.modules["pydub.silence"] = silence_module

try:
    import pdfplumber as _pdfplumber  # noqa: F401
except ImportError:
    pdfplumber_module = types.ModuleType("pdfplumber")

    def _pdfplumber_open(*args, **kwargs):
        raise RuntimeError("pdfplumber test stub should not be used at runtime")

    pdfplumber_module.open = _pdfplumber_open
    sys.modules["pdfplumber"] = pdfplumber_module


def _load_import_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.import_api", None)
    module = importlib.import_module("lct_python_backend.import_api")
    monkeypatch.setattr(
        module,
        "load_artifact_export_settings",
        AsyncMock(
            return_value={
                "enabled": False,
                "root_path": "",
                "write_canvas": True,
                "write_transcript": True,
                "include_chunks": False,
                "trigger_on_import_complete": True,
                "trigger_on_live_finalize": False,
            }
        ),
    )
    monkeypatch.setattr(
        module,
        "auto_export_conversation_artifacts",
        AsyncMock(return_value={"ok": True, "written_files": []}),
    )
    return module


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
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
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
    assert isinstance(done_payload.get("telemetry"), dict)
    assert done_payload["telemetry"].get("total_processing_ms") is not None
    assert done_payload["telemetry"].get("transcript_chunk_count") == 1
    assert done_payload["telemetry"].get("source_type") == "text"
    assert done_payload["telemetry"].get("bottleneck_stage") is not None
    assert done_payload["telemetry"].get("bottleneck_ms") is not None


def test_process_file_passes_provider_override_to_transcriber(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    stt_settings = {
        "provider": "whisper",
        "provider_http_urls": {"whisper": "http://localhost:5092/v1/audio/transcriptions"},
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    transcribe_mock = AsyncMock(
        return_value=SimpleNamespace(
            transcript_text="audio segment",
            source_type="audio",
            metadata={"provider": "senko"},
        )
    )
    monkeypatch.setattr(import_api, "transcribe_uploaded_file", transcribe_mock)

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
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


def test_process_file_uses_sequential_path_for_cloud_import_candidate(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    import lct_python_backend.services.import_bulk_graph_pass as graph_pass

    client = _build_test_client(import_api)
    monkeypatch.setattr(graph_pass, "SEGMENT_PROCESSING_FORCE_ENABLED", True)

    stt_settings = {
        "provider": "whisper",
        "local_only": False,
        "upload_local_first": False,
        "live_cloud_fallback_enabled": True,
        "provider_http_urls": {
            "parakeet": "http://localhost:5092/v1/audio/transcriptions",
            "whisper": "http://100.81.65.74:7777/api/transcribe",
        },
        "cloud_fallback_providers": {
            "openai_audio": {
                "enabled": True,
                "base_url": "https://api.openai.com",
                "api_key": "sk-openai-secret",
                "model": "gpt-4o-mini-transcribe",
                "diarize_model": "gpt-4o-transcribe-diarize",
            }
        },
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))

    transcribe_mock = AsyncMock(
        return_value=SimpleNamespace(
            transcript_text="SPEAKER_00: hello\nSPEAKER_01: hi",
            source_type="audio",
            metadata={"provider": "openai_audio"},
        )
    )
    monkeypatch.setattr(import_api, "transcribe_uploaded_file", transcribe_mock)

    async def _segmented_should_not_run(*args, **kwargs):
        raise AssertionError("segmented import path should not run for cloud import candidates")
        yield  # pragma: no cover

    monkeypatch.setattr(import_api, "transcribe_audio_segmented", _segmented_should_not_run)

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "hello hi"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["telemetry"]["segmented_processing"] is False
    assert done_payload["telemetry"]["stt_candidate_provider"] == "openai_audio"
    assert done_payload["telemetry"]["stt_candidate_transport"] == "openai_audio"
    transcribe_mock.assert_awaited_once()


def test_process_file_uses_byok_session_for_openai_import(monkeypatch):
    import lct_python_backend.services.byok_session_store as byok

    byok._BYOK_SESSIONS.clear()
    monkeypatch.setattr(byok, "validate_byok_api_key", AsyncMock(return_value=None))
    session_payload = asyncio.run(
        byok.create_byok_session(
            provider="openai_audio",
            api_key="sk-byok-secret",
            scopes=[byok.BYOK_SCOPE_STT_IMPORT, byok.BYOK_SCOPE_LLM_IMPORT],
        )
    )

    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    stt_settings = {
        "provider": "whisper",
        "local_only": True,
        "live_cloud_fallback_enabled": False,
        "provider_http_urls": {
            "whisper": "http://100.81.65.74:7777/api/transcribe",
        },
        "http_url": "http://100.81.65.74:7777/api/transcribe",
        "cloud_fallback_providers": {},
    }
    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value=stt_settings))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    transcribe_mock = AsyncMock(
        return_value=SimpleNamespace(
            transcript_text="hello from byok",
            source_type="audio",
            metadata={"provider": "openai_audio", "stt_backend": "cloud_openai_audio"},
        )
    )
    monkeypatch.setattr(import_api, "transcribe_uploaded_file", transcribe_mock)
    processor_init = {}

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, providers=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}
            processor_init["llm_config"] = llm_config or {}
            processor_init["providers"] = list(providers or [])
            processor_init["kwargs"] = kwargs

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "hello from byok"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        data={"byok_session_token": session_payload["byok_session_token"]},
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    kwargs = transcribe_mock.await_args.kwargs
    runtime_stt_settings = kwargs["stt_settings"]
    openai_provider = runtime_stt_settings["cloud_fallback_providers"]["openai_audio"]
    assert kwargs["provider_override"] == "openai_audio"
    assert runtime_stt_settings["local_only"] is False
    assert runtime_stt_settings["live_cloud_fallback_enabled"] is True
    assert openai_provider["enabled"] is True
    assert openai_provider["api_key"] == "sk-byok-secret"
    assert processor_init["llm_config"]["mode"] == "local"
    assert (
        processor_init["llm_config"]["backend"]
        == f"openai_{byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL}"
    )
    assert processor_init["providers"] == [
        {
            "id": byok.BYOK_LLM_PROVIDER_ID,
            "name": "BYOK OpenAI",
            "type": "openai",
            "base_url": byok.DEFAULT_OPENAI_BASE_URL,
            "model": byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL,
            "api_key": "sk-byok-secret",
            "enabled": True,
            "timeout_seconds": byok.DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS,
            "session_scoped": True,
        }
    ]

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["telemetry"]["llm_backend"] == f"openai_{byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL}"
    assert done_payload["telemetry"]["stt_candidate_provider"] == "openai_audio"
    assert done_payload["telemetry"]["stt_candidate_transport"] == "openai_audio"


def test_process_file_applies_graph_refinement_when_available(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    monkeypatch.setattr(
        import_api,
        "transcribe_uploaded_file",
        AsyncMock(
            return_value=SimpleNamespace(
                transcript_text=" ".join("topic pivot" for _ in range(800)),
                source_type="text",
                metadata={"file_kind": "text"},
                utterances=[
                    {
                        "text": f"utterance {index} topic pivot monastery visa meta conversation",
                        "speaker_id": "SPEAKER_00",
                        "timestamp_start": float(index),
                        "timestamp_end": float(index + 1),
                    }
                    for index in range(22)
                ],
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
            self.chunk_dict = {"c1": "topic pivot"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)
    monkeypatch.setattr(
        import_api,
        "refine_import_graph_nodes",
        AsyncMock(
            return_value={
                "applied": True,
                "reason": "refined",
                "backend": "local_test_backend",
                "refinement_ms": 42.5,
                "original_node_count": 1,
                "refined_node_count": 2,
                "original_metrics": {"thread_count": 1, "edge_count": 0, "tangent_count": 0, "return_count": 0},
                "refined_metrics": {"thread_count": 2, "edge_count": 1, "tangent_count": 1, "return_count": 0},
                "nodes": [
                    {
                        "id": "n1",
                        "node_name": "Node 1",
                        "summary": "First refined node",
                        "source_excerpt": "topic pivot",
                        "predecessor": None,
                        "successor": "Node 2",
                        "thread_id": "thread-1",
                        "thread_state": "new_thread",
                        "contextual_relation": {},
                        "edge_relations": [],
                        "linked_nodes": [],
                        "speaker_id": "SPEAKER_00",
                        "claims": [],
                        "is_bookmark": False,
                        "is_contextual_progress": False,
                    },
                    {
                        "id": "n2",
                        "node_name": "Node 2",
                        "summary": "Second refined node",
                        "source_excerpt": "topic pivot monastery visa",
                        "predecessor": "Node 1",
                        "successor": None,
                        "thread_id": "thread-2",
                        "thread_state": "new_thread",
                        "contextual_relation": {"Node 1": "Conversation branches to a new tangent."},
                        "edge_relations": [
                            {
                                "related_node": "Node 1",
                                "relation_type": "tangent",
                                "relation_text": "Conversation branches to a new tangent.",
                            }
                        ],
                        "linked_nodes": ["Node 1"],
                        "speaker_id": "SPEAKER_00",
                        "claims": [],
                        "is_bookmark": False,
                        "is_contextual_progress": False,
                    },
                ],
            }
        ),
    )

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    graph_payloads = [
        payload["data"]
        for name, payload in events
        if name == "graph" and payload.get("type") == "existing_json"
    ]
    refinement_statuses = [
        payload
        for name, payload in events
        if name == "status" and payload.get("stage") == "refining_graph"
    ]

    assert done_payload["node_count"] == 2
    assert done_payload["telemetry"]["graph_refinement"]["applied"] is True
    assert done_payload["telemetry"]["graph_refinement"]["refined_node_count"] == 2
    assert any(len(graph_data) == 2 for graph_data in graph_payloads)
    assert any("Refined graph from 1 to 2 nodes." in status.get("message", "") for status in refinement_statuses)


def test_process_file_streams_error_event_when_transcriber_fails(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))

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
    assert error_events[0]["retryable"] is False
    assert error_events[0]["resume_available"] is False
    assert error_events[0]["checkpoint_chunks"] == 0
    assert isinstance(error_events[0].get("telemetry"), dict)
    assert error_events[0]["telemetry"].get("active_stage") in {"transcribing", "parsing"}
    assert error_events[0]["telemetry"].get("retryable") is False
    assert error_events[0]["telemetry"].get("resume_available") is False
    assert error_events[0]["telemetry"].get("total_elapsed_ms") is not None


def test_process_file_error_event_surfaces_resume_metadata(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    import lct_python_backend.services.import_bulk_pipeline as bulk_pipeline

    client = _build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value={"provider": "whisper", "http_timeout_seconds": 10.0}),
    )
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
    monkeypatch.setattr(bulk_pipeline, "compute_file_hash", lambda _path: "fake-audio-hash")
    monkeypatch.setattr(
        bulk_pipeline,
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
        events = _parse_sse_events("".join(response.iter_text()))

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


def test_process_file_streams_processor_status_context(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
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
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
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
    assert any(
        isinstance(item.get("telemetry"), dict) and item["telemetry"].get("total_elapsed_ms") is not None
        for item in status_events
    )


def test_process_file_emits_fallback_status_notice(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))

    async def fake_transcribe_uploaded_file(*args, **kwargs):
        on_provider_fallback = kwargs.get("on_provider_fallback")
        if on_provider_fallback:
            await on_provider_fallback("parakeet", "whisper", "ReadError")
        return SimpleNamespace(
            transcript_text="alpha\nbeta",
            source_type="audio",
            metadata={
                "provider": "whisper",
                "provider_fallback_used": True,
                "provider_fallback_from": "parakeet",
                "provider_fallback_to": "whisper",
            },
        )

    monkeypatch.setattr(import_api, "transcribe_uploaded_file", AsyncMock(side_effect=fake_transcribe_uploaded_file))

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "alpha beta"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    status_events = [payload for name, payload in events if name == "status"]
    fallback_events = [payload for payload in status_events if payload.get("notice_type") == "stt_provider_fallback"]
    assert fallback_events, "expected stt_provider_fallback status notice"
    assert fallback_events[0]["fallback"]["from_provider"] == "parakeet"
    assert fallback_events[0]["fallback"]["to_provider"] == "whisper"
    assert "Falling back to whisper" in fallback_events[0]["message"]


def test_process_file_emits_transcribing_transcript_events(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))

    async def fake_transcribe_uploaded_file(*args, **kwargs):
        on_chunk_progress = kwargs.get("on_chunk_progress")
        if on_chunk_progress:
            await on_chunk_progress(1, 4, "first transcribed chunk")
            await on_chunk_progress(2, 4, "second transcribed chunk")
        return SimpleNamespace(
            transcript_text="first transcribed chunk\nsecond transcribed chunk",
            source_type="audio",
            metadata={"provider": "whisper"},
        )

    monkeypatch.setattr(import_api, "transcribe_uploaded_file", AsyncMock(side_effect=fake_transcribe_uploaded_file))

    class FakeProcessor:
        def __init__(self, send_update, send_status=None, llm_config=None, **kwargs):
            self._send_update = send_update
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            self.existing_json = [{"id": "n1", "node_name": "Node 1", "chunk_id": "c1"}]
            self.chunk_dict = {"c1": "first second"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    transcript_events = [payload for name, payload in events if name == "transcript"]
    stt_events = [payload for payload in transcript_events if payload.get("phase") == "transcribing"]
    assert len(stt_events) == 2
    assert stt_events[0]["text"] == "first transcribed chunk"
    assert stt_events[0]["index"] == 1
    assert stt_events[0]["total"] == 4
    telemetry = stt_events[0].get("telemetry") or {}
    assert telemetry.get("stt_chunks_completed") == 1
    assert telemetry.get("stt_chunks_total") == 4

    transcribing_statuses = [
        payload
        for name, payload in events
        if name == "status" and payload.get("stage") == "transcribing"
    ]
    assert transcribing_statuses
    status_telemetry = transcribing_statuses[-1].get("telemetry") or {}
    assert "transcription_eta_ms" in status_telemetry
    assert "transcription_estimated_total_ms" in status_telemetry


def test_process_file_enqueues_async_diarization_job_for_audio(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

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
        events = _parse_sse_events("".join(response.iter_text()))

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


def test_process_file_reports_auto_exported_artifacts(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(
        import_api,
        "load_artifact_export_settings",
        AsyncMock(
            return_value={
                "enabled": True,
                "root_path": "/tmp/obsidian",
                "write_canvas": True,
                "write_transcript": True,
                "include_chunks": False,
                "trigger_on_import_complete": True,
                "trigger_on_live_finalize": False,
            }
        ),
    )
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))
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
    export_mock = AsyncMock(
        return_value={
            "ok": True,
            "root_path": "/tmp/obsidian",
            "written_files": [
                "/tmp/obsidian/demo.canvas",
                "/tmp/obsidian/demo.txt",
            ],
        }
    )
    monkeypatch.setattr(import_api, "auto_export_conversation_artifacts", export_mock)

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
        files={"file": ("notes.txt", b"hello", "text/plain")},
    ) as response:
        assert response.status_code == 200
        events = _parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["artifact_export"]["root_path"] == "/tmp/obsidian"
    assert len(done_payload["artifact_export"]["written_files"]) == 2
    assert done_payload["telemetry"]["artifact_export"]["written_files"][0].endswith(".canvas")
    export_mock.assert_awaited_once()


def test_get_diarization_job_status_endpoint(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

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
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)
    monkeypatch.setattr(import_api, "_get_import_diarization_job", AsyncMock(return_value=None))

    response = client.get("/api/import/diarization-jobs/missing-job")
    assert response.status_code == 404
    assert "missing-job" in response.json()["detail"]


def test_get_diarization_job_events_endpoint(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

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
    import_api = _load_import_api_with_stubs(monkeypatch)
    client = _build_test_client(import_api)

    response = client.get("/api/import/diarization-jobs/job-xyz/events?cursor=-1")
    assert response.status_code == 400
    assert response.json()["detail"] == "cursor must be >= 0"

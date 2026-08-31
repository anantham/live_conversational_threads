"""SSE streaming coverage for POST /api/import/process-file."""

import asyncio
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import lct_python_backend.services.import_pipeline.import_bulk_graph_pass as graph_pass
from lct_python_backend.tests.unit.import_api_test_support import (
    build_test_client,
    load_import_api_with_stubs,
    local_stt_settings,
    parse_sse_events,
)

def test_process_file_streams_graph_and_done_events(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

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
        events = parse_sse_events("".join(response.iter_text()))

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
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    stt_settings = local_stt_settings()
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


def test_process_file_without_approved_stt_authority_emits_descriptive_error(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value={"local_authorities": []}),
    )

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    error = [payload for name, payload in events if name == "error"][-1]
    assert "No approved local STT authority is enabled" in error["message"]
    assert error["failure_stage"] == "uploading"
    assert error["resume_available"] is False


def test_process_file_uses_sequential_path_for_cloud_import_candidate(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    import lct_python_backend.services.import_pipeline.import_bulk_graph_pass as graph_pass

    client = build_test_client(import_api)
    monkeypatch.setattr(graph_pass, "SEGMENT_PROCESSING_FORCE_ENABLED", True)

    from lct_python_backend.services.byok_session_store import (
        build_runtime_stt_settings_for_byok,
    )

    stt_settings = build_runtime_stt_settings_for_byok(
        local_stt_settings(),
        {
            "provider": "openai_audio",
            "base_url": "https://api.openai.com",
            "api_key": "session-key",
            "model": "gpt-4o-mini-transcribe",
            "diarize_model": "gpt-4o-transcribe-diarize",
        },
    )
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
        data={"provider": "openai_audio"},
        files={"file": ("clip.wav", b"RIFF....WAVE", "audio/wav")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["telemetry"]["segmented_processing"] is False
    assert done_payload["telemetry"]["stt_candidate_provider"] == "openai_audio"
    assert done_payload["telemetry"]["stt_candidate_transport"] == "openai_audio"
    transcribe_mock.assert_awaited_once()
def test_process_file_applies_graph_refinement_when_available(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value=local_stt_settings(provider="parakeet")),
    )
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
        events = parse_sse_events("".join(response.iter_text()))

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
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value=local_stt_settings()),
    )
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
        events = parse_sse_events("".join(response.iter_text()))

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
def test_process_file_streams_processor_status_context(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

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
        events = parse_sse_events("".join(response.iter_text()))

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
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value=local_stt_settings(provider="parakeet")),
    )
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
        events = parse_sse_events("".join(response.iter_text()))

    status_events = [payload for name, payload in events if name == "status"]
    fallback_events = [payload for payload in status_events if payload.get("notice_type") == "stt_provider_fallback"]
    assert fallback_events, "expected stt_provider_fallback status notice"
    assert fallback_events[0]["fallback"]["from_provider"] == "parakeet"
    assert fallback_events[0]["fallback"]["to_provider"] == "whisper"
    assert "Falling back to whisper" in fallback_events[0]["message"]
def test_process_file_emits_transcribing_transcript_events(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(
        import_api,
        "load_stt_settings",
        AsyncMock(return_value=local_stt_settings()),
    )
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
        events = parse_sse_events("".join(response.iter_text()))

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
def test_process_file_reports_auto_exported_artifacts(monkeypatch):
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

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
        events = parse_sse_events("".join(response.iter_text()))

    done_payload = [payload for name, payload in events if name == "done"][-1]
    assert done_payload["artifact_export"]["root_path"] == "/tmp/obsidian"
    assert len(done_payload["artifact_export"]["written_files"]) == 2
    assert done_payload["telemetry"]["artifact_export"]["written_files"][0].endswith(".canvas")
    export_mock.assert_awaited_once()


def test_process_file_converts_whatsapp_zip_before_transcribing(monkeypatch):
    """A .zip upload is unzipped/parsed/joined into plain text BEFORE it ever
    reaches transcribe_uploaded_file — the rest of the pipeline (mocked here)
    should see an ordinary .txt file, never the original .zip."""
    import_api = load_import_api_with_stubs(monkeypatch)
    client = build_test_client(import_api)

    monkeypatch.setattr(import_api, "load_stt_settings", AsyncMock(return_value={"provider": "whisper"}))
    monkeypatch.setattr(import_api, "load_llm_config", AsyncMock(return_value={"mode": "local"}))
    monkeypatch.setattr(import_api, "load_llm_providers", AsyncMock(return_value={"providers": []}))

    captured = {}

    async def fake_transcribe_uploaded_file(*, temp_path, filename, **kwargs):
        captured["filename"] = filename
        captured["temp_path"] = temp_path
        captured["text"] = Path(temp_path).read_text(encoding="utf-8")
        return SimpleNamespace(
            transcript_text=captured["text"],
            source_type="text",
            metadata={"file_kind": "text"},
        )

    monkeypatch.setattr(
        import_api, "transcribe_uploaded_file", AsyncMock(side_effect=fake_transcribe_uploaded_file)
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
            self.chunk_dict = {"c1": "converted"}
            await self._send_update(self.existing_json, self.chunk_dict)

    monkeypatch.setattr(import_api, "TranscriptProcessor", FakeProcessor)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w") as zf:
        zf.writestr("_chat.txt", "[01/02/2026, 09:15:03] Alice: Hey everyone\n")
    zip_bytes = zip_buffer.getvalue()

    with client.stream(
        "POST",
        "/api/import/process-file",
        files={"file": ("WhatsApp Chat - Test.zip", zip_bytes, "application/zip")},
    ) as response:
        assert response.status_code == 200
        events = parse_sse_events("".join(response.iter_text()))

    event_names = [name for name, _ in events]
    assert "done" in event_names
    assert "error" not in event_names

    assert captured["filename"].endswith(".txt")
    assert captured["text"] == "Alice: Hey everyone"

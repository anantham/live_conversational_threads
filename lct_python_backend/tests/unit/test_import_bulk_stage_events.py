"""Tests for ImportBulkStageEvents — SSE payload shaping for bulk import."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest

from lct_python_backend.services.import_pipeline.import_bulk_stage_events import ImportBulkStageEvents


@pytest.fixture
def emitter():
    emit = AsyncMock()
    started = time.perf_counter()
    telemetry = {"stt_backend": "whisper-local", "llm_backend": "gemini"}
    events = ImportBulkStageEvents(emit=emit, pipeline_started_at=started, telemetry=telemetry)
    return events, emit


@pytest.mark.asyncio
async def test_send_graph_update_emits_patch_then_snapshot(emitter):
    events, emit = emitter
    await events.send_graph_update([{"id": "n1"}], {"c1": {}}, patch={"add": []})
    assert emit.await_count == 3
    assert emit.await_args_list[0].args == ("graph", {"type": "graph_patch", "data": {"add": []}})
    assert emit.await_args_list[1].args[0] == "graph"
    assert emit.await_args_list[1].args[1]["type"] == "existing_json"
    assert emit.await_args_list[2].args[1]["type"] == "chunk_dict"


@pytest.mark.asyncio
async def test_send_analysis_status_uses_telemetry_backends(emitter):
    events, emit = emitter
    await events.send_analysis_status("info", "working", {"stage": "accumulate"})
    emit.assert_awaited_once()
    _event, payload = emit.await_args.args
    assert _event == "status"
    assert payload["level"] == "info"
    assert payload["stage"] == "accumulate"
    assert payload["progress"] == 0.65
    assert payload["stt_backend"] == "whisper-local"
    assert payload["llm_backend"] == "gemini"
    assert "total_elapsed_ms" in payload["telemetry"]


@pytest.mark.asyncio
async def test_emit_chunk_progress_status_and_transcript(emitter):
    events, emit = emitter
    await events.emit_chunk_progress(
        chunk_idx=2,
        total=5,
        progress=0.2,
        normalized_chunk_text="hello world",
        transcription_elapsed_ms=1000,
        transcription_eta_ms=3000,
        transcription_estimated_total_ms=4000,
    )
    assert emit.await_count == 2
    status_payload = emit.await_args_list[0].args[1]
    transcript_payload = emit.await_args_list[1].args[1]
    assert status_payload["stage"] == "transcribing"
    assert status_payload["message"] == "Transcribing audio chunk 2/5..."
    assert transcript_payload["text"] == "hello world"
    assert transcript_payload["chunk_id"] == "stt-chunk-2"


@pytest.mark.asyncio
async def test_emit_pipeline_error_shape(emitter):
    events, emit = emitter
    await events.emit_pipeline_error(
        err_msg="boom",
        filename="clip.m4a",
        conversation_id="conv-1",
        active_stage="transcribing",
        retryable=True,
        resume_available=True,
        checkpoint_chunks=3,
        checkpoint_total_chunks=10,
        error_telemetry={"retryable": True},
    )
    emit.assert_awaited_once()
    assert emit.await_args.args[0] == "error"
    payload = emit.await_args.args[1]
    assert payload["message"] == "boom"
    assert payload["failure_stage"] == "transcribing"
    assert payload["checkpoint_chunks"] == 3
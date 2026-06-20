"""Tests for import_bulk_checkpoint_flow."""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lct_python_backend.services.import_bulk_checkpoint_flow import (
    CheckpointFlowState,
    bootstrap_audio_checkpoint_flow,
    clear_import_checkpoint_safe,
    persist_chunk_checkpoint_safe,
)
from lct_python_backend.services.import_bulk_stage_events import ImportBulkStageEvents


@pytest.mark.asyncio
async def test_bootstrap_skips_non_audio():
    emit = AsyncMock()
    events = ImportBulkStageEvents(emit=emit, pipeline_started_at=0.0, telemetry={})
    state = await bootstrap_audio_checkpoint_flow(
        db=AsyncMock(),
        temp_path="/tmp/x.wav",
        filename="x.wav",
        content_size=10,
        conversation_id="conv-1",
        is_likely_audio=False,
        stt_backend="local",
        stage_events=events,
        telemetry={},
        log=MagicMock(),
    )
    assert state.file_hash is None
    assert state.cache_hit is False
    emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_bootstrap_cache_hit_short_circuits():
    emit = AsyncMock()
    telemetry: dict = {}
    events = ImportBulkStageEvents(emit=emit, pipeline_started_at=0.0, telemetry=telemetry)
    db = AsyncMock()
    count_row = MagicMock()
    count_row.scalar.return_value = 3
    db.execute = AsyncMock(return_value=count_row)

    checkpoint = {
        "conversation_id": "prior-conv",
        "completed_chunks": 5,
        "total_chunks": 5,
        "completed_chunk_texts": [],
    }

    mock_audio_storage = MagicMock()
    mock_audio_storage.get_status.return_value = {"has_source": True}
    mock_stt_api = MagicMock()
    mock_stt_api.audio_storage = mock_audio_storage

    with patch(
        "lct_python_backend.services.import_bulk_checkpoint_flow.compute_file_hash",
        return_value="hash-1",
    ), patch(
        "lct_python_backend.services.import_bulk_checkpoint_flow.find_checkpoint",
        new=AsyncMock(return_value=checkpoint),
    ), patch.dict(sys.modules, {"lct_python_backend.stt_api": mock_stt_api}):
        state = await bootstrap_audio_checkpoint_flow(
            db=db,
            temp_path="/tmp/x.wav",
            filename="x.wav",
            content_size=10,
            conversation_id="conv-1",
            is_likely_audio=True,
            stt_backend="local",
            stage_events=events,
            telemetry=telemetry,
            log=MagicMock(),
        )

    assert state.cache_hit is True
    assert any(call.args[0] == "status" for call in emit.await_args_list)


@pytest.mark.asyncio
async def test_persist_chunk_checkpoint_safe_noops_without_hash():
    db = AsyncMock()
    await persist_chunk_checkpoint_safe(
        db,
        file_hash=None,
        conversation_id="c",
        chunk_index=1,
        total_chunks=2,
        chunk_text="hi",
        accumulated_transcript="hi",
        stt_backend="local",
        elapsed_ms=1,
        file_name="f",
        file_size_bytes=1,
        log=MagicMock(),
    )
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_clear_import_checkpoint_safe_sets_telemetry():
    db = AsyncMock()
    telemetry: dict = {}
    with patch(
        "lct_python_backend.services.import_bulk_checkpoint_flow.clear_checkpoint",
        new=AsyncMock(),
    ):
        await clear_import_checkpoint_safe(db, "hash-1", telemetry, MagicMock())
    assert telemetry["checkpoint_cleared"] is True
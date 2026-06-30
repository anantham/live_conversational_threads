"""Tests for import_bulk_graph_pass."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lct_python_backend.services.import_pipeline.import_bulk_graph_pass import (
    ProgressiveChunkHandlers,
    should_use_segmented_processing,
)
from lct_python_backend.services.import_pipeline.import_bulk_helpers import SEGMENT_PROCESSING_THRESHOLD_BYTES
from lct_python_backend.services.import_pipeline.import_bulk_stage_events import ImportBulkStageEvents


def test_should_use_segmented_processing_skips_cloud_transport():
    assert should_use_segmented_processing(
        is_likely_audio=True,
        content_size=SEGMENT_PROCESSING_THRESHOLD_BYTES + 1,
        transcribe_audio_segmented=MagicMock(),
        primary_import_candidate={"transport": "openai_audio"},
    ) is False


def test_should_use_segmented_processing_allows_backend_http():
    assert should_use_segmented_processing(
        is_likely_audio=True,
        content_size=SEGMENT_PROCESSING_THRESHOLD_BYTES + 1,
        transcribe_audio_segmented=MagicMock(),
        primary_import_candidate={"transport": "backend_http"},
    ) is True


def test_should_use_segmented_processing_requires_audio():
    assert should_use_segmented_processing(
        is_likely_audio=False,
        content_size=SEGMENT_PROCESSING_THRESHOLD_BYTES + 1,
        transcribe_audio_segmented=MagicMock(),
        primary_import_candidate={"transport": "backend_http"},
    ) is False


@pytest.mark.asyncio
async def test_progressive_chunk_handlers_persist_checkpoint():
    emit = AsyncMock()
    telemetry: dict = {}
    events = ImportBulkStageEvents(emit=emit, pipeline_started_at=0.0, telemetry=telemetry)
    parts: list[str] = []
    processor = AsyncMock()
    handlers = ProgressiveChunkHandlers(
        stage_events=events,
        telemetry=telemetry,
        db=AsyncMock(),
        file_hash="hash-1",
        conversation_id="conv-1",
        filename="clip.wav",
        content_size=100,
        checkpoint_transcript_parts=parts,
        progressive_processor_ref=[processor],
        transcription_started_at=0.0,
        log=MagicMock(),
    )

    with patch(
        "lct_python_backend.services.import_pipeline.import_bulk_graph_pass.persist_chunk_checkpoint_safe",
        new=AsyncMock(),
    ) as persist_mock:
        await handlers.on_chunk_progress(1, 2, "hello world")

    assert parts == ["hello world"]
    assert telemetry["checkpoint_chunks"] == 1
    persist_mock.assert_awaited_once()
    processor.handle_final_text.assert_not_awaited()

    await handlers.on_chunk_progress(2, 2, "x" * 500)
    processor.handle_final_text.assert_awaited()
"""Skeleton tests for ConversationPipeline (ADR-030 §D3 PR-A).

Verifies:
  - Package imports cleanly (no DATABASE_URL required).
  - Stage protocol contract is checkable at runtime.
  - Orchestrator emits StageStarted / StageCompleted around a stage.
  - Orchestrator converts exceptions to StageFailed.
  - IngestStage classifies sources and emits the typed events.
  - PipelineState defaults are sensible.

These tests intentionally avoid the rest of the backend (no DB, no
LLM, no STT). They exist to prove the package skeleton works in
isolation so PR-B can build on it confidently.
"""

from __future__ import annotations

import asyncio
import pytest

from lct_python_backend.services.conversation_pipeline import (
    ConversationPipeline,
    IngestCompleted,
    IngestStage,
    IngestStarted,
    PipelineEvent,
    PipelineState,
    Stage,
    StageCompleted,
    StageError,
    StageFailed,
    StageStarted,
)
from lct_python_backend.services.conversation_pipeline.stages.ingest import (
    AUDIO_SUFFIXES,
    _classify_path,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _RecordingStage:
    """Test stage that emits a custom event the orchestrator wraps."""

    name = "test_stage"

    def __init__(self, raise_exc=None, raise_stage_error=None):
        self._raise_exc = raise_exc
        self._raise_stage_error = raise_stage_error
        self.calls = 0

    async def run(self, state, emit):
        self.calls += 1
        if self._raise_stage_error is not None:
            raise self._raise_stage_error
        if self._raise_exc is not None:
            raise self._raise_exc


def _make_event_collector():
    """Returns (emit_fn, events list) where events list grows on each emit."""
    events: list = []

    async def emit(event: PipelineEvent) -> None:
        events.append(event)

    return emit, events


# ---------------------------------------------------------------------------
# Stage protocol
# ---------------------------------------------------------------------------


def test_stage_protocol_recognises_compliant_classes():
    assert isinstance(IngestStage(), Stage)
    assert isinstance(_RecordingStage(), Stage)


def test_stage_protocol_rejects_non_compliant_classes():
    class NotAStage:
        pass

    assert not isinstance(NotAStage(), Stage)


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def test_orchestrator_construction_with_stages_iterable():
    pipeline = ConversationPipeline([IngestStage()])
    assert len(pipeline.stages) == 1
    assert pipeline.stages[0].name == "ingest"


def test_orchestrator_add_stage_chains():
    pipeline = ConversationPipeline()
    pipeline.add_stage(IngestStage()).add_stage(_RecordingStage())
    assert [s.name for s in pipeline.stages] == ["ingest", "test_stage"]


def test_orchestrator_emits_started_and_completed_around_stage_run():
    pipeline = ConversationPipeline([_RecordingStage()])
    state = PipelineState(conversation_id="abc")
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(pipeline.run(state, emit))

    assert isinstance(events[0], StageStarted)
    assert events[0].stage == "test_stage"
    assert isinstance(events[-1], StageCompleted)
    assert events[-1].stage == "test_stage"
    assert events[-1].elapsed_ms >= 0.0


def test_orchestrator_converts_unhandled_exception_to_stage_failed_and_stops():
    boom = _RecordingStage(raise_exc=RuntimeError("kaboom"))
    after = _RecordingStage()
    pipeline = ConversationPipeline([boom, after])
    state = PipelineState(conversation_id="abc")
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(pipeline.run(state, emit))

    failed = [e for e in events if isinstance(e, StageFailed)]
    assert len(failed) == 1
    assert failed[0].stage == "test_stage"
    assert failed[0].code == "unhandled_exception"
    assert failed[0].next_action == "stop"
    assert after.calls == 0  # stopped before the second stage


def test_orchestrator_continues_when_stage_error_says_continue():
    keep_going = _RecordingStage(
        raise_stage_error=StageError(
            "soft fail",
            stage="test_stage",
            code="soft",
            recoverable=True,
            next_action="continue",
        )
    )
    after = _RecordingStage()
    pipeline = ConversationPipeline([keep_going, after])
    state = PipelineState(conversation_id="abc")
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(pipeline.run(state, emit))

    failed = [e for e in events if isinstance(e, StageFailed)]
    assert len(failed) == 1
    assert failed[0].next_action == "continue"
    assert after.calls == 1


# ---------------------------------------------------------------------------
# IngestStage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "filename,expected_kind",
    [
        ("recording.wav", "audio_file"),
        ("interview.mp3", "audio_file"),
        ("conversation.m4a", "audio_file"),
        ("transcript.txt", "text_file"),
        ("notes.md", "text_file"),
        ("doc.pdf", "text_file"),
        ("", "unknown"),
        ("video.gif", "unknown"),
    ],
)
def test_ingest_classify_path(filename, expected_kind):
    assert _classify_path(filename) == expected_kind


def test_ingest_audio_suffixes_match_existing_import_pipeline():
    # Mirrors the constant in services/import_bulk_pipeline.py:53.
    expected = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4"}
    assert AUDIO_SUFFIXES == expected


def test_ingest_stage_honours_explicit_live_audio_kind():
    stage = IngestStage()
    state = PipelineState(conversation_id="x", source_kind="live_audio")
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(stage.run(state, emit))

    assert state.source_kind == "live_audio"
    assert state.is_likely_audio is True
    assert isinstance(events[0], IngestStarted)
    assert isinstance(events[-1], IngestCompleted)
    assert events[-1].source_kind == "live_audio"
    assert events[-1].is_likely_audio is True


def test_ingest_stage_sniffs_file_extension_when_kind_unknown():
    stage = IngestStage()
    state = PipelineState(
        conversation_id="x",
        source_kind="unknown",
        source_metadata={"file_name": "talk.mp3", "file_size_bytes": 1024},
    )
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(stage.run(state, emit))

    assert state.source_kind == "audio_file"
    assert state.is_likely_audio is True
    started = [e for e in events if isinstance(e, IngestStarted)][0]
    assert started.source_size_bytes == 1024


def test_ingest_stage_classifies_text_file_as_not_audio():
    stage = IngestStage()
    state = PipelineState(
        conversation_id="x",
        source_metadata={"file_name": "transcript.txt"},
    )
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(stage.run(state, emit))

    assert state.source_kind == "text_file"
    assert state.is_likely_audio is False


# ---------------------------------------------------------------------------
# PipelineState defaults
# ---------------------------------------------------------------------------


def test_pipeline_state_default_construction():
    state = PipelineState()
    assert state.conversation_id == ""
    assert state.source_kind == "unknown"
    assert state.is_likely_audio is False
    assert state.hierarchy.unlocked_levels == [1]
    assert state.transcript_buffer.partial_chars == 0
    assert state.graph.nodes == []
    assert state.terminal.status is None


def test_pipeline_state_in_place_mutation_persists():
    state = PipelineState()
    state.transcript_buffer.partial_parts.append("hello")
    state.graph.nodes.append({"id": "n1"})
    state.hierarchy.unlocked_levels.append(2)

    assert state.transcript_buffer.partial_parts == ["hello"]
    assert state.graph.nodes == [{"id": "n1"}]
    assert state.hierarchy.unlocked_levels == [1, 2]


# ---------------------------------------------------------------------------
# End-to-end skeleton run
# ---------------------------------------------------------------------------


def test_pipeline_run_with_just_ingest_emits_expected_event_sequence():
    pipeline = ConversationPipeline([IngestStage()])
    state = PipelineState(
        conversation_id="conv-1",
        source_kind="live_audio",
    )
    emit, events = _make_event_collector()

    asyncio.get_event_loop().run_until_complete(pipeline.run(state, emit))

    types = [type(e).__name__ for e in events]
    # StageStarted from orchestrator, IngestStarted from stage,
    # IngestCompleted from stage, StageCompleted from orchestrator.
    assert types == [
        "StageStarted",
        "IngestStarted",
        "IngestCompleted",
        "StageCompleted",
    ]
    assert state.is_likely_audio is True

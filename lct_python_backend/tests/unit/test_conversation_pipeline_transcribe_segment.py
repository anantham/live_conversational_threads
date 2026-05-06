"""Tests for TranscribeStage and SegmentStage (ADR-030 §D3 PR-B).

These tests prove the contract is correct. They do not yet exercise
either stage from a transport — that wiring lands in PR-C/D when the
existing transports are carved over to call ``note_partial`` /
``note_final`` instead of mutating ``WsSessionContext`` fields inline.
"""

from __future__ import annotations

import asyncio

import pytest

from lct_python_backend.services.conversation_pipeline import (
    ConversationPipeline,
    PipelineState,
    SegmentStage,
    StageCompleted,
    StageStarted,
    TranscribeStage,
    TranscriptFinal,
    TranscriptPartial,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_event_collector():
    events = []

    async def emit(evt):
        events.append(evt)

    return emit, events


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# TranscribeStage — partial flow
# ---------------------------------------------------------------------------


def test_note_partial_appends_to_buffer_and_emits_event():
    stage = TranscribeStage()
    state = PipelineState(conversation_id="x")
    emit, events = _make_event_collector()

    _run(
        stage.note_partial(
            state,
            emit,
            "hello world",
            timestamp_start=0.0,
            timestamp_end=1.5,
        )
    )

    assert state.transcript_buffer.partial_parts == ["hello world"]
    assert state.transcript_buffer.partial_chars == len("hello world")
    assert state.transcript_buffer.partial_timestamp_start == 0.0
    assert state.transcript_buffer.partial_timestamp_end == 1.5
    assert len(events) == 1
    assert isinstance(events[0], TranscriptPartial)
    assert events[0].text == "hello world"


def test_note_partial_ignores_empty_text():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.note_partial(state, emit, ""))
    _run(stage.note_partial(state, emit, "   "))

    assert state.transcript_buffer.partial_parts == []
    assert events == []


def test_note_partial_widens_timestamp_bounds_across_calls():
    stage = TranscribeStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(stage.note_partial(state, emit, "first", timestamp_start=2.0, timestamp_end=3.0))
    _run(stage.note_partial(state, emit, "second", timestamp_start=1.0, timestamp_end=4.0))

    assert state.transcript_buffer.partial_timestamp_start == 1.0
    assert state.transcript_buffer.partial_timestamp_end == 4.0


def test_note_partial_records_first_partial_telemetry_milestone():
    stage = TranscribeStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    assert state.telemetry.first_partial_at_ms is None
    _run(stage.note_partial(state, emit, "hi"))
    first = state.telemetry.first_partial_at_ms
    assert first is not None
    # Subsequent partials must NOT clobber the first-partial milestone.
    _run(stage.note_partial(state, emit, "hi again"))
    assert state.telemetry.first_partial_at_ms == first


def test_note_partial_collects_speaker_segments():
    stage = TranscribeStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(
        stage.note_partial(
            state,
            emit,
            "hello",
            speaker_segments=[
                {"speaker_id": "S0", "start": 0.0, "end": 0.5},
                {"speaker_id": "S0", "start": 0.6, "end": 1.0},
            ],
        )
    )

    assert len(state.transcript_buffer.pending_speaker_segments) == 2


# ---------------------------------------------------------------------------
# TranscribeStage — final flow
# ---------------------------------------------------------------------------


def test_note_final_drains_buffer_and_appends_to_final_text_parts():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.note_partial(state, emit, "hello", timestamp_start=0.0, timestamp_end=1.0))
    _run(stage.note_partial(state, emit, "world", timestamp_start=1.0, timestamp_end=2.0))
    _run(stage.note_final(state, emit, "hello world", timestamp_start=0.0, timestamp_end=2.0))

    assert state.transcript_buffer.partial_parts == []
    assert state.transcript_buffer.partial_chars == 0
    assert state.transcript_buffer.partial_timestamp_start is None
    assert state.transcript_buffer.partial_timestamp_end is None
    assert state.final_text_parts == ["hello world"]
    assert state.full_transcript_text == "hello world"

    finals = [e for e in events if isinstance(e, TranscriptFinal)]
    assert len(finals) == 1
    assert finals[0].text == "hello world"


def test_note_final_concatenates_full_transcript_text_across_finals():
    stage = TranscribeStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(stage.note_final(state, emit, "first sentence."))
    _run(stage.note_final(state, emit, "second sentence."))

    assert state.final_text_parts == ["first sentence.", "second sentence."]
    assert state.full_transcript_text == "first sentence. second sentence."


def test_note_final_with_empty_text_resets_buffer_without_emitting():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.note_partial(state, emit, "buffer this"))
    _run(stage.note_final(state, emit, ""))

    assert state.transcript_buffer.partial_parts == []
    finals = [e for e in events if isinstance(e, TranscriptFinal)]
    assert finals == []


def test_note_final_inherits_partial_timestamp_when_not_provided():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.note_partial(state, emit, "buffered", timestamp_start=10.0, timestamp_end=11.0))
    _run(stage.note_final(state, emit, "buffered final"))

    finals = [e for e in events if isinstance(e, TranscriptFinal)]
    assert finals[0].timestamp_start == 10.0
    assert finals[0].timestamp_end == 11.0


def test_note_final_records_first_final_telemetry_milestone():
    stage = TranscribeStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    assert state.telemetry.first_final_at_ms is None
    _run(stage.note_final(state, emit, "first."))
    first = state.telemetry.first_final_at_ms
    assert first is not None
    _run(stage.note_final(state, emit, "second."))
    assert state.telemetry.first_final_at_ms == first  # not clobbered


# ---------------------------------------------------------------------------
# TranscribeStage — sequential run() mode
# ---------------------------------------------------------------------------


def test_run_drains_buffered_partials_into_a_single_final():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.note_partial(state, emit, "alpha", timestamp_start=0.0, timestamp_end=1.0))
    _run(stage.note_partial(state, emit, "beta", timestamp_start=1.0, timestamp_end=2.0))
    _run(stage.run(state, emit))

    assert state.transcript_buffer.partial_parts == []
    assert state.full_transcript_text == "alpha beta"
    finals = [e for e in events if isinstance(e, TranscriptFinal)]
    assert len(finals) == 1
    assert finals[0].text == "alpha beta"


def test_run_is_a_no_op_when_buffer_is_empty():
    stage = TranscribeStage()
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert events == []
    assert state.full_transcript_text == ""


# ---------------------------------------------------------------------------
# SegmentStage
# ---------------------------------------------------------------------------


def test_segment_stage_produces_chunks_from_full_transcript_text():
    stage = SegmentStage(max_chars=50)
    state = PipelineState(
        full_transcript_text=(
            "First sentence here.\n"
            "Second sentence here too.\n"
            "Third one is also here in the conversation."
        ),
    )
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    chunks = state.source_metadata.get("transcript_chunks", [])
    assert len(chunks) >= 1
    assert state.source_metadata.get("transcript_chunk_count") == len(chunks)


def test_segment_stage_is_a_no_op_when_transcript_empty():
    stage = SegmentStage()
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert "transcript_chunks" not in state.source_metadata


def test_segment_stage_respects_max_chars():
    stage = SegmentStage(max_chars=20)
    state = PipelineState(full_transcript_text="aaa\nbbb\nccc\nddd\neee")
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    chunks = state.source_metadata["transcript_chunks"]
    for chunk in chunks:
        # Allow exact-fit; only enforce the soft cap (next-line addition broke it).
        assert len(chunk) <= 20 + 1


# ---------------------------------------------------------------------------
# Full pipeline composition
# ---------------------------------------------------------------------------


def test_pipeline_with_transcribe_then_segment_emits_all_lifecycle_events():
    pipeline = ConversationPipeline([TranscribeStage(), SegmentStage(max_chars=40)])
    state = PipelineState(conversation_id="conv-1")
    emit, events = _make_event_collector()

    # Pre-seed the buffer as a streaming transport would have done.
    state.transcript_buffer.partial_parts.extend(["first part", "second part"])
    state.transcript_buffer.partial_chars = len("first partsecond part")

    _run(pipeline.run(state, emit))

    types = [type(e).__name__ for e in events]
    # Expected: StageStarted(transcribe), TranscriptFinal,
    #           StageCompleted(transcribe), StageStarted(segment),
    #           StageCompleted(segment).
    assert types[0] == "StageStarted"
    assert "TranscriptFinal" in types
    assert types[-1] == "StageCompleted"
    # full_transcript_text was assembled
    assert state.full_transcript_text == "first part second part"
    # SegmentStage produced chunks
    assert "transcript_chunks" in state.source_metadata


def test_pipeline_segment_runs_even_with_empty_transcribe_buffer():
    """Pipeline composition is robust to empty preceding state."""
    pipeline = ConversationPipeline([TranscribeStage(), SegmentStage()])
    state = PipelineState(full_transcript_text="standalone text")
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    started_segments = [
        e for e in events if isinstance(e, StageStarted) and e.stage == "segment"
    ]
    assert len(started_segments) == 1
    assert "transcript_chunks" in state.source_metadata

"""Tests for AccumulateStage + GenerateGraphStage (ADR-030 §D3 PR-C).

These stages collaborate with a ``TranscriptProcessor``-shaped object.
Per the audit, the real processor is heavy (LLM clients, DB session
helpers); tests use a fake that records calls and exposes the same
``existing_json`` / ``chunk_dict`` surface.
"""

from __future__ import annotations

import asyncio

import pytest

from lct_python_backend.services.conversation_pipeline import (
    AccumulateStage,
    ConversationPipeline,
    GenerateGraphStage,
    NodeAdded,
    PipelineState,
    SegmentStage,
    StageFailed,
    TranscribeStage,
)


# ---------------------------------------------------------------------------
# Fake TranscriptProcessor
# ---------------------------------------------------------------------------


class _FakeProcessor:
    """Test double that records handle_final_text/flush calls.

    Mirrors the real TranscriptProcessor's public surface enough that
    AccumulateStage and GenerateGraphStage can run against it.
    """

    def __init__(self, *, on_handle=None, on_flush=None):
        self.existing_json = []
        self.chunk_dict = {}
        self.handle_calls = []  # list of (text, speaker_segments)
        self.flush_calls = 0
        self._on_handle = on_handle
        self._on_flush = on_flush

    async def handle_final_text(self, final_text, speaker_segments=None):
        self.handle_calls.append((final_text, list(speaker_segments or [])))
        if self._on_handle:
            self._on_handle(self, final_text, speaker_segments)

    async def flush(self):
        self.flush_calls += 1
        if self._on_flush:
            self._on_flush(self)


def _make_event_collector():
    events = []

    async def emit(evt):
        events.append(evt)

    return emit, events


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# AccumulateStage
# ---------------------------------------------------------------------------


def test_accumulate_feeds_each_chunk_into_processor():
    proc = _FakeProcessor()
    stage = AccumulateStage(proc)
    state = PipelineState(
        source_metadata={"transcript_chunks": ["chunk one", "chunk two", "chunk three"]},
    )
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert [text for text, _ in proc.handle_calls] == ["chunk one", "chunk two", "chunk three"]


def test_accumulate_skips_empty_chunks():
    proc = _FakeProcessor()
    stage = AccumulateStage(proc)
    state = PipelineState(
        source_metadata={"transcript_chunks": ["good", "", "  ", "also good"]},
    )
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert [text for text, _ in proc.handle_calls] == ["good", "also good"]


def test_accumulate_passes_speaker_segments_from_state():
    proc = _FakeProcessor()
    stage = AccumulateStage(proc)
    segments = [{"speaker_id": "A", "start": 0, "end": 1}]
    state = PipelineState(
        source_metadata={"transcript_chunks": ["hello"]},
        speaker_segments=list(segments),
    )
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert proc.handle_calls[0][1] == segments


def test_accumulate_mirrors_processor_state_to_pipeline_state():
    proc = _FakeProcessor()
    proc.existing_json = [{"id": "n1", "node_name": "First"}]
    proc.chunk_dict = {"c1": "chunk one text"}
    stage = AccumulateStage(proc)
    state = PipelineState(source_metadata={"transcript_chunks": ["any"]})
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.graph.nodes == [{"id": "n1", "node_name": "First"}]
    assert state.graph.chunks == {"c1": "chunk one text"}


def test_accumulate_emits_node_added_per_node():
    proc = _FakeProcessor()
    proc.existing_json = [
        {"id": "n1", "node_name": "First", "level": 1},
        {"id": "n2", "node_name": "Second", "semantic_level": 2},
    ]
    stage = AccumulateStage(proc)
    state = PipelineState(source_metadata={"transcript_chunks": ["x"]})
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    node_events = [e for e in events if isinstance(e, NodeAdded)]
    assert len(node_events) == 2
    assert node_events[0].node_id == "n1"
    assert node_events[0].semantic_level == 1
    assert node_events[1].semantic_level == 2


def test_accumulate_is_a_no_op_when_no_chunks():
    proc = _FakeProcessor()
    stage = AccumulateStage(proc)
    state = PipelineState()  # no source_metadata.transcript_chunks
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert proc.handle_calls == []
    assert state.graph.nodes == []


def test_accumulate_propagates_processor_failure_as_stage_failed():
    def boom(_proc, _text, _segs):
        raise RuntimeError("processor exploded")

    proc = _FakeProcessor(on_handle=boom)
    stage = AccumulateStage(proc)
    pipeline = ConversationPipeline([stage])
    state = PipelineState(source_metadata={"transcript_chunks": ["bad"]})
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    failures = [e for e in events if isinstance(e, StageFailed)]
    assert len(failures) == 1
    assert failures[0].code == "processor_handle_failed"
    assert failures[0].next_action == "stop"


# ---------------------------------------------------------------------------
# GenerateGraphStage
# ---------------------------------------------------------------------------


def test_generate_graph_calls_flush_and_mirrors_processor_output():
    proc = _FakeProcessor()
    proc.existing_json = [{"id": "n1", "node_name": "Out"}]
    proc.chunk_dict = {"c1": "src"}
    stage = GenerateGraphStage(proc)
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert proc.flush_calls == 1
    assert state.graph.nodes == [{"id": "n1", "node_name": "Out"}]
    assert state.graph.chunks == {"c1": "src"}
    assert state.graph_persist_requested is True


def test_generate_graph_records_first_graph_completed_milestone_once():
    proc = _FakeProcessor()
    stage = GenerateGraphStage(proc)
    state = PipelineState()
    emit, _events = _make_event_collector()

    assert state.telemetry.first_graph_completed_at_ms is None
    _run(stage.run(state, emit))
    first = state.telemetry.first_graph_completed_at_ms
    assert first is not None
    _run(stage.run(state, emit))
    assert state.telemetry.first_graph_completed_at_ms == first  # not clobbered


def test_generate_graph_emits_node_added_per_processor_node():
    proc = _FakeProcessor()
    proc.existing_json = [
        {"id": "n1", "node_name": "A"},
        {"id": "n2", "node_name": "B"},
        {"id": "n3", "node_name": "C", "__graphLayer": "draft"},
    ]
    stage = GenerateGraphStage(proc)
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    node_events = [e for e in events if isinstance(e, NodeAdded)]
    assert [e.node_id for e in node_events] == ["n1", "n2", "n3"]
    assert node_events[2].is_draft is True


def test_generate_graph_propagates_flush_failure_as_stage_failed():
    def boom(_proc):
        raise RuntimeError("flush exploded")

    proc = _FakeProcessor(on_flush=boom)
    stage = GenerateGraphStage(proc)
    pipeline = ConversationPipeline([stage])
    state = PipelineState()
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    failures = [e for e in events if isinstance(e, StageFailed)]
    assert len(failures) == 1
    assert failures[0].code == "processor_flush_failed"


# ---------------------------------------------------------------------------
# Composition: full transcribe → segment → accumulate → generate_graph
# ---------------------------------------------------------------------------


def test_full_pipeline_composition_drives_processor_and_persists_request():
    proc = _FakeProcessor()
    # Simulate what a real processor does: each handle_final_text adds a node.
    def add_node(p, text, _segs):
        p.existing_json.append({
            "id": f"n{len(p.existing_json) + 1}",
            "node_name": text[:20],
            "level": 1,
        })

    proc._on_handle = add_node

    pipeline = ConversationPipeline([
        TranscribeStage(),
        SegmentStage(max_chars=20),
        AccumulateStage(proc),
        GenerateGraphStage(proc),
    ])

    state = PipelineState(
        full_transcript_text="alpha beta gamma\ndelta epsilon zeta",
        conversation_id="conv-1",
    )
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    # Processor was driven
    assert proc.flush_calls == 1
    assert len(proc.handle_calls) >= 1
    # State carries final node list
    assert len(state.graph.nodes) >= 1
    assert state.graph_persist_requested is True
    # And NodeAdded events were emitted
    node_events = [e for e in events if isinstance(e, NodeAdded)]
    assert len(node_events) >= len(state.graph.nodes)

"""Tests for RefineStage + PersistStage (ADR-030 §D3 PR-D)."""

from __future__ import annotations

import asyncio

from lct_python_backend.services.conversation_pipeline import (
    ConversationPipeline,
    GraphPersisted,
    PersistStage,
    PipelineState,
    RefineStage,
    StageFailed,
)


def _make_event_collector():
    events = []

    async def emit(evt):
        events.append(evt)

    return emit, events


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# RefineStage
# ---------------------------------------------------------------------------


def test_refine_no_op_when_no_nodes():
    calls = []

    async def fake_refine(**kwargs):
        calls.append(kwargs)
        return {"applied": True, "nodes": [{"id": "ignored"}]}

    stage = RefineStage(refine_fn=fake_refine)
    state = PipelineState(full_transcript_text="anything")
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert calls == []
    assert state.graph.nodes == []


def test_refine_applies_when_helper_returns_applied_true():
    refined = [{"id": "r1", "node_name": "Refined"}]

    async def fake_refine(**kwargs):
        return {
            "applied": True,
            "nodes": refined,
            "original_node_count": 1,
            "refined_node_count": 1,
        }

    stage = RefineStage(refine_fn=fake_refine)
    state = PipelineState(
        full_transcript_text="hello world",
        utterances=[{"text": "hello", "speaker_id": "S0"}],
    )
    state.graph.nodes = [{"id": "n1", "node_name": "Original"}]
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.graph.nodes == refined
    summary = state.source_metadata.get("graph_refinement", {})
    assert summary.get("applied") is True
    assert "nodes" not in summary  # the full nodes payload is not echoed


def test_refine_skips_when_helper_returns_applied_false():
    async def fake_refine(**kwargs):
        return {"applied": False, "reason": "utterance_count_below_threshold"}

    stage = RefineStage(refine_fn=fake_refine)
    state = PipelineState()
    state.graph.nodes = [{"id": "n1"}]
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    # Original nodes preserved
    assert state.graph.nodes == [{"id": "n1"}]
    # Reason recorded
    assert state.source_metadata["graph_refinement"]["applied"] is False


def test_refine_failure_is_recoverable_and_continues():
    async def boom(**kwargs):
        raise RuntimeError("LLM unreachable")

    stage = RefineStage(refine_fn=boom)
    pipeline = ConversationPipeline([stage])
    state = PipelineState()
    state.graph.nodes = [{"id": "n1"}]
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    fails = [e for e in events if isinstance(e, StageFailed)]
    assert len(fails) == 1
    assert fails[0].code == "refine_call_failed"
    assert fails[0].next_action == "continue"


def test_refine_no_op_when_no_helper_available_and_none_injected():
    """Default-load path may return None in lean test environments;
    stage should silently skip rather than crash."""

    stage = RefineStage(refine_fn=None)
    state = PipelineState()
    state.graph.nodes = [{"id": "n1"}]
    emit, _events = _make_event_collector()

    # Just shouldn't raise; outcome depends on environment.
    _run(stage.run(state, emit))


# ---------------------------------------------------------------------------
# PersistStage
# ---------------------------------------------------------------------------


def test_persist_no_op_when_persist_not_requested():
    calls = []

    async def fake_persist(**kwargs):
        calls.append(kwargs)
        return 7

    stage = PersistStage(persist_fn=fake_persist)
    state = PipelineState(conversation_id="c1")
    state.graph.nodes = [{"id": "n1"}]
    state.graph_persist_requested = False
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert calls == []


def test_persist_no_op_when_no_nodes_clears_request_flag():
    async def fake_persist(**kwargs):
        return 0

    stage = PersistStage(persist_fn=fake_persist)
    state = PipelineState(conversation_id="c1", graph_persist_requested=True)
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.graph_persist_requested is False


def test_persist_calls_helper_with_canonical_args_and_emits_graph_persisted():
    captured = {}

    async def fake_persist(**kwargs):
        captured.update(kwargs)
        return len(kwargs["existing_json"])

    stage = PersistStage(persist_fn=fake_persist)
    state = PipelineState(
        conversation_id="c1",
        conversation_name="My Convo",
        graph_persist_requested=True,
        source_kind="audio_file",
    )
    state.graph.nodes = [{"id": "n1"}, {"id": "n2"}]
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert captured["conversation_id"] == "c1"
    assert captured["existing_json"] == [{"id": "n1"}, {"id": "n2"}]
    assert captured["source_type"] == "import_audio"
    assert captured["metadata"]["conversation_name"] == "My Convo"

    persisted = [e for e in events if isinstance(e, GraphPersisted)]
    assert len(persisted) == 1
    assert persisted[0].persisted_node_count == 2

    # Flag is cleared so subsequent invocations don't re-write.
    assert state.graph_persist_requested is False


def test_persist_missing_conversation_id_fails_stop():
    async def fake_persist(**_kwargs):
        return 0

    stage = PersistStage(persist_fn=fake_persist)
    pipeline = ConversationPipeline([stage])
    state = PipelineState(graph_persist_requested=True)
    state.graph.nodes = [{"id": "n1"}]
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    fails = [e for e in events if isinstance(e, StageFailed)]
    assert len(fails) == 1
    assert fails[0].code == "missing_conversation_id"
    assert fails[0].next_action == "stop"


def test_persist_helper_failure_is_recoverable():
    async def boom(**kwargs):
        raise RuntimeError("DB down")

    stage = PersistStage(persist_fn=boom)
    pipeline = ConversationPipeline([stage])
    state = PipelineState(conversation_id="c1", graph_persist_requested=True)
    state.graph.nodes = [{"id": "n1"}]
    emit, events = _make_event_collector()

    _run(pipeline.run(state, emit))

    fails = [e for e in events if isinstance(e, StageFailed)]
    assert len(fails) == 1
    assert fails[0].code == "persist_call_failed"
    assert fails[0].next_action == "continue"


def test_persist_source_type_mapping_for_each_source_kind():
    async def fake_persist(**kwargs):
        return 1

    stage = PersistStage(persist_fn=fake_persist)
    test_cases = [
        ("live_audio", "live_audio"),
        ("audio_file", "import_audio"),
        ("text_file", "import_text"),
        ("unknown", "import"),
    ]
    for src, expected in test_cases:
        captured = {}

        async def capture(**kwargs):
            captured.update(kwargs)
            return 1

        stage = PersistStage(persist_fn=capture)
        state = PipelineState(
            conversation_id="c1",
            graph_persist_requested=True,
            source_kind=src,
        )
        state.graph.nodes = [{"id": "n1"}]
        emit, _events = _make_event_collector()
        _run(stage.run(state, emit))
        assert captured["source_type"] == expected, f"src={src}"

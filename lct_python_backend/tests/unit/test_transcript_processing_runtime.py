import asyncio
import time

import pytest

from lct_python_backend.services.transcript import transcript_processing as mod
from lct_python_backend.services.transcript.transcript_processing import TranscriptProcessor


# DEFAULT_LLM_MODE defaults to "local", so _process_batch uses the boundary-index
# accumulate path (accumulate_text_json_local_indexed) rather than the echo
# dispatcher. These cadence/plumbing tests mock that path deterministically.
def _acc_idx_complete_all(numbered_input, **kwargs):
    return (
        {"decision": "stop_accumulating", "completed_through_index": 10**9, "detected_threads": []},
        "local_test",
    )


def _acc_idx_continue(numbered_input, **kwargs):
    return (
        {"decision": "continue_accumulating", "completed_through_index": -1, "detected_threads": []},
        "local_test",
    )


@pytest.mark.asyncio
async def test_early_graph_batches_stay_aggressive_before_returning_to_base_batch(monkeypatch):
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", _acc_idx_complete_all)
    updates = []
    statuses = []

    async def send_update(existing_json, chunk_dict):
        updates.append((list(existing_json), dict(chunk_dict)))

    async def send_status(level, message, context):
        statuses.append({"level": level, "message": message, "context": dict(context or {})})

    monkeypatch.setattr(
        mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": input_text,
                "Incomplete_segment": "",
                "decision": "stop_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )
    monkeypatch.setattr(
        mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: (
            [{"node_name": "node-1", "summary": mod_input[:20]}],
            "online_gemini-3-flash-preview",
        ),
    )

    processor = TranscriptProcessor(send_update=send_update, send_status=send_status, batch_size=4)

    await processor.handle_final_text("First finalized transcript chunk.")
    assert len(updates) == 1
    assert statuses[0]["context"]["batch_target"] == 1
    assert processor._current_batch_size == 1

    await processor.handle_final_text("Second finalized transcript chunk.")
    assert len(updates) == 2
    latest_queued_status = next(
        status
        for status in reversed(statuses)
        if status["context"].get("stage") == "graph"
        and status["context"].get("phase") == "queued"
    )
    assert latest_queued_status["context"]["batch_target"] == 1
    assert processor._current_batch_size == 2

    await processor.handle_final_text("Third finalized transcript chunk.")
    assert len(updates) == 2
    assert statuses[-1]["context"]["batch_target"] == 2

    await processor.handle_final_text("Fourth finalized transcript chunk.")
    assert len(updates) == 3
    assert processor._current_batch_size == 2


@pytest.mark.asyncio
async def test_graph_timer_forces_update_when_accumulator_keeps_accumulating(monkeypatch):
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", _acc_idx_continue)
    updates = []
    statuses = []

    async def send_update(existing_json, chunk_dict):
        updates.append((list(existing_json), dict(chunk_dict)))

    async def send_status(level, message, context):
        statuses.append({"level": level, "message": message, "context": dict(context or {})})

    monkeypatch.setattr(
        mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": "",
                "Incomplete_segment": input_text,
                "decision": "continue_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )
    monkeypatch.setattr(
        mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: (
            [{"node_name": "timer-node", "summary": mod_input[:20]}],
            "online_gemini-3-flash-preview",
        ),
    )

    processor = TranscriptProcessor(
        send_update=send_update,
        send_status=send_status,
        batch_size=4,
        graph_first_update_max_wait_ms=20,
        graph_steady_update_max_wait_ms=20,
        # The min-flush gate (default 80 chars, "don't LLM tiny fragments")
        # would defer the 33-char fixture with trigger=timer_deferred. This
        # test verifies the timer FORCES a flush while the accumulator keeps
        # accumulating — not the gate — so disable the gate.
        graph_min_flush_chars=0,
    )

    await processor.handle_final_text("First finalized transcript chunk.")
    assert updates == []

    await asyncio.sleep(0.08)

    assert len(updates) == 1
    completed_status = next(
        status
        for status in statuses
        if status["context"].get("stage") == "graph"
        and status["context"].get("phase") == "completed"
    )
    assert completed_status["context"]["trigger"] == "timer"
    assert completed_status["context"]["queue_wait_ms"] is not None
    assert completed_status["context"]["total_update_ms"] >= completed_status["context"]["generation_ms"]

    await processor.flush()


@pytest.mark.asyncio
async def test_graph_status_reports_queue_wait_and_total_update_metrics(monkeypatch):
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", _acc_idx_complete_all)
    updates = []
    statuses = []

    async def send_update(existing_json, chunk_dict):
        updates.append((list(existing_json), dict(chunk_dict)))

    async def send_status(level, message, context):
        statuses.append({"level": level, "message": message, "context": dict(context or {})})

    monkeypatch.setattr(
        mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": input_text,
                "Incomplete_segment": "",
                "decision": "stop_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )

    def slow_generate(mod_input, **kwargs):
        time.sleep(0.01)
        return ([{"node_name": "node-1", "summary": mod_input[:20]}], "online_gemini-3-flash-preview")

    monkeypatch.setattr(mod, "generate_lct_json", slow_generate)

    processor = TranscriptProcessor(send_update=send_update, send_status=send_status, batch_size=4)

    await processor.handle_final_text("A finalized transcript chunk.")

    assert len(updates) == 1
    completed_status = next(
        status
        for status in statuses
        if status["context"].get("stage") == "graph"
        and status["context"].get("phase") == "completed"
    )
    assert completed_status["context"]["trigger"] == "count_threshold"
    assert completed_status["context"]["queue_wait_ms"] is not None
    assert completed_status["context"]["generation_ms"] is not None
    assert completed_status["context"]["total_update_ms"] is not None
    assert completed_status["context"]["total_update_ms"] >= completed_status["context"]["generation_ms"]


@pytest.mark.asyncio
async def test_index_mode_splits_batch_at_completed_through_index(monkeypatch):
    # Local mode (the default) drives _process_batch through the boundary-index
    # accumulate path. With completed_through_index=1, fragments 0..1 complete
    # and 2..3 carry forward — proving the index split, not the echo length math.
    captured = {}

    def fake_idx(numbered_input, **kwargs):
        captured["numbered_input"] = numbered_input
        return (
            {"decision": "stop_accumulating", "completed_through_index": 1, "detected_threads": ["t"]},
            "local_test",
        )

    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", fake_idx)
    monkeypatch.setattr(
        mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: ([{"node_name": "n", "summary": mod_input[:10]}], "local_test"),
    )

    processor = TranscriptProcessor(send_update=None, send_status=None, batch_size=4)
    text_batch = ["frag zero text", "frag one text", "frag two text", "frag three text"]
    segment_batch = [[], [], [], []]
    graph_emitted, cont, incomplete_seg, carryover = await processor._process_batch(
        text_batch, segment_batch, stop_accumulating_flag=False, trigger="test"
    )

    # Input was numbered fragment-wise, not echoed.
    assert captured["numbered_input"].startswith("[0] frag zero text")
    assert "\n[1] frag one text" in captured["numbered_input"]
    # Completed through index 1; the tail (2..3) carries forward.
    assert graph_emitted is True
    assert incomplete_seg == "frag two text frag three text"
    assert cont is True  # leftover tail -> keep accumulating


@pytest.mark.asyncio
async def test_index_mode_continue_keeps_accumulating(monkeypatch):
    # completed_through_index = -1 means nothing complete: no graph, carry all.
    monkeypatch.setattr(mod, "accumulate_text_json_local_indexed", _acc_idx_continue)
    monkeypatch.setattr(
        mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: ([{"node_name": "n", "summary": mod_input[:10]}], "local_test"),
    )

    processor = TranscriptProcessor(send_update=None, send_status=None, batch_size=4)
    graph_emitted, cont, incomplete_seg, _carryover = await processor._process_batch(
        ["a fragment", "another fragment"], [[], []], stop_accumulating_flag=False, trigger="test"
    )
    assert graph_emitted is False
    assert cont is True
    assert incomplete_seg == "a fragment another fragment"

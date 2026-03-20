import asyncio
import time

import pytest

from lct_python_backend.services import transcript_processing as mod
from lct_python_backend.services.transcript_processing import TranscriptProcessor


@pytest.mark.asyncio
async def test_early_graph_batches_stay_aggressive_before_returning_to_base_batch(monkeypatch):
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

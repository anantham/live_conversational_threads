"""Commit-before-notify and startup replay contracts, before runtime wiring.

The journal double models a durable store boundary, not PostgreSQL. Actual DB
atomicity is tested separately in test_passage_journal_postgres.py.

Test intent: internal inference snapshots must reach the durable boundary but
must not be copied into the client graph notification.
"""
import asyncio
import copy
import json

import pytest

from lct_python_backend.services.transcript import transcript_processing as mod
from lct_python_backend.services.transcript.conversation_context import PassageContextPolicy
from lct_python_backend.services.transcript.passage_journal import build_record, restore_records


class Journal:
    def __init__(self):
        self.records = []

    @property
    def state(self):
        return restore_records(self.records)

    @property
    def sources(self):
        return {s["id"]: s for record in self.records for s in record["sources"]}

    async def recover(self):
        return self.state

    async def commit(self, patch):
        ids = [uid for batch in patch["utterance_chunk_map"].values() for uid in batch]
        assert len(ids) == 1
        seq = self.state["committed_through"] + 1
        source = {"id": ids[0], "sequence_number": seq, "text": next(iter(patch["chunks"].values())),
                  "speaker_id": "SPEAKER_00", "timestamp_start": None, "timestamp_end": None}
        record = build_record(len(self.records) + 1, seq - 1, [source], patch)
        self.records.append(record)
        return self.state


def make(journal, notify=None):
    return mod.TranscriptProcessor(
        send_update=notify, batch_size=1, initial_batch_size=1,
        graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
        llm_config={"mode": "local"}, providers=[],
        passage_context_policy=PassageContextPolicy(8000), passage_journal=journal,
    )


@pytest.mark.asyncio
async def test_notification_failure_after_commit_does_not_regenerate(monkeypatch):
    journal = Journal()
    requests = []
    def generate(prompt, **kwargs):
        requests.append(prompt)
        return ([{"node_name": "Open question", "semantic_level": 1,
                  "source_excerpt": json.loads(prompt)["current_passage"]}], "local_test")
    monkeypatch.setattr(mod, "generate_lct_json", generate)
    async def notify(*args, **kwargs):
        assert journal.state["revision"] == 1, "Save must precede notification"
        raise RuntimeError("Browser disconnected")
    processor = make(journal, notify)
    await processor.handle_final_text("What does consent mean?", utterance_id="u-1")
    assert processor.accumulator == []
    assert len(processor.existing_json) == 1
    await processor.flush()
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_new_processor_restores_committed_ids_and_ignores_redelivered_source(monkeypatch):
    journal = Journal()
    requests = []
    def generate(prompt, **kwargs):
        requests.append(json.loads(prompt))
        return ([{"node_name": "Moment", "semantic_level": 1}], "local_test")
    monkeypatch.setattr(mod, "generate_lct_json", generate)
    first = make(journal)
    await first.handle_final_text("An earlier question.", utterance_id="u-1")
    saved = copy.deepcopy(first.existing_json)
    restarted = make(journal)
    await restarted.handle_final_text("An earlier question.", utterance_id="u-1")
    assert len(requests) == 1
    assert restarted.existing_json == saved
    await restarted.handle_final_text("A later clarification.", utterance_id="u-2")
    assert requests[-1]["earlier_passages"][0]["text"] == "An earlier question."
    assert restarted.existing_json[0]["id"] == saved[0]["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
async def test_uncertain_commit_ack_recovers_before_inference_retry(monkeypatch, error_type):
    journal = Journal()
    durable_commit = journal.commit
    requests = []

    async def lost_ack(patch):
        await durable_commit(patch)
        raise error_type("Commit reached storage but acknowledgement was lost")

    journal.commit = lost_ack
    def generate(prompt, **kwargs):
        requests.append(prompt)
        return ([{"node_name": "Question", "semantic_level": 1}], "local_test")
    monkeypatch.setattr(mod, "generate_lct_json", generate)
    processor = make(journal)
    with pytest.raises(error_type):
        await processor.handle_final_text("Keep this exact source.", utterance_id="u-1")
    assert processor.existing_json == [], "Unacknowledged local state is rolled back"
    assert len(journal.records) == 1, "But the durable record exists"
    await processor.flush()
    assert len(requests) == 1
    assert len(processor.existing_json) == 1
    assert processor.accumulator == []


@pytest.mark.asyncio
async def test_cancelled_notification_does_not_uncommit_or_leave_pending_source(monkeypatch):
    journal = Journal()
    monkeypatch.setattr(mod, "generate_lct_json", lambda *a, **kw: (
        [{"node_name": "Question", "semantic_level": 1}], "local_test"))
    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError()
    processor = make(journal, cancelled)
    with pytest.raises(asyncio.CancelledError):
        await processor.handle_final_text("Saved before notification.", utterance_id="u-1")
    assert len(processor.existing_json) == 1
    assert processor.accumulator == []
    await processor.flush()
    assert len(journal.records) == 1


@pytest.mark.asyncio
async def test_inference_snapshot_is_internal_not_client_payload(monkeypatch):
    journal = Journal()
    async def capture(ids):
        return [{"id": ids[0], "sequence_number": 1, "text": "A source question.",
                 "speaker_id": "SPEAKER_00", "speaker_revision": 0,
                 "timestamp_start": None, "timestamp_end": None}]
    journal.capture_sources = capture
    monkeypatch.setattr(mod, "generate_lct_json", lambda *a, **kw: (
        [{"node_name": "Question", "semantic_level": 1}], "local_test"))
    processor = make(journal)
    notifications = []
    async def emit(*, patch):
        notifications.append(patch)
    processor._emit_graph_update = emit
    await processor.handle_final_text("A source question.", utterance_id="u-1")
    assert journal.records[0]["patch"]["inference_sources"][0]["id"] == "u-1"
    assert len(notifications) == 1
    assert notifications[0]["nodes"]
    assert notifications[0]["committed_revision"] == 1
    assert "inference_sources" not in notifications[0]
    assert "inference_context_revision" not in notifications[0]

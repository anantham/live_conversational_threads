"""Live interpretation uses persisted source as backlog, not a task per turn."""
import asyncio

import pytest

from lct_python_backend.services.transcript.passage_pump import PassagePump


@pytest.mark.asyncio
async def test_notifications_coalesce_while_model_is_slow_and_new_rows_are_not_lost():
    release = asyncio.Event()
    entered = asyncio.Event()
    rows = [{"id": "u1", "sequence_number": 1, "text": "first", "speaker_id": "S0"}]
    seen, reads = [], []
    class Processor:
        async def handle_final_text(self, text, **kwargs):
            entered.set()
            await release.wait()
            seen.append((text, kwargs["utterance_id"]))
        async def flush(self):
            pass
    async def read(after, limit):
        reads.append((after, limit))
        return [row for row in rows if row["sequence_number"] > after][:limit]
    pump = PassagePump(processor=Processor(), read_page=read, committed_sequence=0, page_size=2)
    task = pump.notify()
    await entered.wait()
    rows.extend({"id": f"u{i}", "sequence_number": i, "text": str(i), "speaker_id": "S0"} for i in range(2, 10))
    assert all(pump.notify() is task for _ in range(100))
    release.set()
    await pump.drain()
    assert [identity for _, identity in seen] == [f"u{i}" for i in range(1, 10)]
    assert all(limit == 2 for _, limit in reads)


@pytest.mark.asyncio
async def test_failure_is_visible_and_not_misreported_as_drain_completion():
    class Processor:
        async def handle_final_text(self, *args, **kwargs):
            raise ValueError("synthetic model failure")
        async def flush(self):
            pass
    async def read(after, limit):
        return [{"id": "u1", "sequence_number": 1, "text": "saved speech"}] if after == 0 else []
    pump = PassagePump(processor=Processor(), read_page=read, committed_sequence=0)
    pump.notify()
    with pytest.raises(ValueError, match="synthetic"):
        await pump.drain()
    assert pump.admitted_sequence == 0
    with pytest.raises(ValueError, match="synthetic"):
        pump.notify()


@pytest.mark.asyncio
async def test_cancellation_does_not_advance_durable_cursor_and_fresh_pump_replays():
    entered = asyncio.Event()
    rows = [{"id": "saved", "sequence_number": 1, "text": "saved"}]
    seen = []
    class Slow:
        async def handle_final_text(self, *args, **kwargs):
            entered.set()
            await asyncio.Event().wait()
        async def flush(self):
            pass
    class Fast:
        async def handle_final_text(self, text, **kwargs):
            seen.append(kwargs["utterance_id"])
        async def flush(self):
            pass
    async def read(after, limit):
        return rows if after == 0 else []
    pump = PassagePump(processor=Slow(), read_page=read, committed_sequence=0)
    pump.notify()
    await entered.wait()
    await pump.close()
    replacement = PassagePump(processor=Fast(), read_page=read, committed_sequence=0)
    replacement.notify()
    await replacement.drain()
    assert seen == ["saved"]

"""One coalescing worker over persisted source, with no in-memory text queue.

The admitted cursor is ephemeral, NOT a commit receipt. Construct a new pump
and processor from the journal's committed cursor after cancellation/failure.
Failures remain visible; notifying again does not silently skip failed speech.
"""
import asyncio


class PassagePump:
    def __init__(self, *, processor, read_page, committed_sequence, page_size=32, processor_lock=None):
        if type(page_size) is not int or not 0 < page_size <= 256:
            raise ValueError("Invalid source page size")
        self.processor = processor
        self._read_page = read_page
        self.admitted_sequence = committed_sequence
        self._page_size = page_size
        self._task = None
        self._dirty = False
        self._closed = False
        self._failure = None
        self._processor_lock = processor_lock

    async def _call_processor(self, method, *args, **kwargs):
        if self._processor_lock is None:
            return await method(*args, **kwargs)
        async with self._processor_lock:
            return await method(*args, **kwargs)

    def notify(self):
        """Call after source commit. Returns immediately with one shared task."""
        if self._closed:
            raise RuntimeError("Passage worker is closed")
        if self._failure is not None:
            raise self._failure
        self._dirty = True
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
            # Observe fire-and-forget exceptions while retaining the failure for
            # drain()/notify(). No transcript or provider exception is logged.
            self._task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        return self._task

    async def _run(self):
        try:
            while self._dirty:
                self._dirty = False
                while True:
                    rows = await self._read_page(self.admitted_sequence, self._page_size)
                    if not rows:
                        break
                    sequences = [row["sequence_number"] for row in rows]
                    identities = [row["id"] for row in rows]
                    if (len(rows) > self._page_size or sequences != sorted(set(sequences))
                            or sequences[0] <= self.admitted_sequence
                            or len(identities) != len(set(identities)) or not all(identities)):
                        raise ValueError("Invalid ordered persisted-source page")
                    for row in rows:
                        await self._call_processor(self.processor.handle_final_text,
                            row["text"], utterance_id=row["id"],
                            speaker_segments=[{"speaker": row.get("speaker_id"), "text": row["text"]}],
                        )
                        self.admitted_sequence = row["sequence_number"]
                await self._call_processor(self.processor.flush)
        except BaseException as exc:
            self._failure = exc
            raise

    async def drain(self):
        if self._task is not None:
            await asyncio.shield(self._task)
        if self._failure is not None:
            raise self._failure

    async def close(self):
        self._closed = True
        if self._task is not None and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)


async def read_owned_source_page(session_factory, *, conversation_id, owner_id, after_sequence, limit):
    """Release the read transaction before any slow inference begins."""
    import uuid
    from sqlalchemy import select
    from lct_python_backend.models import Utterance
    from .passage_journal import _authorized_conversation, _source

    if type(limit) is not int or not 0 < limit <= 256:
        raise ValueError("Invalid source page limit")
    async with session_factory() as db:
        await _authorized_conversation(db, conversation_id, owner_id, lock=False)
        rows = (await db.execute(select(Utterance).where(
            Utterance.conversation_id == uuid.UUID(conversation_id),
            Utterance.sequence_number > after_sequence,
        ).order_by(Utterance.sequence_number).limit(limit))).scalars().all()
        return [_source(row) for row in rows]

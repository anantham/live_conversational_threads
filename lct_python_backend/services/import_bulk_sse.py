"""SSE helpers for import bulk-processing pipelines."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any, AsyncIterator, Awaitable


def sse_encode(event: str, payload: dict[str, Any]) -> str:
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


async def stream_event_queue(
    *,
    event_queue: "asyncio.Queue[tuple[str, dict[str, Any]] | None]",
    worker_coro: Awaitable[None],
) -> AsyncIterator[str]:
    """Yield SSE-encoded events from queue while a worker coroutine runs."""
    worker_task = asyncio.create_task(worker_coro)
    try:
        while True:
            item = await event_queue.get()
            if item is None:
                break
            event_type, payload = item
            yield sse_encode(event_type, payload)
    finally:
        if not worker_task.done():
            worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker_task

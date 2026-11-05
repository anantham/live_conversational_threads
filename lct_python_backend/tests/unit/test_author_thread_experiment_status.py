"""Test intent: the CLI wrapper returns successful extraction, propagates
failure, and cancels provider work when its own wait is cancelled.
"""

import asyncio

import pytest

from scripts.author_thread_experiment import run_with_status


@pytest.mark.asyncio
async def test_run_with_status_returns_success(capsys):
    async def operation():
        return {"argument_topology": {"status": "complete", "semantic_edge_count": 1}}

    result = await run_with_status(operation())

    assert result["argument_topology"]["status"] == "complete"
    messages = capsys.readouterr().err
    assert "Preparing graph and extracting relationships" in messages
    assert "Relationship extraction completed; elapsed " in messages


@pytest.mark.asyncio
async def test_run_with_status_propagates_failure(capsys):
    async def operation():
        raise ValueError("synthetic extraction failure")

    with pytest.raises(ValueError, match="synthetic extraction failure"):
        await run_with_status(operation())

    messages = capsys.readouterr().err
    assert "Preparing graph and extracting relationships" in messages
    assert "Relationship extraction failed; elapsed " in messages


@pytest.mark.asyncio
async def test_run_with_status_cancels_inner_work_on_cancellation(capsys):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def operation():
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    wrapper = asyncio.create_task(run_with_status(operation()))
    await asyncio.wait_for(started.wait(), timeout=2)
    wrapper.cancel()

    with pytest.raises(asyncio.CancelledError):
        await wrapper

    assert cancelled.is_set()
    assert "Relationship extraction cancelled; elapsed " in capsys.readouterr().err

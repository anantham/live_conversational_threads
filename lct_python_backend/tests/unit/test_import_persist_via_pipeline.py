"""ADR-059 PR-1 — the import persist phase now routes the graph write through the
ConversationPipeline spine (PersistStage). These tests pin the behavior-preserving
contract of that first production wiring: the canonical persist_graph is still
called, on the same request db, with utterances + the raw source_type, and the
empty-graph + failure edge cases behave exactly as before.
"""

from __future__ import annotations

import asyncio

import pytest

from lct_python_backend.services.import_pipeline import import_bulk_graph_pass as gpass
from lct_python_backend.services.import_pipeline import import_bulk_persistence as ibp


def _spy_persist(monkeypatch):
    calls: list[dict] = []

    async def fake_persist(**kwargs):
        calls.append(kwargs)
        return len(kwargs.get("existing_json") or [])

    monkeypatch.setattr(ibp, "persist_import_graph", fake_persist)
    return calls


def test_nonempty_graph_routes_through_pipeline_preserving_persist_contract(monkeypatch):
    """A non-empty graph goes through PersistStage; the adapter still forwards to
    persist_graph on the SAME db with utterances + conversation_name + the RAW
    source_type ("audio", not the stage's "import_audio" remap)."""
    calls = _spy_persist(monkeypatch)
    nodes = [{"id": "n1"}, {"id": "n2"}]

    count = asyncio.run(
        ibp._persist_graph_via_pipeline(
            db="REQUEST_SESSION",
            conversation_id="conv-1",
            existing_json=nodes,
            utterances=[{"u": 1}],
            conversation_name="My Title",
            source_type="audio",
            source_metadata={"k": "v"},
        )
    )

    assert count == 2
    assert len(calls) == 1
    c = calls[0]
    assert c["db"] == "REQUEST_SESSION"        # same request transaction (not a 2nd session)
    assert c["conversation_id"] == "conv-1"
    assert c["existing_json"] == nodes
    assert c["utterances"] == [{"u": 1}]        # utterances preserved
    assert c["conversation_name"] == "My Title"
    assert c["source_type"] == "audio"          # RAW, not remapped to "import_audio"
    assert c["source_metadata"] == {"k": "v"}


def test_empty_graph_still_writes_utterances_directly(monkeypatch):
    """PersistStage early-returns on an empty graph and never calls persist_fn — but
    persist_graph still writes utterances on a 0-node import. The helper keeps a
    direct call for that edge case so the utterance write isn't dropped."""
    calls = _spy_persist(monkeypatch)

    count = asyncio.run(
        ibp._persist_graph_via_pipeline(
            db="DB",
            conversation_id="c",
            existing_json=[],
            utterances=[{"u": 1}],
            conversation_name="T",
            source_type="text",
            source_metadata={},
        )
    )

    assert count == 0
    assert len(calls) == 1                       # direct call happened (not skipped)
    assert calls[0]["existing_json"] == []
    assert calls[0]["utterances"] == [{"u": 1}]  # utterance write preserved


def test_persist_failure_preserves_original_exception(monkeypatch):
    """A persist failure re-raises the ORIGINAL persist_graph exception (type + message),
    NOT a generic RuntimeError re-messaged as "persist_live_graph_snapshot failed" — so the
    worker's telemetry['graph_persist_error'] stays identical to the prior direct call, and
    the failure is never swallowed into a silent success. (grok #138 finding #1.)"""

    class DBError(RuntimeError):
        pass

    async def boom(**_kwargs):
        raise DBError("db down")

    monkeypatch.setattr(ibp, "persist_import_graph", boom)

    with pytest.raises(DBError, match="db down"):
        asyncio.run(
            ibp._persist_graph_via_pipeline(
                db="DB",
                conversation_id="c",
                existing_json=[{"id": "n1"}],
                utterances=[],
                conversation_name="T",
                source_type="audio",
                source_metadata={},
            )
        )


# ---------------------------------------------------------------------------
# The import graph pass's final flush now routes through GenerateGraphStage.
# ---------------------------------------------------------------------------


class _FakeProc:
    def __init__(self, fail: bool = False):
        self.existing_json = [{"id": "n1", "node_name": "A"}]
        self.chunk_dict = {}
        self.flush_calls = 0
        self._fail = fail

    async def flush(self):
        self.flush_calls += 1
        if self._fail:
            raise RuntimeError("flush boom")


def test_flush_via_pipeline_calls_processor_flush():
    """The final graph flush still calls processor.flush() — routed through
    GenerateGraphStage rather than called directly."""
    proc = _FakeProc()
    asyncio.run(gpass._flush_via_pipeline(proc))
    assert proc.flush_calls == 1


def test_flush_via_pipeline_reraises_on_flush_failure():
    """A flush failure inside the stage is re-raised (not swallowed), so the import
    worker's existing error handling / SSE error path still fires — matching the
    prior bare `await processor.flush()`."""
    proc = _FakeProc(fail=True)
    with pytest.raises(Exception):
        asyncio.run(gpass._flush_via_pipeline(proc))
    assert proc.flush_calls == 1

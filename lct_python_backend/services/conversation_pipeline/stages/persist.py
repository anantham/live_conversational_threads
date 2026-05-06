"""Persist stage — write the canonical graph state to the database.

Calls ``services.graph_persistence.persist_live_graph_snapshot``, which
opens its own DB session via ``get_async_session_context``. Works for
both transports because the helper is mode-agnostic per ADR-030 §D3
(the persistence merge that produced ``graph_persistence.py``).

The stage is a no-op when ``state.graph_persist_requested`` is False,
so transports can include it unconditionally and let the pipeline
decide based on whether GenerateGraphStage flagged work to write.
Sets ``state.graph_persist_requested = False`` after a successful
write so subsequent invocations don't re-write the same snapshot
unnecessarily.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Optional

from ..events import GraphPersisted
from ..protocol import EmitFn, Stage, StageError
from ..state import PipelineState


# Persist function signature: takes conversation_id + nodes + metadata
# kwargs, returns the count of persisted nodes.
PersistFn = Callable[..., Awaitable[int]]


class PersistStage:
    """Commit ``state.graph.nodes`` to the canonical persistence layer."""

    name = "persist"

    def __init__(self, persist_fn: Optional[PersistFn] = None) -> None:
        self._persist_fn = persist_fn

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        if not state.graph_persist_requested:
            # Nothing fresh to persist; downstream stages can still run.
            return

        if not state.conversation_id:
            raise StageError(
                "PersistStage requires state.conversation_id",
                stage=self.name,
                code="missing_conversation_id",
                recoverable=False,
                next_action="stop",
            )

        nodes = list(state.graph.nodes or [])
        if not nodes:
            # Nothing to persist; clear the flag so next stage doesn't
            # think persistence is still pending.
            state.graph_persist_requested = False
            return

        persist_fn = self._persist_fn or _load_default_persist_fn()
        if persist_fn is None:
            raise StageError(
                "no persist function available",
                stage=self.name,
                code="persist_fn_missing",
                recoverable=False,
                next_action="stop",
            )

        metadata = dict(state.source_metadata or {})
        # Source name flows through into conversation_name on save.
        if state.conversation_name and "conversation_name" not in metadata:
            metadata["conversation_name"] = state.conversation_name

        started_at = time.perf_counter()
        try:
            persisted_count = await persist_fn(
                conversation_id=state.conversation_id,
                existing_json=nodes,
                metadata=metadata,
                source_type=_source_type_for(state),
            )
        except Exception as exc:  # noqa: BLE001
            raise StageError(
                f"persist_live_graph_snapshot failed: {exc}",
                stage=self.name,
                code="persist_call_failed",
                recoverable=True,
                next_action="continue",
            ) from exc

        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        state.graph_persist_requested = False

        await emit(
            GraphPersisted(
                stage=self.name,
                persisted_node_count=int(persisted_count or 0),
                elapsed_ms=elapsed_ms,
            )
        )


def _source_type_for(state: PipelineState) -> str:
    if state.source_kind == "live_audio":
        return "live_audio"
    if state.source_kind == "audio_file":
        return "import_audio"
    if state.source_kind == "text_file":
        return "import_text"
    return "import"


def _load_default_persist_fn() -> Optional[PersistFn]:
    """Best-effort lazy import of the canonical persist helper.

    DB-session import is gated on DATABASE_URL being set, so the import
    is deferred to call time per the same pattern as graph_persistence.
    """
    try:
        from lct_python_backend.services.graph_persistence import (
            persist_live_graph_snapshot,
        )
        return persist_live_graph_snapshot
    except Exception:  # noqa: BLE001
        return None


__all__ = ["PersistStage", "PersistFn"]

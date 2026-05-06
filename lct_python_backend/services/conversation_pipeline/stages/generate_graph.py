"""Generate-graph stage — flush the accumulator and finalise nodes.

Calls ``processor.flush()`` to drain anything still queued, then mirrors
the processor's ``existing_json`` and ``chunk_dict`` onto ``state.graph``.
Emits a ``NodeAdded`` per node so observers can stream the final shape.

Sets ``state.graph_persist_requested = True`` per ADR-030 §D8 so the
``persist`` stage (PR-D) knows there is fresh work to write. Marks
telemetry milestones for first-graph-completed.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Protocol

from ..events import NodeAdded
from ..protocol import EmitFn, Stage, StageError
from ..state import PipelineState


class _ProcessorLike(Protocol):
    async def flush(self) -> None: ...
    existing_json: List[Dict[str, Any]]
    chunk_dict: Dict[str, Any]


class GenerateGraphStage:
    """Flush the accumulator + materialise final graph state."""

    name = "generate_graph"

    def __init__(self, processor: _ProcessorLike) -> None:
        self._processor = processor

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        try:
            await self._processor.flush()
        except Exception as exc:  # noqa: BLE001
            raise StageError(
                f"processor.flush failed: {exc}",
                stage=self.name,
                code="processor_flush_failed",
                recoverable=False,
                next_action="stop",
            ) from exc

        nodes = list(getattr(self._processor, "existing_json", []) or [])
        chunks = dict(getattr(self._processor, "chunk_dict", {}) or {})
        state.graph.nodes = nodes
        state.graph.chunks = chunks
        state.graph_persist_requested = True

        # Telemetry milestones — only set if not already set, so they
        # remain "first time" markers across a multi-flush conversation.
        if state.telemetry.first_graph_completed_at_ms is None:
            state.telemetry.first_graph_completed_at_ms = time.perf_counter() * 1000.0

        for node in nodes:
            if not isinstance(node, dict):
                continue
            await emit(
                NodeAdded(
                    stage=self.name,
                    node_id=str(node.get("id") or node.get("node_id") or ""),
                    node_name=str(node.get("node_name") or ""),
                    semantic_level=int(node.get("semantic_level") or node.get("level") or 1),
                    is_draft=bool(node.get("__graphLayer") == "draft"),
                )
            )


__all__ = ["GenerateGraphStage"]

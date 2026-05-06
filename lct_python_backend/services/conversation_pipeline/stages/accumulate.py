"""Accumulate stage — feed transcript chunks into the LLM accumulator.

Per the audit (``docs/plans/pipeline-extract-state-audit.md`` §3),
``TranscriptProcessor`` is a shared collaborator: each pipeline instance
owns one. AccumulateStage takes a processor reference and feeds the
chunks produced by SegmentStage into ``processor.handle_final_text``
which queues them for batched LLM execution.

The processor's per-chunk speaker_segments parameter is sourced from
``state.speaker_segments`` if populated; otherwise empty. Live
transports that have produced finer-grained segments via
``TranscribeStage`` will have already pushed them onto the buffer; the
audit recommends future PR-D wires that flow.
"""

from __future__ import annotations

from typing import Any, List, Protocol

from ..events import NodeAdded
from ..protocol import EmitFn, Stage, StageError
from ..state import PipelineState


class _ProcessorLike(Protocol):
    """Subset of TranscriptProcessor surface this stage depends on.

    Defining a Protocol lets tests inject a fake processor without
    importing the heavy real implementation (which transitively pulls
    in LLM clients, DB session helpers, etc.).
    """

    async def handle_final_text(
        self,
        final_text: str,
        speaker_segments: list = ...,
    ) -> None: ...

    existing_json: List[dict]
    chunk_dict: dict


class AccumulateStage:
    """Feed ``state.source_metadata['transcript_chunks']`` into the
    transcript processor's batched accumulator.

    The stage does NOT flush; ``GenerateGraphStage`` is responsible for
    that. After accumulation the latest node list and chunk dict are
    mirrored onto ``state.graph`` so downstream stages and observers
    can read from a uniform location.
    """

    name = "accumulate"

    def __init__(self, processor: _ProcessorLike) -> None:
        self._processor = processor

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        chunks = state.source_metadata.get("transcript_chunks") or []
        if not isinstance(chunks, list) or not chunks:
            # No segmenting work was done — nothing to accumulate.
            # Downstream stages handle empty-graph gracefully.
            return

        speaker_segments = list(state.speaker_segments or [])

        for chunk in chunks:
            text = (chunk or "").strip()
            if not text:
                continue
            try:
                await self._processor.handle_final_text(text, speaker_segments=speaker_segments)
            except Exception as exc:  # noqa: BLE001
                raise StageError(
                    f"processor.handle_final_text failed: {exc}",
                    stage=self.name,
                    code="processor_handle_failed",
                    recoverable=False,
                    next_action="stop",
                ) from exc

        # Mirror processor state onto PipelineState so subsequent stages
        # read from one canonical place.
        state.graph.nodes = list(getattr(self._processor, "existing_json", []) or [])
        state.graph.chunks = dict(getattr(self._processor, "chunk_dict", {}) or {})

        # Emit a NodeAdded per node currently present, so observers can
        # rebuild the graph without rereading PipelineState directly.
        for node in state.graph.nodes:
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


__all__ = ["AccumulateStage"]

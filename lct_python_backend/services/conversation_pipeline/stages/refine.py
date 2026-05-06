"""Refine stage — second-pass graph refinement (currently import-only).

Wraps ``services.import_graph_refinement.refine_import_graph_nodes`` as
a stage. The underlying helper makes a second LLM call against the
finalised transcript and node set to densify subthreads / split
overlong nodes (see ADR-019). The stage is a no-op when refinement is
not eligible (short transcripts, low node count, etc. — the helper
itself decides via ``_should_refine``).

For the live path, refinement is currently performed via background
diarization rather than this LLM-based densification. Wiring the live
path to call this stage is a future concern; for PR-D the contract
is the same regardless of caller.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, Optional

from ..events import StageStarted  # noqa: F401
from ..protocol import EmitFn, Stage, StageError
from ..state import PipelineState


# Type alias: the refine helper's signature. Importing the real one
# eagerly would drag in google-genai at import time; PR-A established
# the pattern of lazy imports for heavy collaborators.
RefineFn = Callable[..., Awaitable[Dict[str, Any]]]


class RefineStage:
    """Optionally densify the graph via a second LLM pass."""

    name = "refine"

    def __init__(self, refine_fn: Optional[RefineFn] = None) -> None:
        self._refine_fn = refine_fn

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        # Lazy-import the canonical refine function unless the caller
        # injected one (tests inject a fake to avoid the LLM dep).
        refine_fn = self._refine_fn or _load_default_refine_fn()
        if refine_fn is None:
            # No refine function available — skip silently.
            return

        nodes = list(state.graph.nodes or [])
        if not nodes:
            return

        try:
            result = await refine_fn(
                transcript_text=state.full_transcript_text or "",
                utterances=list(state.utterances or []),
                existing_nodes=nodes,
                llm_config=state.llm.runtime_config or state.llm.base_config or None,
                providers=state.llm.runtime_providers or state.llm.base_providers or None,
            )
        except Exception as exc:  # noqa: BLE001
            raise StageError(
                f"refine_import_graph_nodes failed: {exc}",
                stage=self.name,
                code="refine_call_failed",
                recoverable=True,
                next_action="continue",
            ) from exc

        if not isinstance(result, dict):
            return

        applied = bool(result.get("applied"))
        refined_nodes = result.get("nodes")
        if applied and isinstance(refined_nodes, list):
            state.graph.nodes = list(refined_nodes)
            # Refinement output is a fresh canonical snapshot; the
            # persist stage downstream re-writes everything anyway.

        # Surface the refinement summary on metadata so observers can
        # log it without re-querying. Mirror the existing import worker
        # convention: nest under source_metadata.
        meta = dict(state.source_metadata)
        meta["graph_refinement"] = {
            k: v
            for k, v in result.items()
            # Don't echo the full nodes payload back through metadata —
            # that's already on state.graph.nodes.
            if k != "nodes"
        }
        state.source_metadata = meta


def _load_default_refine_fn() -> Optional[RefineFn]:
    """Best-effort lazy import of the canonical refine helper.

    Returns None if the helper or its dependencies aren't available so
    the stage can degrade gracefully in lean test environments.
    """
    try:
        from lct_python_backend.services.import_graph_refinement import (
            refine_import_graph_nodes,
        )
        return refine_import_graph_nodes
    except Exception:  # noqa: BLE001
        return None


__all__ = ["RefineStage", "RefineFn"]

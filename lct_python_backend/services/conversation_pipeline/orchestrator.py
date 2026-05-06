"""ConversationPipeline orchestrator — runs stages in order, emits events.

Per ADR-030 §D3, the orchestrator owns the canonical ``PipelineState``
and drives each registered ``Stage`` in turn. It catches exceptions per
stage, converts them to ``StageFailed`` events, and decides whether to
continue or abort based on the stage's ``next_action``.

The orchestrator is transport-agnostic: a transport supplies an ``emit``
async callback that receives every ``PipelineEvent`` the stages emit.
The transport translates events into its wire protocol (WebSocket
messages for live, SSE frames for import).
"""

from __future__ import annotations

import logging
import time
from typing import Iterable, List, Optional

from .events import (
    PipelineEvent,
    StageCompleted,
    StageFailed,
    StageStarted,
)
from .protocol import EmitFn, Stage, StageError
from .state import PipelineState

logger = logging.getLogger("lct_backend")


class ConversationPipeline:
    """Sequential pipeline runner.

    Construction:
        pipeline = ConversationPipeline([IngestStage(), ...])

    Invocation (transport-side):
        async def emit(event): await transport_send(event)
        await pipeline.run(state, emit)

    Stages run in declared order. Each emits at minimum a
    ``StageStarted`` and one terminal event (``StageCompleted`` or
    ``StageFailed``); the orchestrator wraps the stage call to ensure
    that contract holds even if the stage forgets.
    """

    def __init__(self, stages: Optional[Iterable[Stage]] = None) -> None:
        self._stages: List[Stage] = list(stages or [])

    def add_stage(self, stage: Stage) -> "ConversationPipeline":
        """Append a stage. Returns self for chaining."""
        self._stages.append(stage)
        return self

    @property
    def stages(self) -> List[Stage]:
        """Read-only view of registered stages."""
        return list(self._stages)

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        """Run every registered stage in order, mutating ``state`` in place
        and emitting events through ``emit``.

        On stage failure:
          - the orchestrator emits a ``StageFailed`` event
          - if the stage's ``next_action`` is ``"stop"`` (default for
            unhandled exceptions), the pipeline aborts
          - if it's ``"continue"``, the pipeline proceeds to the next stage
        """
        for stage in self._stages:
            should_continue = await self._run_stage(stage, state, emit)
            if not should_continue:
                logger.warning(
                    "[PIPELINE] aborting after stage=%s next_action=stop",
                    stage.name,
                )
                return

    async def _run_stage(
        self,
        stage: Stage,
        state: PipelineState,
        emit: EmitFn,
    ) -> bool:
        """Run one stage with start/complete/fail event wrapping.

        Returns True if the pipeline should continue past this stage.
        """
        started_at = time.perf_counter()
        await emit(StageStarted(stage=stage.name))
        try:
            await stage.run(state, emit)
        except StageError as exc:
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            logger.warning(
                "[PIPELINE] stage=%s failed code=%s recoverable=%s next_action=%s elapsed_ms=%.2f",
                stage.name,
                exc.code,
                exc.recoverable,
                exc.next_action,
                elapsed_ms,
            )
            await emit(
                StageFailed(
                    stage=stage.name,
                    code=exc.code,
                    detail=str(exc),
                    recoverable=exc.recoverable,
                    next_action=exc.next_action,
                )
            )
            return exc.next_action == "continue"
        except Exception as exc:  # noqa: BLE001 — orchestrator catches all
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            logger.exception(
                "[PIPELINE] stage=%s raised unhandled exception elapsed_ms=%.2f",
                stage.name,
                elapsed_ms,
            )
            await emit(
                StageFailed(
                    stage=stage.name,
                    code="unhandled_exception",
                    detail=f"{type(exc).__name__}: {exc}",
                    recoverable=False,
                    next_action="stop",
                )
            )
            return False

        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        await emit(
            StageCompleted(
                stage=stage.name,
                elapsed_ms=elapsed_ms,
            )
        )
        return True


__all__ = ["ConversationPipeline"]

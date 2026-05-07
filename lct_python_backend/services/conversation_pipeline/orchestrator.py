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
from typing import Awaitable, Callable, Iterable, List, Optional

from .events import (
    PipelineEvent,
    StageCompleted,
    StageFailed,
    StageStarted,
)
from .protocol import EmitFn, Stage, StageError
from .state import PipelineState

logger = logging.getLogger("lct_backend")


# Optional artifact-writer DI for test isolation. Same shape as
# UnlockHierarchyStage's writer hook.
ArtifactWriterFn = Callable[..., Awaitable[Optional[str]]]


def _load_default_artifact_writer() -> Optional[ArtifactWriterFn]:
    """Best-effort import of the canonical pipeline_artifacts writer.

    Returns None in lean test environments. Failure mode: the
    orchestrator silently skips persistence — observability is
    best-effort and never blocks pipeline flow per ADR-030 §P2.
    """
    try:
        from lct_python_backend.services.graph_persistence import (
            record_pipeline_artifact,
        )
        return record_pipeline_artifact
    except Exception:  # noqa: BLE001
        return None


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

    def __init__(
        self,
        stages: Optional[Iterable[Stage]] = None,
        *,
        artifact_writer: Optional[ArtifactWriterFn] = None,
    ) -> None:
        self._stages: List[Stage] = list(stages or [])
        self._artifact_writer = artifact_writer

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
            await self._record_stage_failure(
                state=state,
                stage=stage.name,
                code=exc.code,
                detail=str(exc),
                recoverable=exc.recoverable,
                next_action=exc.next_action,
                elapsed_ms=elapsed_ms,
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
            await self._record_stage_failure(
                state=state,
                stage=stage.name,
                code="unhandled_exception",
                detail=f"{type(exc).__name__}: {exc}",
                recoverable=False,
                next_action="stop",
                elapsed_ms=elapsed_ms,
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

    async def _record_stage_failure(
        self,
        *,
        state: PipelineState,
        stage: str,
        code: str,
        detail: str,
        recoverable: bool,
        next_action: str,
        elapsed_ms: float,
    ) -> None:
        """Persist a ``stage_failure`` artifact for post-hoc analysis.

        ADR-030 §D8 invariant: every stage failure is addressable in
        ``pipeline_artifacts``. Failure to write is silenced so the
        pipeline never blocks on observability — the ``StageFailed``
        event has already been emitted to the transport regardless.
        """
        if not state.conversation_id:
            return
        writer = self._artifact_writer or _load_default_artifact_writer()
        if writer is None:
            return
        try:
            await writer(
                conversation_id=state.conversation_id,
                stage=stage,
                artifact_type="stage_failure",
                artifact_metadata={
                    "code": code,
                    "detail": detail,
                    "recoverable": recoverable,
                    "next_action": next_action,
                    "elapsed_ms": elapsed_ms,
                },
            )
        except Exception:  # noqa: BLE001
            # Already logged by the writer; never block the pipeline.
            pass


__all__ = ["ConversationPipeline"]

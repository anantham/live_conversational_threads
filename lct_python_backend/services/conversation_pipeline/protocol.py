"""Stage protocol and typed-event base for ConversationPipeline.

Per ADR-030 §D3, the conversation pipeline is a sequence of stages that
each operate on a shared ``PipelineState`` and emit typed events. Stages
have stable names, input/output contracts, and emit ``stage_started`` /
``stage_completed`` / ``stage_failed`` regardless of what they internally
do.

The pipeline is transport-agnostic: ``LiveTransport`` (WebSocket) and
``ImportTransport`` (HTTP+SSE) both invoke the same stages with the same
state shape. See ``docs/plans/pipeline-extract-state-audit.md`` for the
state classification used to design this protocol.
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Awaitable, Callable, Protocol, runtime_checkable

from .events import PipelineEvent
from .state import PipelineState


# Type alias: stages emit events through a callback supplied by the orchestrator.
# Awaitable so emit can fan out over async transports without blocking the stage.
EmitFn = Callable[[PipelineEvent], Awaitable[None]]


@runtime_checkable
class Stage(Protocol):
    """A pipeline stage. Stages are single-responsibility units that
    transform ``PipelineState`` and announce progress through ``emit``.

    Implementations:
      - declare a stable ``name`` (used in events and observability)
      - implement ``run(state, emit)`` as an async coroutine
      - mutate ``state`` in place rather than returning a new state
        (the orchestrator owns the canonical state object)
      - emit at minimum a ``StageStarted`` and one of
        ``StageCompleted`` / ``StageFailed`` per invocation
    """

    name: str

    @abstractmethod
    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        ...


class StageError(Exception):
    """Raised by a stage when it cannot complete its work.

    The orchestrator catches this and converts it into a ``StageFailed``
    event with ``recoverable`` and ``next_action`` populated from the
    exception attributes per ADR-030 §D8 (failure visibility).
    """

    def __init__(
        self,
        message: str,
        *,
        stage: str,
        code: str = "stage_error",
        recoverable: bool = False,
        next_action: str = "stop",
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.recoverable = recoverable
        self.next_action = next_action

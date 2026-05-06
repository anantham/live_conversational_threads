"""ConversationPipeline package per ADR-030 §D3.

Public surface:

    from lct_python_backend.services.conversation_pipeline import (
        ConversationPipeline,
        PipelineState,
        IngestStage,
    )

The pipeline is transport-agnostic — both ``LiveTransport`` (WebSocket)
and ``ImportTransport`` (HTTP+SSE) construct the same set of stages and
invoke ``ConversationPipeline.run(state, emit)``. See the audit doc at
``docs/plans/pipeline-extract-state-audit.md`` for the state
classification that shaped this package.

Status (PR-A): package skeleton + ingest stage. Behaviour-neutral —
no transport calls into this package yet. Subsequent PRs land
transcribe / segment / accumulate / generate_graph / refine / persist /
unlock_hierarchy stages and rewire the transports.
"""

from .events import (
    GraphPersisted,
    IngestCompleted,
    IngestStarted,
    LevelUnlocked,
    NodeAdded,
    PipelineEvent,
    StageCompleted,
    StageFailed,
    StageStarted,
    TranscriptFinal,
    TranscriptPartial,
)
from .orchestrator import ConversationPipeline
from .protocol import EmitFn, Stage, StageError
from .stages import IngestStage, SegmentStage, TranscribeStage
from .state import (
    GraphState,
    HierarchyState,
    LlmRouting,
    PipelineState,
    PipelineTelemetry,
    RefinementWindow,
    SourceKind,
    TerminalState,
    TranscriptBuffer,
)

__all__ = [
    # Orchestrator
    "ConversationPipeline",
    # Protocol
    "EmitFn",
    "Stage",
    "StageError",
    # State
    "PipelineState",
    "LlmRouting",
    "TranscriptBuffer",
    "RefinementWindow",
    "GraphState",
    "HierarchyState",
    "PipelineTelemetry",
    "TerminalState",
    "SourceKind",
    # Events
    "PipelineEvent",
    "StageStarted",
    "StageCompleted",
    "StageFailed",
    "IngestStarted",
    "IngestCompleted",
    "TranscriptPartial",
    "TranscriptFinal",
    "NodeAdded",
    "GraphPersisted",
    "LevelUnlocked",
    # Stages
    "IngestStage",
    "SegmentStage",
    "TranscribeStage",
]

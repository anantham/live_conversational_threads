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

Status (post PR-E): all stages are implemented and tested in isolation.
The transports (``stt_ws_session.py`` for live, ``import_bulk_pipeline.py``
for import) do NOT yet call into this package — that wiring is a
follow-up sprint deliberately separated from the package construction
to keep transport-runtime risk reviewable on its own. See the audit
doc for the planned carve-out boundaries.
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
from .stages import (
    AccumulateStage,
    GenerateGraphStage,
    IngestStage,
    PersistStage,
    RefineStage,
    SegmentStage,
    TranscribeStage,
    UnlockHierarchyStage,
)
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
    "AccumulateStage",
    "GenerateGraphStage",
    "IngestStage",
    "PersistStage",
    "RefineStage",
    "SegmentStage",
    "TranscribeStage",
    "UnlockHierarchyStage",
]

"""PipelineState — the canonical data carrier across stages.

Per ADR-030 §D3, this dataclass holds the union of pipeline_state fields
identified in ``docs/plans/pipeline-extract-state-audit.md``: 33 fields
from the live audit + 19 from the import audit, deduped where the
classification overlapped.

State this dataclass does NOT carry (and never will) — see the audit doc
for the full list:
  - WebSocket / SSE transport mechanics (sockets, send queues)
  - asyncio task sets used for cancellation
  - request-scoped DB sessions
  - SSE telemetry dicts (live in the transport adapter)

Conventions:
  - Fields with sensible empty defaults are pre-populated; transports
    rarely need to construct a pristine state — they pass in an existing
    state when stages resume from a checkpoint.
  - Mutation happens in place. Stages read fields, append to lists, and
    set scalar fields. The orchestrator owns the canonical instance.
  - Treat this as a domain object. No transport, no DB session, no
    callback handles.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional


SourceKind = Literal["live_audio", "audio_file", "text_file", "unknown"]


@dataclass
class LlmRouting:
    """LLM config + provider list resolved for this conversation.

    Held here rather than as separate fields so transports can pass a
    single object at construction. BYOK overlays land in ``runtime_*``
    fields after resolution.
    """

    base_config: Dict[str, Any] = field(default_factory=dict)
    base_providers: List[Dict[str, Any]] = field(default_factory=list)
    runtime_config: Dict[str, Any] = field(default_factory=dict)
    runtime_providers: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class TranscriptBuffer:
    """In-flight transcript fragments before STT emits a final.

    Mirrors the live ``pending_partial_*`` state from
    ``WsSessionContext`` (lines 123-126).
    """

    partial_parts: List[str] = field(default_factory=list)
    partial_chars: int = 0
    partial_timestamp_start: Optional[float] = None
    partial_timestamp_end: Optional[float] = None
    pending_speaker_segments: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class RefinementWindow:
    """Background diarization buffer state (live path).

    Mirrors the ``_refinement_*`` group on ``WsSessionContext``
    (lines 135-140).
    """

    pcm_buffer: bytearray = field(default_factory=bytearray)
    text_parts: List[str] = field(default_factory=list)
    sample_rate_hz: int = 16000
    window_start: Optional[float] = None
    window_end: Optional[float] = None
    source_utterance_ids: set = field(default_factory=set)


@dataclass
class GraphState:
    """Canonical graph snapshot the pipeline is producing.

    The shape mirrors what ``TranscriptProcessor`` already exposes via
    ``existing_json`` and ``chunk_dict`` so the migration in PR-C can
    be a straight handoff.
    """

    nodes: List[Dict[str, Any]] = field(default_factory=list)
    chunks: Dict[str, Any] = field(default_factory=dict)
    active_draft: Optional[Dict[str, Any]] = None
    pending_draft_replacements: List[Dict[str, Any]] = field(default_factory=list)
    pending_speaker_reconciliations: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class HierarchyState:
    """Emergent-depth hierarchy bookkeeping per ADR-030 §P4.

    ``unlocked_levels`` starts as ``[1]`` (chunks always present) and
    grows monotonically as the LLM-judge approves higher tiers. Bucket
    index lets the unlock evaluator skip re-asking the judge until the
    count crosses the next threshold (5, 7, 10, 15, 25, 40, 60, 100).
    """

    unlocked_levels: List[int] = field(default_factory=lambda: [1])
    last_evaluated_bucket: Dict[int, int] = field(default_factory=dict)


@dataclass
class PipelineTelemetry:
    """Domain-side telemetry counters tied to the audio + graph.

    Distinct from the SSE/WebSocket telemetry dicts that live in the
    transport adapters — those carry transport timing (HTTP roundtrips,
    SSE backpressure). This carries pipeline-domain milestones.
    """

    audio_send_started_at_ms: Optional[float] = None
    first_partial_at_ms: Optional[float] = None
    first_final_at_ms: Optional[float] = None
    first_graph_queued_at_ms: Optional[float] = None
    first_graph_completed_at_ms: Optional[float] = None
    first_audio_chunk_logged: bool = False


@dataclass
class TerminalState:
    """Conversation-level terminal classification.

    Captured at session end so observability tooling can attribute
    sessions to ``completed | failed | abandoned``. Mirrors
    ``session_terminal_*`` in ``WsSessionContext`` (lines 159-160).
    """

    status: Optional[Literal["completed", "failed", "abandoned"]] = None
    reason: Optional[str] = None
    started_committed: bool = False
    flush_requested: bool = False
    flush_complete_sent: bool = False


@dataclass
class PipelineState:
    """Canonical state carrier across pipeline stages.

    Each stage reads the fields it needs and mutates the fields it owns.
    The orchestrator owns the only canonical instance and threads it into
    each stage's ``run(state, emit)`` call.

    This object is NEVER serialized to the database. Persistence of the
    domain state happens through dedicated stages (``persist``) that read
    from PipelineState and write to canonical tables via
    ``services.graph_persistence``.
    """

    # Core conversation identity
    conversation_id: str = ""
    session_id: Optional[str] = None
    speaker_id: str = "SPEAKER_00"
    conversation_name: Optional[str] = None
    source_kind: SourceKind = "unknown"
    is_likely_audio: bool = False
    source_metadata: Dict[str, Any] = field(default_factory=dict)

    # LLM routing (carries BYOK overlay)
    llm: LlmRouting = field(default_factory=LlmRouting)

    # Transcript assembly
    transcript_buffer: TranscriptBuffer = field(default_factory=TranscriptBuffer)
    final_text_parts: List[str] = field(default_factory=list)
    full_transcript_text: str = ""
    utterances: List[Dict[str, Any]] = field(default_factory=list)
    speaker_segments: List[Dict[str, Any]] = field(default_factory=list)

    # Refinement (background diarization, live path only)
    refinement: RefinementWindow = field(default_factory=RefinementWindow)
    refinement_candidate: Optional[Dict[str, Any]] = None

    # STT runtime handle (held by reference; pipeline does not own its lifecycle)
    stt_runtime: Optional[Any] = None

    # Graph state
    graph: GraphState = field(default_factory=GraphState)
    hierarchy: HierarchyState = field(default_factory=HierarchyState)

    # Persistence signalling
    graph_persist_requested: bool = False

    # Resume-from-checkpoint state (import path)
    resume_from_chunk: Optional[int] = None
    file_hash: Optional[str] = None

    # Telemetry + terminal classification
    telemetry: PipelineTelemetry = field(default_factory=PipelineTelemetry)
    terminal: TerminalState = field(default_factory=TerminalState)

    # Convenience: which stages have signalled they need re-evaluation.
    # Populated by domain events; consumed by orchestrator for control flow.
    stt_unready_notified: bool = False


__all__ = [
    "SourceKind",
    "LlmRouting",
    "TranscriptBuffer",
    "RefinementWindow",
    "GraphState",
    "HierarchyState",
    "PipelineTelemetry",
    "TerminalState",
    "PipelineState",
]

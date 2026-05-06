"""Typed events emitted by ConversationPipeline stages.

Per ADR-030 §P3 ("capability-oriented multi-stage pipeline with stable
event semantics"), each stage emits a small set of typed events that
both transports translate into their wire protocol (WebSocket messages
for ``LiveTransport``; SSE frames for ``ImportTransport``).

Design notes:
  - All events are frozen dataclasses so they're cheap to compare in tests
    and impossible to mutate after emission.
  - Every event carries ``stage`` (string) so the consumer can route on it.
  - Domain-specific events (TranscriptPartial, NodeAdded, etc.) extend
    ``StageEvent`` with extra fields. New events should preserve this shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple


# ---------------------------------------------------------------------------
# Base + lifecycle
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PipelineEvent:
    """Marker base for everything emitted out of a stage."""

    stage: str


@dataclass(frozen=True)
class StageStarted(PipelineEvent):
    """Emitted before the stage's main work begins. ``input_summary`` is a
    small dict of keys/values useful for observability (e.g. byte counts,
    chunk counts). Avoid putting full payloads in here.
    """

    input_summary: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StageCompleted(PipelineEvent):
    """Emitted after the stage's main work finishes successfully.

    ``output_summary`` mirrors ``StageStarted.input_summary`` shape — small
    keys/values, never full payloads. ``elapsed_ms`` is set by the
    orchestrator from the wall-clock between Started and Completed.
    """

    output_summary: Dict[str, Any] = field(default_factory=dict)
    elapsed_ms: float = 0.0


@dataclass(frozen=True)
class StageFailed(PipelineEvent):
    """Emitted when a stage raises ``StageError`` or any other exception.

    ``recoverable=True`` + ``next_action='retry'`` lets the transport
    decide to surface a retry CTA. ``recoverable=False`` is terminal.
    """

    code: str = "stage_error"
    detail: str = ""
    recoverable: bool = False
    next_action: Literal["retry", "continue", "stop"] = "stop"


# ---------------------------------------------------------------------------
# Domain events emitted by specific stages
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngestStarted(PipelineEvent):
    """Emitted by the ``ingest`` stage when it begins classifying a source.

    For live audio, the source is the WS audio stream. For import, the
    source is a file path or URL.
    """

    source_kind: Literal["live_audio", "audio_file", "text_file", "unknown"]
    source_size_bytes: Optional[int] = None


@dataclass(frozen=True)
class IngestCompleted(PipelineEvent):
    """Emitted by the ``ingest`` stage after source classification."""

    source_kind: Literal["live_audio", "audio_file", "text_file", "unknown"]
    is_likely_audio: bool
    source_metadata: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Transcript stage events (used in PR-B; declared here for stability)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TranscriptPartial(PipelineEvent):
    """Emitted by the ``transcribe`` stage on every partial STT result."""

    text: str
    timestamp_start: Optional[float] = None
    timestamp_end: Optional[float] = None
    speaker_segments: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class TranscriptFinal(PipelineEvent):
    """Emitted by the ``transcribe`` stage on every final STT result."""

    text: str
    timestamp_start: Optional[float] = None
    timestamp_end: Optional[float] = None
    speaker_segments: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)
    utterance_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Graph stage events (used in PR-C/D; declared here for stability)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodeAdded(PipelineEvent):
    """Emitted by ``generate_graph`` when a new node lands in
    ``state.graph_nodes``. Field shapes mirror the LLM-authored contract.
    """

    node_id: str
    node_name: str
    semantic_level: int = 1
    is_draft: bool = False


@dataclass(frozen=True)
class GraphPersisted(PipelineEvent):
    """Emitted by the ``persist`` stage after rows are committed to DB."""

    persisted_node_count: int
    elapsed_ms: float = 0.0


# ---------------------------------------------------------------------------
# Hierarchy stage events (used in PR-E for D2; declared here for stability)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LevelUnlocked(PipelineEvent):
    """Emitted by the ``unlock_hierarchy`` stage when a higher tier
    becomes available per ADR-030 §P4.

    ``semantic_type`` uses the canonical singular enum from §D2:
    ``chunk | idea | topic | theme | arc``.
    """

    level: int
    semantic_type: Literal["chunk", "idea", "topic", "theme", "arc"]
    node_count_at_unlock: int = 0


__all__ = [
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
]

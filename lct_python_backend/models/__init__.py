"""
SQLAlchemy models for Live Conversational Threads V2.
Based on DATA_MODEL_V2.md

Domain split:
  core        — Conversation, Utterance, TranscriptEvent
  graph       — Node, Relationship, Cluster
  analysis    — Claim, ArgumentTree, IsOughtConflation,
                SimulacraAnalysis, BiasAnalysis, FrameAnalysis
  interaction — Bookmark, EditsLog
  system      — APICallsLog, AppSetting, PipelineArtifact, ServiceStatus
  observability — ThreadSession, ThreadSessionEvent

All public names are re-exported here so existing
`from lct_python_backend.models import X` imports remain unchanged.
"""

from .base import Base  # noqa: F401 — must be imported before submodules

# Import submodules so Base.metadata is fully populated (required by Alembic)
from .core import Conversation, Utterance, TranscriptEvent, SpeakerSegment, SpeakerAudioReference, SpeakerCorrectionEvent  # noqa: F401
from .graph import Node, Relationship, Cluster  # noqa: F401
from .analysis import (  # noqa: F401
    Claim,
    ArgumentTree,
    IsOughtConflation,
    SimulacraAnalysis,
    BiasAnalysis,
    FrameAnalysis,
    IntentSignal,
    IntentSignalSighting,
)
from .interaction import Bookmark, EditsLog  # noqa: F401
from .system import APICallsLog, AppSetting, PipelineArtifact, ServiceStatus  # noqa: F401
from .observability import ThreadSession, ThreadSessionEvent  # noqa: F401

__all__ = [
    "Base",
    # core
    "Conversation",
    "Utterance",
    "TranscriptEvent",
    "SpeakerSegment",
    "SpeakerAudioReference",
    # graph
    "Node",
    "Relationship",
    "Cluster",
    # analysis
    "Claim",
    "ArgumentTree",
    "IsOughtConflation",
    "SimulacraAnalysis",
    "BiasAnalysis",
    "FrameAnalysis",
    "IntentSignal",
    "IntentSignalSighting",
    # interaction
    "Bookmark",
    "EditsLog",
    # system
    "APICallsLog",
    "AppSetting",
    "PipelineArtifact",
    "ServiceStatus",
    # observability
    "ThreadSession",
    "ThreadSessionEvent",
]

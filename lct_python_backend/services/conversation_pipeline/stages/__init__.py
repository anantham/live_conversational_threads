"""Concrete pipeline stages.

Each stage is a single-responsibility unit per ADR-030 §D3. Every stage
file should be ≤300 LOC; if it grows past that, split (e.g.
``transcribe_partial.py`` + ``transcribe_final.py``).

Available stages:
  - IngestStage           — source classification (PR-A)
  - TranscribeStage       — transcript-buffer state + typed event emission (PR-B)
  - SegmentStage          — text chunking for analyzer batches (PR-B)
  - AccumulateStage       — feed chunks into TranscriptProcessor.handle_final_text (PR-C)
  - GenerateGraphStage    — flush processor + materialise graph state (PR-C)
  - RefineStage           — second-pass LLM densification (import path) (PR-D)
  - PersistStage          — write canonical graph state via graph_persistence (PR-D)
  - UnlockHierarchyStage  — emergent depth cascade per ADR-030 §D2 (PR-E)
"""

from .accumulate import AccumulateStage
from .generate_graph import GenerateGraphStage
from .ingest import IngestStage
from .persist import PersistStage
from .refine import RefineStage
from .segment import SegmentStage
from .transcribe import TranscribeStage
from .unlock_hierarchy import UnlockHierarchyStage

__all__ = [
    "AccumulateStage",
    "GenerateGraphStage",
    "IngestStage",
    "PersistStage",
    "RefineStage",
    "SegmentStage",
    "TranscribeStage",
    "UnlockHierarchyStage",
]

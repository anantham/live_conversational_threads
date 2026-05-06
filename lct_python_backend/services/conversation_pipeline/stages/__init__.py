"""Concrete pipeline stages.

Each stage is a single-responsibility unit per ADR-030 §D3. Every stage
file should be ≤300 LOC; if it grows past that, split (e.g.
``transcribe_partial.py`` + ``transcribe_final.py``).

Available stages:
  - IngestStage      — source classification (PR-A)
  - TranscribeStage  — transcript-buffer state + typed event emission (PR-B)
  - SegmentStage     — text chunking for analyzer batches (PR-B)

Coming in later PRs:
  - AccumulateStage, GenerateGraphStage, RefineStage, PersistStage,
    UnlockHierarchyStage
"""

from .ingest import IngestStage
from .segment import SegmentStage
from .transcribe import TranscribeStage

__all__ = ["IngestStage", "SegmentStage", "TranscribeStage"]

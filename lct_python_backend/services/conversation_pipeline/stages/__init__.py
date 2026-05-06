"""Concrete pipeline stages.

Each stage is a single-responsibility unit per ADR-030 §D3. Every stage
file should be ≤300 LOC; if it grows past that, split (e.g.
``transcribe_partial.py`` + ``transcribe_final.py``).

Current stages (PR-A, the package skeleton):
  - IngestStage — source classification

Coming in later PRs (PR-B through PR-E):
  - TranscribeStage, SegmentStage, AccumulateStage, GenerateGraphStage,
    RefineStage, PersistStage, UnlockHierarchyStage
"""

from .ingest import IngestStage

__all__ = ["IngestStage"]

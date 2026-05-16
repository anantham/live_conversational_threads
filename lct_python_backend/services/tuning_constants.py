"""Tuning constants for the import + consolidation pipeline.

These thresholds were tuned empirically against Q.m4a (78 min) and Q_3min
during the A1-A8 consolidation rollout. Each name documents what it
controls and why it has the value it does — the next person who wants
to tweak one should not have to grep the codebase to understand the
rationale.

Cross-referenced in [[ADR-031]] §"Tuning constants currently inlined".
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Streaming graph LLM — context window
# ---------------------------------------------------------------------------

# Number of most-recent nodes from existing_json passed to the streaming
# graph LLM as prior context. We previously sent the full graph
# (repr(existing_json)) which grew unbounded and overflowed
# gpt-4o-mini's 128K context at ~node 470 in Q.m4a. Capping to a
# constant keeps prompt size bounded regardless of conversation length.
# 80 was the largest window that fit under 128K with the trimmed shape
# below and reasonable transcript chunks.
STREAMING_CONTEXT_WINDOW_SIZE: int = 80

# Fields included in the trimmed prior-node context. Anything outside
# this list is dropped before serialization. Keep this minimal — every
# field multiplies token cost across STREAMING_CONTEXT_WINDOW_SIZE.
STREAMING_CONTEXT_FIELDS: tuple[str, ...] = (
    "id",
    "node_name",
    "summary",
    "semantic_level",
    "semantic_type",
    "thread_id",
    "thread_state",
    "predecessor",
    "successor",
    "parent_id",
)


# ---------------------------------------------------------------------------
# Refinement guard — reject collapses
# ---------------------------------------------------------------------------

# A refinement pass that loses more than this fraction of the existing
# higher-tier nodes (level 2+) is treated as degraded and rejected.
# Reason: a single 23→14 refinement collapse on Q.m4a was traced to the
# refiner aggressively merging ideas/topics. The 50% gate keeps
# refinement honest without blocking legitimate consolidation.
REFINEMENT_HIGHER_TIER_LOSS_THRESHOLD: float = 0.5


# ---------------------------------------------------------------------------
# Post-streaming consolidation — minimum-count gates
# ---------------------------------------------------------------------------

# Below these counts each consolidation pass is skipped. The numbers
# pick the smallest input where clustering produces something more
# than identity, given the consolidation prompts' target ratios
# (5-8× ideas→topics, 3-5× topics→themes, 2-3× themes→arcs).
MIN_IDEAS_FOR_TOPIC_CONSOLIDATION: int = 4
MIN_TOPICS_FOR_THEME_CONSOLIDATION: int = 3
MIN_THEMES_FOR_ARC_CONSOLIDATION: int = 2


# ---------------------------------------------------------------------------
# Frontend default-tab heuristic (mirrored here for documentation)
# ---------------------------------------------------------------------------

# The frontend's MinimalGraph default-tab picker opens at the topmost
# tier whose compression ratio (count of finer tier / count of this
# tier) meets this threshold. Below 2.5 the tier doesn't compress
# enough to justify defaulting to it. Defined in
# lct_app/src/components/MinimalGraph.jsx; duplicated here so the
# value is discoverable from the backend side too.
DEFAULT_TAB_MIN_COMPRESSION_RATIO: float = 2.5

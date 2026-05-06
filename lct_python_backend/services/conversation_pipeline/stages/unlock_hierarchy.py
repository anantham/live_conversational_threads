"""Unlock-hierarchy stage — emergent depth per ADR-030 §P4 / §D2.

The pipeline starts every conversation with only the chunks tier.
Higher tiers (ideas / topics / themes / arcs) unlock when the count of
nodes at the current top tier crosses a bucket boundary AND an
LLM-judge confirms the items are diverse enough to warrant grouping.

Buckets: 5, 7, 10, 15, 25, 40, 60, 100. The cascade is geometric-ish so
short conversations stay calm and long conversations earn richer
abstraction.

Re-evaluation cadence: the judge is consulted once per (level, bucket)
pair. A content-hash of the items at the level below is used as a
cache key; if the hash hasn't changed since the last "not_yet" answer,
the judge is not called again. This avoids the failure mode where 6
initially-coherent items lock the conversation into chunks-only forever
even after divergence.

Once unlocked, a level persists for the lifetime of the conversation.
Subsequent additions trigger incremental re-clustering, not unlock
re-evaluation.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from ..events import LevelUnlocked
from ..protocol import EmitFn, Stage, StageError
from ..state import PipelineState


# Bucket thresholds at which the LLM-judge is consulted. Each bucket is
# a count-of-items at the level below.
UNLOCK_BUCKETS: Tuple[int, ...] = (5, 7, 10, 15, 25, 40, 60, 100)


# Canonical names for each tier per ADR-030 §D2 (singular, per-node value).
TIER_NAME_BY_LEVEL: Dict[int, str] = {
    1: "chunk",
    2: "idea",
    3: "topic",
    4: "theme",
    5: "arc",
}

MAX_LEVEL = max(TIER_NAME_BY_LEVEL)


# Judge function contract: (items at level below) -> "yes_cluster" | "not_yet"
JudgeFn = Callable[[List[Dict[str, Any]]], Awaitable[str]]


class UnlockHierarchyStage:
    """Run the unlock cascade once. Idempotent across calls — only
    appends new entries to ``state.hierarchy.unlocked_levels`` when the
    judge approves a fresh bucket.
    """

    name = "unlock_hierarchy"

    def __init__(self, judge_fn: Optional[JudgeFn] = None) -> None:
        self._judge_fn = judge_fn

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        nodes = list(state.graph.nodes or [])
        if not nodes:
            return

        # Index nodes by semantic_level (defaults to 1 / chunk per the
        # canonical enum). semantic_type is read for symmetry but level
        # is authoritative for the cascade.
        by_level: Dict[int, List[Dict[str, Any]]] = {}
        for node in nodes:
            if not isinstance(node, dict):
                continue
            level = _coerce_level(node)
            by_level.setdefault(level, []).append(node)

        unlocked = list(state.hierarchy.unlocked_levels or [1])

        # Walk upward from the current top until either we run out of
        # tiers or a bucket evaluation says "not yet".
        while True:
            current_top = max(unlocked) if unlocked else 1
            if current_top >= MAX_LEVEL:
                break

            items_below = by_level.get(current_top, [])
            count = len(items_below)
            bucket = _largest_bucket_crossed(count)
            if bucket is None:
                break

            cache = state.hierarchy.last_evaluated_bucket
            already_seen = cache.get(current_top)
            if already_seen == bucket:
                # Same bucket already evaluated as not_yet with the
                # same content; don't re-ask the judge.
                break

            decision = await self._consult_judge(items_below)
            cache[current_top] = bucket
            if decision != "yes_cluster":
                break

            next_level = current_top + 1
            if next_level in unlocked:
                # Defensive: already unlocked somehow; just stop.
                break

            unlocked.append(next_level)
            await emit(
                LevelUnlocked(
                    stage=self.name,
                    level=next_level,
                    semantic_type=TIER_NAME_BY_LEVEL[next_level],
                    node_count_at_unlock=count,
                )
            )

        state.hierarchy.unlocked_levels = sorted(set(unlocked))

    async def _consult_judge(self, items: List[Dict[str, Any]]) -> str:
        if self._judge_fn is None:
            # Without a judge, default to "not_yet" — we don't fabricate
            # unlock decisions. Transports must inject a judge to opt in.
            return "not_yet"
        try:
            decision = await self._judge_fn(items)
        except Exception as exc:  # noqa: BLE001
            raise StageError(
                f"unlock judge failed: {exc}",
                stage=self.name,
                code="judge_call_failed",
                recoverable=True,
                next_action="continue",
            ) from exc
        if decision not in {"yes_cluster", "not_yet"}:
            raise StageError(
                f"unlock judge returned invalid decision: {decision!r}",
                stage=self.name,
                code="judge_invalid_decision",
                recoverable=False,
                next_action="stop",
            )
        return decision


def _coerce_level(node: Dict[str, Any]) -> int:
    raw = node.get("semantic_level") or node.get("level") or 1
    try:
        level = int(raw)
    except (TypeError, ValueError):
        return 1
    return max(1, min(MAX_LEVEL, level))


def _largest_bucket_crossed(count: int) -> Optional[int]:
    """Return the largest bucket value <= count, or None if count < the
    smallest bucket."""
    crossed = [b for b in UNLOCK_BUCKETS if count >= b]
    return max(crossed) if crossed else None


def content_hash_for(items: List[Dict[str, Any]]) -> str:
    """Stable hash for an items list. Used by callers (and by the
    default judge wrapper) to dedupe consecutive judge calls when
    content hasn't changed.
    """
    canonical = json.dumps(
        [
            {
                "id": str(item.get("id") or item.get("node_id") or ""),
                "name": str(item.get("node_name") or ""),
                "summary": str(item.get("summary") or "")[:200],
            }
            for item in items
            if isinstance(item, dict)
        ],
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


__all__ = [
    "UnlockHierarchyStage",
    "UNLOCK_BUCKETS",
    "TIER_NAME_BY_LEVEL",
    "MAX_LEVEL",
    "JudgeFn",
    "content_hash_for",
]

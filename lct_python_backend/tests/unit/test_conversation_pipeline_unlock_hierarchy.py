"""Tests for UnlockHierarchyStage (ADR-030 §D3 PR-E, §D2 emergent depth)."""

from __future__ import annotations

import asyncio

from lct_python_backend.services.conversation_pipeline import (
    LevelUnlocked,
    PipelineState,
    UnlockHierarchyStage,
)
from lct_python_backend.services.conversation_pipeline.stages.unlock_hierarchy import (
    MAX_LEVEL,
    TIER_NAME_BY_LEVEL,
    UNLOCK_BUCKETS,
    _largest_bucket_crossed,
    content_hash_for,
)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _make_event_collector():
    events = []

    async def emit(evt):
        events.append(evt)

    return emit, events


def _chunks(n: int, prefix: str = "n", level: int = 1):
    """Build n distinct chunk-level node dicts."""
    return [
        {"id": f"{prefix}{i}", "node_name": f"Node {prefix}{i}", "level": level}
        for i in range(1, n + 1)
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_largest_bucket_crossed_returns_none_below_smallest():
    assert _largest_bucket_crossed(0) is None
    assert _largest_bucket_crossed(4) is None


def test_largest_bucket_crossed_returns_largest_threshold_at_or_below_count():
    assert _largest_bucket_crossed(5) == 5
    assert _largest_bucket_crossed(6) == 5
    assert _largest_bucket_crossed(7) == 7
    assert _largest_bucket_crossed(99) == 60
    assert _largest_bucket_crossed(100) == 100
    assert _largest_bucket_crossed(10_000) == 100


def test_unlock_buckets_match_adr_030_d2_specification():
    assert UNLOCK_BUCKETS == (5, 7, 10, 15, 25, 40, 60, 100)


def test_tier_names_match_singular_canonical_enum():
    assert TIER_NAME_BY_LEVEL == {
        1: "chunk",
        2: "idea",
        3: "topic",
        4: "theme",
        5: "arc",
    }


def test_content_hash_is_stable_for_same_input():
    items = [{"id": "a", "node_name": "A", "summary": "first"}]
    assert content_hash_for(items) == content_hash_for(items)


def test_content_hash_differs_when_content_changes():
    a = [{"id": "a", "node_name": "A"}]
    b = [{"id": "a", "node_name": "B"}]
    assert content_hash_for(a) != content_hash_for(b)


# ---------------------------------------------------------------------------
# UnlockHierarchyStage — primary cascade
# ---------------------------------------------------------------------------


def test_no_unlock_below_smallest_bucket():
    async def judge(_items):
        return "yes_cluster"  # would unlock if asked

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = _chunks(4)
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.hierarchy.unlocked_levels == [1]
    unlock_events = [e for e in events if isinstance(e, LevelUnlocked)]
    assert unlock_events == []


def test_unlocks_idea_when_chunks_cross_bucket_and_judge_says_yes():
    async def judge(_items):
        return "yes_cluster"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.hierarchy.unlocked_levels == [1, 2]
    unlocks = [e for e in events if isinstance(e, LevelUnlocked)]
    assert len(unlocks) == 1
    assert unlocks[0].level == 2
    assert unlocks[0].semantic_type == "idea"
    assert unlocks[0].node_count_at_unlock == 6


def test_does_not_unlock_when_judge_says_not_yet():
    async def judge(_items):
        return "not_yet"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.hierarchy.unlocked_levels == [1]
    assert [e for e in events if isinstance(e, LevelUnlocked)] == []


def test_default_judge_says_not_yet_when_unset():
    """Without an injected judge, the stage must NOT fabricate
    unlock decisions — only an explicit judge can opt the conversation
    into deeper hierarchy.
    """
    stage = UnlockHierarchyStage(judge_fn=None)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.hierarchy.unlocked_levels == [1]


# ---------------------------------------------------------------------------
# UnlockHierarchyStage — re-evaluation cadence
# ---------------------------------------------------------------------------


def test_re_evaluates_at_each_bucket_boundary_until_unlocked():
    """The whole point of bucketed re-evaluation: an initial 'not_yet'
    at bucket=5 must NOT lock the conversation forever. When the count
    crosses to bucket=7, the judge gets another shot.
    """

    decisions = ["not_yet", "yes_cluster"]
    asked_count_at = []

    async def judge(items):
        asked_count_at.append(len(items))
        return decisions[len(asked_count_at) - 1]

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()

    # First pass: 6 nodes, judge says not_yet.
    state.graph.nodes = _chunks(6)
    emit, events = _make_event_collector()
    _run(stage.run(state, emit))
    assert state.hierarchy.unlocked_levels == [1]

    # Conversation grows past the next bucket boundary (7).
    state.graph.nodes = _chunks(8)
    _run(stage.run(state, emit))
    assert state.hierarchy.unlocked_levels == [1, 2]

    assert asked_count_at == [6, 8]
    unlocks = [e for e in events if isinstance(e, LevelUnlocked)]
    assert len(unlocks) == 1


def test_does_not_re_ask_judge_within_the_same_bucket():
    """When count is unchanged (still in the same bucket and same
    content set), the judge should not be re-asked."""

    asked = []

    async def judge(items):
        asked.append(len(items))
        return "not_yet"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))
    _run(stage.run(state, emit))
    _run(stage.run(state, emit))

    # Only one call — the bucket cache prevents re-asking.
    assert asked == [6]


def test_idempotent_after_unlock():
    """Once a level is unlocked, re-running the stage must not unlock
    it again or re-ask the judge for that level."""

    async def judge(_items):
        return "yes_cluster"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))
    first_unlocked = list(state.hierarchy.unlocked_levels)
    _run(stage.run(state, emit))

    # Same unlock state; one LevelUnlocked event total.
    assert state.hierarchy.unlocked_levels == first_unlocked
    unlocks = [e for e in events if isinstance(e, LevelUnlocked)]
    assert len(unlocks) == 1


# ---------------------------------------------------------------------------
# UnlockHierarchyStage — multi-tier cascade in one run
# ---------------------------------------------------------------------------


def test_can_unlock_multiple_tiers_in_a_single_run_when_each_warrants_it():
    """If chunks > 5 unlocks ideas, and ideas > 5 also exist and
    warrant grouping, the cascade unlocks topics in the same run."""

    async def judge(_items):
        return "yes_cluster"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = (
        _chunks(10, prefix="c", level=1)
        + _chunks(6, prefix="i", level=2)
    )
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    # ideas (lvl 2) and topics (lvl 3) both unlock.
    assert state.hierarchy.unlocked_levels == [1, 2, 3]
    unlocks = [e for e in events if isinstance(e, LevelUnlocked)]
    assert [(u.level, u.semantic_type) for u in unlocks] == [
        (2, "idea"),
        (3, "topic"),
    ]


def test_cascade_stops_at_max_level():
    async def judge(_items):
        return "yes_cluster"

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    state.graph.nodes = (
        _chunks(10, prefix="c", level=1)
        + _chunks(10, prefix="i", level=2)
        + _chunks(10, prefix="t", level=3)
        + _chunks(10, prefix="th", level=4)
    )
    emit, events = _make_event_collector()

    _run(stage.run(state, emit))

    assert max(state.hierarchy.unlocked_levels) == MAX_LEVEL
    assert MAX_LEVEL == 5  # arc


# ---------------------------------------------------------------------------
# UnlockHierarchyStage — failures and odd inputs
# ---------------------------------------------------------------------------


def test_judge_returning_invalid_decision_is_a_hard_stop():
    async def bad_judge(_items):
        return "maybe"

    stage = UnlockHierarchyStage(judge_fn=bad_judge)
    state = PipelineState()
    state.graph.nodes = _chunks(6)
    emit, _events = _make_event_collector()

    try:
        _run(stage.run(state, emit))
        raised = False
    except Exception:
        raised = True

    # The orchestrator catches StageError; calling stage directly raises.
    assert raised


def test_no_op_on_empty_graph():
    async def judge(_items):
        raise AssertionError("should not be called")

    stage = UnlockHierarchyStage(judge_fn=judge)
    state = PipelineState()
    emit, _events = _make_event_collector()

    _run(stage.run(state, emit))

    assert state.hierarchy.unlocked_levels == [1]

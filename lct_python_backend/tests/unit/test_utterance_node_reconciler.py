"""Tests for services/utterance_node_reconciler — the live-path node<->utterance link fix.

The reconciler runs two ordered queries (Node, then Utterance) then commits.
The fake session here serves those in order; Node/Utterance rows are
SimpleNamespace stand-ins the reconciler mutates in place, so assertions read
the mutated objects directly.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace

import pytest

from lct_python_backend.services.utterance_node_reconciler import (
    _derive_speaker_info,
    _normalize,
    reconcile_conversation_links,
)

CONV_ID = "5953fd1b-2597-408c-916d-f553f8da57f2"


# ---------------------------------------------------------------------------
# Fake session
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _FakeSession:
    """Serves [nodes, utterances] across the reconciler's two execute() calls."""

    def __init__(self, nodes, utterances):
        self._queue = [nodes, utterances]
        self.commits = 0

    async def execute(self, _stmt):
        return _Result(self._queue.pop(0) if self._queue else [])

    async def commit(self):
        self.commits += 1


def _node(*, level=1, source_excerpt="", chunk_ids=None, children_ids=None, nid=None):
    return SimpleNamespace(
        id=nid or uuid.uuid4(),
        conversation_id=uuid.UUID(CONV_ID),
        level=level,
        source_excerpt=source_excerpt,
        chunk_ids=chunk_ids if chunk_ids is not None else [uuid.uuid4()],
        children_ids=children_ids or [],
        utterance_ids=None,
        speaker_info=None,
    )


def _utt(text, *, speaker_id="speaker_1", uid=None):
    return SimpleNamespace(
        id=uid or uuid.uuid4(),
        conversation_id=uuid.UUID(CONV_ID),
        text=text,
        text_cleaned=None,
        speaker_id=speaker_id,
        chunk_id=None,
        node_id=None,
    )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_normalize_folds_punctuation_and_case():
    assert _normalize("Hello, World!") == "hello world"
    assert _normalize("  A:   B  ") == "a b"
    assert _normalize("") == ""
    assert _normalize(None) == ""


def test_derive_speaker_info_picks_majority():
    info = _derive_speaker_info(["speaker_1", "speaker_1", "speaker_2"])
    assert info["primary_speaker"] == "speaker_1"
    assert info["speakers"] == ["speaker_1", "speaker_2"]
    assert info["speaker_distribution"] == {"speaker_1": 2, "speaker_2": 1}
    assert info["source"] == "utterance_reconciler"


def test_derive_speaker_info_empty_is_none():
    assert _derive_speaker_info([]) is None
    assert _derive_speaker_info(["", ""]) is None


# ---------------------------------------------------------------------------
# reconcile_conversation_links
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_links_utterances_to_l1_chunks():
    n1 = _node(source_excerpt="hello world this is chunk one")
    n2 = _node(source_excerpt="and here is the second chunk speaking")
    u1, u2 = _utt("hello world"), _utt("this is chunk one")
    u3, u4 = _utt("and here is the second chunk"), _utt("speaking")
    db = _FakeSession([n1, n2], [u1, u2, u3, u4])

    summary = await reconcile_conversation_links(CONV_ID, db=db)

    assert summary["linked_utterances"] == 4
    assert summary["unmatched_utterances"] == 0
    assert u1.node_id == n1.id and u2.node_id == n1.id
    assert u3.node_id == n2.id and u4.node_id == n2.id
    # chunk_id is copied from the matched node's chunk_ids[0]
    assert u1.chunk_id == n1.chunk_ids[0]
    assert set(n1.utterance_ids) == {u1.id, u2.id}
    assert set(n2.utterance_ids) == {u3.id, u4.id}
    assert db.commits == 1


@pytest.mark.asyncio
async def test_speaker_info_derived_from_diarization_speaker_id():
    n1 = _node(source_excerpt="alpha beta gamma")
    u1 = _utt("alpha", speaker_id="speaker_1")
    u2 = _utt("beta", speaker_id="speaker_1")
    u3 = _utt("gamma", speaker_id="speaker_2")
    db = _FakeSession([n1], [u1, u2, u3])

    summary = await reconcile_conversation_links(CONV_ID, db=db)

    assert summary["nodes_with_speaker_info"] == 1
    assert n1.speaker_info["primary_speaker"] == "speaker_1"
    assert n1.speaker_info["speakers"] == ["speaker_1", "speaker_2"]
    assert n1.speaker_info["speaker_distribution"] == {"speaker_1": 2, "speaker_2": 1}


@pytest.mark.asyncio
async def test_higher_tier_bubbles_up_via_children_ids():
    n1 = _node(level=1, source_excerpt="alpha beta")
    n2 = _node(level=1, source_excerpt="gamma delta")
    parent = _node(level=2, source_excerpt="", children_ids=[n1.id, n2.id])
    u1 = _utt("alpha beta", speaker_id="speaker_1")
    u2 = _utt("gamma delta", speaker_id="speaker_2")
    db = _FakeSession([n1, n2, parent], [u1, u2])

    summary = await reconcile_conversation_links(CONV_ID, db=db)

    assert summary["higher_tier_nodes"] == 1
    assert set(parent.utterance_ids) == {u1.id, u2.id}
    assert set(parent.speaker_info["speakers"]) == {"speaker_1", "speaker_2"}


@pytest.mark.asyncio
async def test_unmatched_utterance_is_counted_not_crashed():
    n1 = _node(source_excerpt="known text here")
    u1 = _utt("known text here")
    u2 = _utt("totally absent phrase")
    db = _FakeSession([n1], [u1, u2])

    summary = await reconcile_conversation_links(CONV_ID, db=db)

    assert summary["linked_utterances"] == 1
    assert summary["unmatched_utterances"] == 1
    assert u1.node_id == n1.id
    assert u2.node_id is None and u2.chunk_id is None


@pytest.mark.asyncio
async def test_empty_conversation_returns_zeros():
    db = _FakeSession([], [])
    summary = await reconcile_conversation_links(CONV_ID, db=db)
    assert summary["utterances"] == 0
    assert summary["linked_utterances"] == 0
    assert summary["l1_nodes"] == 0


@pytest.mark.asyncio
async def test_invalid_uuid_returns_error_no_crash():
    db = _FakeSession([], [])
    summary = await reconcile_conversation_links("not-a-uuid", db=db)
    assert summary["error"] == "invalid_uuid"

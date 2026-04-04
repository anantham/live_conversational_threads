"""Tests for speaker rename fallback when node speaker_id != utterance speaker_id."""

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from lct_python_backend.services.speaker_naming_service import (
    _resolve_speaker_id_via_nodes,
    rename_conversation_speaker,
)


# ---------------------------------------------------------------------------
# Lightweight fakes for Node / Utterance / Conversation
# ---------------------------------------------------------------------------

@dataclass
class FakeNode:
    id: uuid.UUID
    conversation_id: uuid.UUID
    speaker_info: Dict[str, Any] = field(default_factory=dict)
    utterance_ids: List[uuid.UUID] = field(default_factory=list)


@dataclass
class FakeUtterance:
    id: uuid.UUID
    conversation_id: uuid.UUID
    speaker_id: str
    speaker_name: Optional[str] = None
    sequence_number: int = 0
    text: str = ""


@dataclass
class FakeConversation:
    id: uuid.UUID
    participants: Optional[list] = None
    participant_count: int = 0


# ---------------------------------------------------------------------------
# Async DB mock builder
# ---------------------------------------------------------------------------

def _make_resolve_db(nodes, sample_utterance_speaker_id=None):
    """Build a mock async session for _resolve_speaker_id_via_nodes.

    The function makes exactly two queries:
      1. select(Node) — returns nodes
      2. select(Utterance.speaker_id) — returns a single row with the real speaker_id
    """
    call_count = 0

    async def fake_execute(stmt):
        nonlocal call_count
        call_count += 1
        result = MagicMock()

        if call_count == 1:
            # First call: Node query
            result.scalars.return_value.all.return_value = nodes
        else:
            # Second call: Utterance sample lookup
            if sample_utterance_speaker_id:
                result.first.return_value = (sample_utterance_speaker_id,)
            else:
                result.first.return_value = None

        return result

    db = AsyncMock()
    db.execute = fake_execute
    return db


# ---------------------------------------------------------------------------
# Tests for _resolve_speaker_id_via_nodes
# ---------------------------------------------------------------------------

CONV_UUID = uuid.UUID("a8af02e4-fdfb-4613-8e70-dd232383e38e")
UTT_ID_1 = uuid.uuid4()
UTT_ID_2 = uuid.uuid4()


@pytest.mark.asyncio
async def test_resolve_finds_real_speaker_id_via_node_speaker_info():
    """When node speaker_info says 'A' but utterance speaker_id is 'SPEAKER_00',
    the resolver should return 'SPEAKER_00'."""
    node = FakeNode(
        id=uuid.uuid4(),
        conversation_id=CONV_UUID,
        speaker_info={"primary_speaker": "A", "speakers": ["A"]},
        utterance_ids=[UTT_ID_1, UTT_ID_2],
    )
    db = _make_resolve_db(nodes=[node], sample_utterance_speaker_id="SPEAKER_00")

    result = await _resolve_speaker_id_via_nodes(db, CONV_UUID, "A")
    assert result == "SPEAKER_00"


@pytest.mark.asyncio
async def test_resolve_is_case_insensitive():
    """Matching should be case-insensitive: requesting 'a' finds speaker_info 'A'."""
    node = FakeNode(
        id=uuid.uuid4(),
        conversation_id=CONV_UUID,
        speaker_info={"primary_speaker": "A", "speakers": ["A"]},
        utterance_ids=[UTT_ID_1],
    )
    db = _make_resolve_db(nodes=[node], sample_utterance_speaker_id="speaker_1")

    result = await _resolve_speaker_id_via_nodes(db, CONV_UUID, "a")
    assert result == "speaker_1"


@pytest.mark.asyncio
async def test_resolve_returns_none_when_no_matching_nodes():
    """When no node has the requested speaker in its speaker_info, return None."""
    node = FakeNode(
        id=uuid.uuid4(),
        conversation_id=CONV_UUID,
        speaker_info={"primary_speaker": "B", "speakers": ["B"]},
        utterance_ids=[UTT_ID_1],
    )
    db = _make_resolve_db(nodes=[node])

    result = await _resolve_speaker_id_via_nodes(db, CONV_UUID, "X")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_returns_none_when_no_nodes_exist():
    """When conversation has no nodes at all, return None."""
    db = _make_resolve_db(nodes=[])

    result = await _resolve_speaker_id_via_nodes(db, CONV_UUID, "A")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_matches_via_speakers_list():
    """Should match when speaker_id appears in the speakers list, not just primary_speaker."""
    node = FakeNode(
        id=uuid.uuid4(),
        conversation_id=CONV_UUID,
        speaker_info={"primary_speaker": "B", "speakers": ["A", "B"]},
        utterance_ids=[UTT_ID_1],
    )
    db = _make_resolve_db(nodes=[node], sample_utterance_speaker_id="SPEAKER_00")

    result = await _resolve_speaker_id_via_nodes(db, CONV_UUID, "A")
    assert result == "SPEAKER_00"

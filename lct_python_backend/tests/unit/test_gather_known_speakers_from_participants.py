"""Tests for gather_known_speakers_from_participants — builds the
STT known_speakers payload from a conversation's picker selection."""

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, patch

import pytest

from lct_python_backend.services import speaker_voice_library
from lct_python_backend.services.speaker_voice_library import (
    gather_known_speakers_from_participants,
)


CONV_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


class _ExecuteResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _Session:
    """Async-session stand-in returning a single Conversation row."""

    def __init__(self, conversation=None):
        self._conversation = conversation

    async def execute(self, _stmt):
        return _ExecuteResult(self._conversation)


def _make_conv(participants):
    return SimpleNamespace(id=CONV_ID, participants=participants)


@pytest.mark.asyncio
async def test_returns_empty_when_conversation_not_found():
    session = _Session(conversation=None)
    out = await gather_known_speakers_from_participants(
        session, conversation_id=CONV_ID
    )
    assert out == []


@pytest.mark.asyncio
async def test_returns_empty_when_participants_empty():
    session = _Session(conversation=_make_conv([]))
    out = await gather_known_speakers_from_participants(
        session, conversation_id=CONV_ID
    )
    assert out == []


@pytest.mark.asyncio
async def test_participants_with_clips_and_external_llm_ok_pass_clips_through():
    """Both contacts allow external sharing and both have stored clips —
    the helper returns both names paired with their clips."""
    participants = [
        {"contact_id": "c_a", "display_name": "Aditya", "external_llm_ok": True},
        {"contact_id": "c_b", "display_name": "Sahil", "external_llm_ok": True},
    ]
    fake_refs = [
        {"name": "Aditya", "audio_base64": "AAA="},
        {"name": "Sahil", "audio_base64": "BBB="},
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=fake_refs),
    ) as mocked:
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    # Helper was called with only the names of allowed-to-share contacts
    mocked.assert_awaited_once()
    kwargs = mocked.await_args.kwargs
    assert set(kwargs["speaker_names"]) == {"Aditya", "Sahil"}

    by_name = {e["name"]: e for e in out}
    assert by_name["Aditya"]["audio_base64"] == "AAA="
    assert by_name["Aditya"]["external_llm_ok"] is True
    assert by_name["Sahil"]["audio_base64"] == "BBB="


@pytest.mark.asyncio
async def test_external_llm_ok_false_drops_clip_keeps_name():
    """Privacy-restricted contact: name still flows, clip is NOT shipped."""
    participants = [
        {"contact_id": "c_a", "display_name": "Aditya", "external_llm_ok": True},
        {"contact_id": "c_b", "display_name": "Mom", "external_llm_ok": False},
    ]
    fake_refs = [
        {"name": "Aditya", "audio_base64": "AAA="},
        # Mom is NOT in this list because the helper should not have asked for her
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=fake_refs),
    ) as mocked:
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    # Restricted name must NOT have been requested from the voice library —
    # we never want to even fetch a T3 contact's audio bytes for external use.
    assert mocked.await_args.kwargs["speaker_names"] == ["Aditya"]

    by_name = {e["name"]: e for e in out}
    assert by_name["Aditya"]["audio_base64"] == "AAA="
    assert by_name["Mom"]["audio_base64"] is None
    assert by_name["Mom"]["external_llm_ok"] is False


@pytest.mark.asyncio
async def test_participant_without_stored_clip_returns_name_only():
    """external_llm_ok=True but no clip exists yet — name flows, audio is None."""
    participants = [
        {"contact_id": "c_a", "display_name": "Aditya", "external_llm_ok": True},
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=[]),
    ):
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    assert out == [
        {"name": "Aditya", "audio_base64": None, "external_llm_ok": True},
    ]


@pytest.mark.asyncio
async def test_caps_at_max_speakers_default_4():
    participants = [
        {"contact_id": f"c_{i}", "display_name": f"P{i}", "external_llm_ok": True}
        for i in range(6)
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=[]),
    ) as mocked:
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    assert len(out) == 4
    assert [e["name"] for e in out] == ["P0", "P1", "P2", "P3"]
    # voice-library call should have been scoped to the 4-cap as well
    assert len(mocked.await_args.kwargs["speaker_names"]) == 4


@pytest.mark.asyncio
async def test_skips_participants_without_display_name():
    participants = [
        {"contact_id": "c_x", "external_llm_ok": True},  # missing name
        {"contact_id": "c_a", "display_name": "Aditya", "external_llm_ok": True},
        {"contact_id": "c_y", "display_name": "   ", "external_llm_ok": True},
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=[]),
    ):
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    assert [e["name"] for e in out] == ["Aditya"]


@pytest.mark.asyncio
async def test_handles_garbage_entries_in_participants_array():
    """Non-dict items mixed into the JSONB array are ignored gracefully."""
    participants = [
        "not-a-dict",
        None,
        {"contact_id": "c_a", "display_name": "Aditya", "external_llm_ok": True},
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=[]),
    ):
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    assert [e["name"] for e in out] == ["Aditya"]


@pytest.mark.asyncio
async def test_does_not_query_voice_library_when_no_external_llm_ok_contacts():
    """All participants are privacy-restricted → no need to round-trip the
    voice library at all. Performance: avoids a DB query when no clips can
    be shipped."""
    participants = [
        {"contact_id": "c_a", "display_name": "Mom", "external_llm_ok": False},
        {"contact_id": "c_b", "display_name": "Dad", "external_llm_ok": False},
    ]
    session = _Session(conversation=_make_conv(participants))

    with patch.object(
        speaker_voice_library,
        "get_speaker_audio_references",
        new=AsyncMock(return_value=[]),
    ) as mocked:
        out = await gather_known_speakers_from_participants(
            session, conversation_id=CONV_ID
        )

    mocked.assert_not_awaited()
    assert all(e["audio_base64"] is None for e in out)
    assert {e["name"] for e in out} == {"Mom", "Dad"}

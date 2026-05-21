"""Tests for services/participant_speaker_inference — single-speaker auto-naming.

infer() runs two ordered queries (Conversation, then Utterance) then commits.
The fake session serves those in order; Conversation/Utterance rows are
SimpleNamespace stand-ins the service mutates in place, so assertions read the
mutated objects directly.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

import uuid
from types import SimpleNamespace

import pytest

from lct_python_backend.services.participant_speaker_inference import (
    _named_participants,
    _sole_substantive_speaker,
    infer_participant_speaker,
)

CONV_ID = "5953fd1b-2597-408c-916d-f553f8da57f2"


# ---------------------------------------------------------------------------
# Fake session
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, *, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = rows or []

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _FakeSession:
    """Serves [conversation, utterances] across infer's two execute() calls."""

    def __init__(self, conversation, utterances):
        self._queue = [_Result(scalar=conversation), _Result(rows=utterances)]
        self.commits = 0

    async def execute(self, _stmt):
        return self._queue.pop(0) if self._queue else _Result()

    async def commit(self):
        self.commits += 1


def _conv(participants):
    return SimpleNamespace(id=uuid.UUID(CONV_ID), participants=participants)


def _utt(*, speaker_id="speaker_1", speaker_name=None, speaker_source="diarization",
         duration=None, seq=0):
    return SimpleNamespace(
        id=uuid.uuid4(),
        conversation_id=uuid.UUID(CONV_ID),
        speaker_id=speaker_id,
        speaker_name=speaker_name,
        speaker_source=speaker_source,
        duration_seconds=duration,
        sequence_number=seq,
    )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_named_participants_dedup_and_garbage():
    out = _named_participants([
        {"contact_id": "c1", "display_name": "Aditya"},
        "not-a-dict",
        None,
        {"display_name": "   "},          # blank
        {"contact_id": "c2"},             # no display_name
        {"display_name": "aditya"},       # case-insensitive duplicate
    ])
    assert out == ["Aditya"]
    assert _named_participants(None) == []
    assert _named_participants([]) == []


def test_named_participants_counts_guest_without_contact_id():
    # An ad-hoc guest (no contact_id) is still a named participant.
    assert _named_participants([{"display_name": "Guest Speaker"}]) == ["Guest Speaker"]


def test_sole_substantive_speaker_single_cluster():
    assert _sole_substantive_speaker([_utt(speaker_id="s1"), _utt(speaker_id="s1")]) == "s1"


def test_sole_substantive_speaker_drops_crumbs():
    # s1 dominates; s2 is a 1-second crumb well under the 5% threshold.
    big = [_utt(speaker_id="s1", duration=50.0) for _ in range(2)]
    crumb = [_utt(speaker_id="s2", duration=1.0)]
    assert _sole_substantive_speaker(big + crumb) == "s1"


def test_sole_substantive_speaker_two_real_speakers_is_none():
    two = [_utt(speaker_id="s1", duration=10.0), _utt(speaker_id="s2", duration=10.0)]
    assert _sole_substantive_speaker(two) is None


def test_sole_substantive_speaker_no_speech_is_none():
    assert _sole_substantive_speaker([_utt(speaker_id="")]) is None
    assert _sole_substantive_speaker([]) is None


# ---------------------------------------------------------------------------
# infer_participant_speaker
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_single_speaker_single_participant_assigns():
    conv = _conv([{"contact_id": "c1", "display_name": "Aditya"}])
    utts = [_utt(speaker_id="speaker_1", seq=i) for i in range(3)]
    db = _FakeSession(conv, utts)

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 3
    assert summary["participant"] == "Aditya"
    assert summary["speaker_id"] == "speaker_1"
    assert summary["skipped_reason"] is None
    assert all(u.speaker_name == "Aditya" for u in utts)
    assert all(u.speaker_source == "participant_inferred" for u in utts)
    assert db.commits == 1


@pytest.mark.asyncio
async def test_dominant_speaker_with_crumbs_assigns_all():
    # speaker_1 dominates; speaker_2 is a 1s crumb (~1% of talk time). The
    # crumb utterance is named too — it is a mis-split fragment of one person.
    conv = _conv([{"display_name": "Aditya"}])
    utts = (
        [_utt(speaker_id="speaker_1", duration=30.0, seq=i) for i in range(3)]
        + [_utt(speaker_id="speaker_2", duration=1.0, seq=3)]
    )
    db = _FakeSession(conv, utts)

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 4
    assert summary["speaker_id"] == "speaker_1"
    assert all(u.speaker_name == "Aditya" for u in utts)
    assert db.commits == 1


@pytest.mark.asyncio
async def test_two_real_speakers_skip():
    conv = _conv([{"display_name": "Aditya"}])
    utts = (
        [_utt(speaker_id="speaker_1", duration=10.0, seq=i) for i in range(3)]
        + [_utt(speaker_id="speaker_2", duration=10.0, seq=i + 3) for i in range(3)]
    )
    db = _FakeSession(conv, utts)

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 0
    assert summary["skipped_reason"] == "not_single_speaker"
    assert all(u.speaker_name is None for u in utts)
    assert db.commits == 0


@pytest.mark.asyncio
async def test_multiple_participants_skip():
    conv = _conv([{"display_name": "Aditya"}, {"display_name": "Sahil"}])
    utts = [_utt(speaker_id="speaker_1", seq=0)]
    db = _FakeSession(conv, utts)

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 0
    assert summary["skipped_reason"] == "multiple_participants"
    assert utts[0].speaker_name is None
    assert db.commits == 0


@pytest.mark.asyncio
async def test_no_participants_skip():
    conv = _conv([])
    utts = [_utt(speaker_id="speaker_1", seq=0)]
    db = _FakeSession(conv, utts)

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 0
    assert summary["skipped_reason"] == "no_named_participant"
    assert db.commits == 0


@pytest.mark.asyncio
async def test_does_not_clobber_existing_name():
    conv = _conv([{"display_name": "Aditya"}])
    named = _utt(speaker_id="speaker_1", speaker_name="Sahil",
                 speaker_source="user_corrected", seq=0)
    blank = _utt(speaker_id="speaker_1", seq=1)
    db = _FakeSession(conv, [named, blank])

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 1
    assert named.speaker_name == "Sahil"          # human correction preserved
    assert named.speaker_source == "user_corrected"
    assert blank.speaker_name == "Aditya"
    assert blank.speaker_source == "participant_inferred"


@pytest.mark.asyncio
async def test_protected_source_skipped_even_when_unnamed():
    # Defensive: a user_corrected row with a blank name is still not touched.
    conv = _conv([{"display_name": "Aditya"}])
    protected = _utt(speaker_id="speaker_1", speaker_name=None,
                     speaker_source="user_corrected", seq=0)
    plain = _utt(speaker_id="speaker_1", seq=1)
    db = _FakeSession(conv, [protected, plain])

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 1
    assert protected.speaker_name is None
    assert plain.speaker_name == "Aditya"


@pytest.mark.asyncio
async def test_no_utterances_skip():
    conv = _conv([{"display_name": "Aditya"}])
    db = _FakeSession(conv, [])

    summary = await infer_participant_speaker(CONV_ID, db=db)

    assert summary["assigned"] == 0
    assert summary["skipped_reason"] == "no_utterances"
    assert db.commits == 0


@pytest.mark.asyncio
async def test_conversation_not_found_skip():
    db = _FakeSession(None, [])
    summary = await infer_participant_speaker(CONV_ID, db=db)
    assert summary["skipped_reason"] == "conversation_not_found"


@pytest.mark.asyncio
async def test_invalid_uuid_skip_no_crash():
    db = _FakeSession(None, [])
    summary = await infer_participant_speaker("not-a-uuid", db=db)
    assert summary["skipped_reason"] == "invalid_uuid"
    assert summary["assigned"] == 0

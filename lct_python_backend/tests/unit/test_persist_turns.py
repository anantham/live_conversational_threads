"""Logic tests for ``persist_turns`` (P1 ingest) using a fake async session.

These verify the parts that don't need a real DB: that every Utterance is written
WITH its ``source_identifier`` (the whole point of P1 — the markdown path drops
it), that the privacy block + group id land on the Conversation, that re-ingest
deletes prior turns + graph, and that deployment-aware raw retention holds.

The DB-enforced invariants (the partial unique indexes) and the FastAPI wiring are
covered separately by the migration + an integration test against Postgres — not
here.
"""

import asyncio
import uuid

import pytest

from lct_python_backend.models import Conversation, Utterance as DBUtterance
from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1
from lct_python_backend.services.graph_persistence import persist_turns


def _turn(seq, **kw):
    return {
        "seq": seq,
        "source_identifier": f"meet:G:{seq}",
        "speaker_id": f"S{seq % 2}",
        "text": f"turn {seq}",
        **kw,
    }


def _payload(**overrides):
    base = {
        "group_id": "G",
        "conversation_name": "Test",
        "source_type": "google_meet",
        "owner_id": "owner-1",
        "privacy": {"redaction_applied": True},
        "turns": [_turn(0), _turn(1), _turn(2)],
    }
    base.update(overrides)
    return RawTurnsPayloadV1(**base)


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class FakeDB:
    """Minimal async-session stand-in. SELECTs return ``existing``; DELETEs are
    recorded; add/flush/commit are captured."""

    def __init__(self, existing=None):
        self.existing = existing
        self.added = []
        self.deletes = 0
        self.committed = False

    async def execute(self, stmt):
        if stmt.__class__.__name__ == "Delete":
            self.deletes += 1
            return _Result(None)
        return _Result(self.existing)  # Select

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass

    async def commit(self):
        self.committed = True

    async def rollback(self):
        pass


def _convs(db):
    return [o for o in db.added if isinstance(o, Conversation)]


def _utts(db):
    return [o for o in db.added if isinstance(o, DBUtterance)]


def test_new_conversation_writes_source_identifier_on_every_turn():
    db = FakeDB(existing=None)
    result = asyncio.run(persist_turns(db=db, payload=_payload()))

    convs, utts = _convs(db), _utts(db)
    assert len(convs) == 1
    assert convs[0].indrasnet_group_id == "G"
    assert convs[0].source_metadata["privacy"]["redaction_applied"] is True
    assert convs[0].source_metadata["contract_version"] == "1"
    assert len(utts) == 3
    # The whole point of P1: provenance anchor is set, not dropped.
    assert all(u.source_identifier for u in utts)
    assert {u.source_identifier for u in utts} == {"meet:G:0", "meet:G:1", "meet:G:2"}
    assert all(u.conversation_id == convs[0].id for u in utts)
    assert db.committed
    assert result["utterance_count"] == 3
    assert result["participant_count"] == 2  # S0, S1


def test_contact_id_lands_in_platform_metadata():
    db = FakeDB(existing=None)
    payload = _payload(turns=[_turn(0, contact_id="contact-42")])
    asyncio.run(persist_turns(db=db, payload=payload))
    (utt,) = _utts(db)
    assert utt.platform_metadata == {"contact_id": "contact-42"}


def test_reingest_replaces_turns_and_graph_keeping_conversation_id():
    existing = Conversation(
        id=uuid.uuid4(),
        conversation_name="old",
        conversation_type="transcript",
        source_type="google_meet",
        owner_id="owner-1",
        indrasnet_group_id="G",
        source_metadata={},
        deleted_at=None,
    )
    db = FakeDB(existing=existing)
    result = asyncio.run(persist_turns(db=db, payload=_payload()))

    # No NEW conversation created; the existing row is reused.
    assert _convs(db) == []
    # Five deletes: simulacra/bias/frame analyses + prior utterances + prior nodes
    # (relationships + cascade-FK analyses drop with the nodes).
    assert db.deletes == 5
    assert len(_utts(db)) == 3
    assert all(u.source_identifier for u in _utts(db))
    assert result["conversation_id"] == str(existing.id)


def test_explicit_conversation_id_must_match_owner_and_group():
    # A payload that names conversation A's id but a DIFFERENT group must be
    # refused, not allowed to destructively overwrite A (codex #1).
    other = Conversation(
        id=uuid.uuid4(),
        conversation_name="unrelated",
        conversation_type="transcript",
        source_type="google_meet",
        owner_id="owner-1",
        indrasnet_group_id="DIFFERENT-GROUP",
        source_metadata={},
        deleted_at=None,
    )
    db = FakeDB(existing=other)
    payload = _payload(conversation_id=str(other.id))  # group "G" != "DIFFERENT-GROUP"
    with pytest.raises(ValueError, match="does not belong"):
        asyncio.run(persist_turns(db=db, payload=payload))
    assert db.deletes == 0  # nothing destroyed


def test_raw_text_rejected_on_hosted_shared_deployment(monkeypatch):
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    payload = _payload(privacy={"redaction_applied": False}, owner_local_raw=True)
    with pytest.raises(ValueError, match="hosted_shared"):
        asyncio.run(persist_turns(db=FakeDB(), payload=payload))


def test_raw_text_allowed_on_personal_private_deployment(monkeypatch):
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "personal_private")
    monkeypatch.delenv("LCT_MIRROR_RAW", raising=False)
    payload = _payload(privacy={"redaction_applied": False}, owner_local_raw=True)
    result = asyncio.run(persist_turns(db=FakeDB(existing=None), payload=payload))
    assert result["utterance_count"] == 3


def test_validated_producer_metadata_persists_alongside_server_privacy():
    db = FakeDB(existing=None)
    payload = _payload(source_metadata={
        "media_refs": [{
            "provider": "google_drive", "file_id": "drive-file-123",
            "view_url": "https://drive.google.com/file/d/drive-file-123/view",
        }],
    })
    asyncio.run(persist_turns(db=db, payload=payload))
    (conv,) = _convs(db)
    assert conv.source_metadata["media_refs"][0]["file_id"] == "drive-file-123"
    assert conv.source_metadata["privacy"] == {
        "external_llm_ok": False, "local_llm_ok": True,
        "redaction_applied": True, "redaction_map_id": None,
    }
    assert conv.source_metadata["contract_version"] == "1"

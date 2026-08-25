"""Validation tests for the P1 RawTurn[] data contract (pure, no DB).

Covers the invariants the endpoint relies on (docs/plans/2026-06-17-p1-rawturn-
data-contract.md §2): dense `seq`, unique non-null `source_identifier`,
non-empty turns/group_id, contract pinning, and the redaction-default gate.
DB-level dedup (the unique indexes) is verified separately in the migration /
persist_turns integration tests.
"""

import pytest
from pydantic import ValidationError

from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1


def _turn(seq, sid=None, **kw):
    return {
        "seq": seq,
        "source_identifier": sid if sid is not None else f"meet:G:{seq}",
        "speaker_id": "A",
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
        "turns": [_turn(0), _turn(1)],
    }
    base.update(overrides)
    return base


def test_valid_payload_defaults():
    p = RawTurnsPayloadV1(**_payload())
    assert p.contract_version == "1"
    assert p.privacy.redaction_applied is True  # redacted-by-default
    assert p.privacy.external_llm_ok is False  # opt-in deny-by-default
    assert p.owner_local_raw is False
    assert len(p.turns) == 2


def test_seq_must_be_dense_no_gaps():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0), _turn(2)]))


def test_seq_must_not_duplicate():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0), _turn(0, sid="meet:G:dup")]))


def test_negative_seq_rejected():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(-1)]))


def test_source_identifier_unique_within_payload():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0, sid="dup"), _turn(1, sid="dup")]))


def test_source_identifier_non_empty():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0, sid="")]))


def test_turns_non_empty():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[]))


def test_group_id_non_empty():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(group_id=""))


def test_contract_version_pinned_to_1():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(contract_version="2"))


def test_redaction_false_requires_owner_local_raw():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(privacy={"redaction_applied": False}))


def test_redaction_false_with_owner_local_raw_ok():
    p = RawTurnsPayloadV1(
        **_payload(privacy={"redaction_applied": False}, owner_local_raw=True)
    )
    assert p.privacy.redaction_applied is False
    assert p.owner_local_raw is True


def test_optional_turn_fields_round_trip():
    p = RawTurnsPayloadV1(
        **_payload(turns=[_turn(0, contact_id="c1", ts_start=1.0, ts_end=2.5)])
    )
    assert p.turns[0].contact_id == "c1"
    assert p.turns[0].ts_start == 1.0
    assert p.turns[0].ts_end == 2.5


def test_conversation_id_optional_for_reingest():
    p = RawTurnsPayloadV1(**_payload(conversation_id="11111111-1111-1111-1111-111111111111"))
    assert p.conversation_id == "11111111-1111-1111-1111-111111111111"


def test_conversation_id_must_be_uuid_shaped():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(conversation_id="not-a-uuid"))


# --- fail-closed privacy (codex #2) ----------------------------------------


def test_privacy_block_is_required():
    body = _payload()
    del body["privacy"]
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**body)


def test_redaction_applied_is_required_within_privacy():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(privacy={}))  # no redaction_applied → reject


def test_misspelled_privacy_key_rejected_not_ignored():
    # `redactionApplied` (camelCase) must NOT silently fall back to the safe default.
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(privacy={"redactionApplied": False}))


def test_unknown_top_level_key_rejected():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(unexpected_field="x"))


def test_unknown_turn_key_rejected():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0, typo_field=1)]))


# --- timestamp ordering (codex #4) -----------------------------------------


def test_ts_end_before_ts_start_rejected():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(turns=[_turn(0, ts_start=10.0, ts_end=5.0)]))


def test_ts_equal_is_allowed():
    p = RawTurnsPayloadV1(**_payload(turns=[_turn(0, ts_start=3.0, ts_end=3.0)]))
    assert p.turns[0].ts_start == 3.0


def test_source_metadata_is_bounded_but_preserved():
    p = RawTurnsPayloadV1(**_payload(source_metadata={"media_refs": [{
        "provider": "google_drive", "file_id": "drive-file-123",
        "view_url": "https://drive.google.com/file/d/drive-file-123/view",
    }]}))
    assert p.source_metadata.media_refs[0].file_id == "drive-file-123"


def test_source_metadata_cannot_spoof_reserved_server_fields():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(source_metadata={
            "media_refs": [],
            "privacy": {"external_llm_ok": True},
            "contract_version": "spoofed",
        }))


def test_media_ref_url_must_match_the_drive_file_id():
    with pytest.raises(ValidationError):
        RawTurnsPayloadV1(**_payload(source_metadata={"media_refs": [{
            "provider": "google_drive",
            "file_id": "drive-file-123",
            "view_url": "https://example.com/file/d/drive-file-123/view",
        }]}))

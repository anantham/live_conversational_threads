"""Behavioral contract for fail-closed attendee-registry migration.

Test intent:
- archived and current registries merge without deleting either source;
- every source and prior destination receives a byte-for-byte backup;
- identical duplicates are harmless and conflicting duplicates stop the write;
- invalid JSON or invalid registry shape leaves the destination unchanged;
- repeated migration is idempotent and uses an atomic destination replacement.
"""

import hashlib
import json

import pytest

from lct_python_backend.services.runtime_data_migration import (
    RegistryConflictError,
    RegistryValidationError,
    migrate_attendee_registries,
)


def _record(conversation_id: str, *, status: str = "ended") -> dict:
    return {
        "conversation_id": conversation_id,
        "meeting_url": f"https://meet.google.com/{conversation_id}",
        "bot_id": f"bot-{conversation_id}",
        "status": status,
        "joined_at": "2026-09-01T00:00:00Z",
        "last_status_at": "2026-09-01T01:00:00Z",
    }


def _write(path, records: dict) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(records, indent=2).encode("utf-8")
    path.write_bytes(payload)
    return payload


def test_migration_merges_disjoint_sources_and_preserves_byte_backups(tmp_path):
    archived = tmp_path / "archive" / "attendee_sessions.json"
    current = tmp_path / "checkout" / "attendee_sessions.json"
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    archived_bytes = _write(archived, {"archived": _record("archived")})
    current_bytes = _write(current, {"current": _record("current")})

    report = migrate_attendee_registries(
        sources=[archived, current], destination=destination
    )

    assert json.loads(destination.read_text(encoding="utf-8")) == {
        "archived": _record("archived"),
        "current": _record("current"),
    }
    assert archived.read_bytes() == archived_bytes
    assert current.read_bytes() == current_bytes
    assert report.destination_records == 2
    assert report.excluded_records == 0
    assert report.identical_duplicates == 0
    assert len(report.backups) == 2
    assert {backup.source for backup in report.backups} == {archived, current}
    for backup in report.backups:
        assert backup.backup.read_bytes() == backup.source.read_bytes()
        assert backup.sha256 == hashlib.sha256(backup.source.read_bytes()).hexdigest()


def test_migration_is_idempotent_and_backs_up_existing_destination(tmp_path):
    source = tmp_path / "source.json"
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    _write(source, {"same": _record("same")})

    first = migrate_attendee_registries(sources=[source], destination=destination)
    second = migrate_attendee_registries(sources=[source], destination=destination)

    assert first.destination_records == second.destination_records == 1
    assert second.identical_duplicates == 1
    assert {backup.source for backup in second.backups} == {destination, source}
    assert not list(destination.parent.glob("*.tmp"))


def test_conflicting_duplicate_fails_closed_without_changing_destination(tmp_path):
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    source = tmp_path / "source.json"
    original = _write(destination, {"same": _record("same", status="ended")})
    _write(source, {"same": _record("same", status="recording")})

    with pytest.raises(RegistryConflictError, match="same"):
        migrate_attendee_registries(sources=[source], destination=destination)

    assert destination.read_bytes() == original


def test_source_specific_manifest_quarantines_known_test_records(tmp_path):
    archive = tmp_path / "archive.json"
    current = tmp_path / "current.json"
    manifest = tmp_path / "known-test-records.json"
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    _write(
        archive,
        {
            "fixture": _record("fixture", status="authoritative"),
            "archived": _record("archived"),
        },
    )
    _write(
        current,
        {
            "fixture": _record("fixture", status="synthetic-test"),
            "current": _record("current"),
        },
    )
    _write(manifest, {"fixture": _record("fixture", status="known-fixture")})

    report = migrate_attendee_registries(
        sources=[archive, current],
        destination=destination,
        source_exclusion_manifests={current: manifest},
    )

    merged = json.loads(destination.read_text(encoding="utf-8"))
    assert merged == {
        "fixture": _record("fixture", status="authoritative"),
        "archived": _record("archived"),
        "current": _record("current"),
    }
    assert report.destination_records == 3
    assert report.source_records == 3
    assert report.excluded_records == 1
    assert {backup.source for backup in report.backups} == {
        archive,
        current,
        manifest,
    }


def test_exclusion_manifest_must_be_exact_subset_of_its_source(tmp_path):
    source = tmp_path / "source.json"
    manifest = tmp_path / "manifest.json"
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    _write(source, {"current": _record("current")})
    _write(manifest, {"absent": _record("absent")})

    with pytest.raises(RegistryValidationError, match="absent from"):
        migrate_attendee_registries(
            sources=[source],
            destination=destination,
            source_exclusion_manifests={source: manifest},
        )

    assert not destination.exists()


@pytest.mark.parametrize("payload", [b"not-json", b"[]", b'{"x": []}'])
def test_invalid_source_fails_closed_without_changing_destination(tmp_path, payload):
    destination = tmp_path / "user-data" / "attendee_sessions.json"
    source = tmp_path / "source.json"
    original = _write(destination, {"existing": _record("existing")})
    source.write_bytes(payload)

    with pytest.raises(RegistryValidationError):
        migrate_attendee_registries(sources=[source], destination=destination)

    assert destination.read_bytes() == original

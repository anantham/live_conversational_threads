"""Fail-closed migration for mutable attendee registry state.

The migration is deliberately explicit: callers provide the preserved source
files, the existing destination participates automatically, every input is
validated before mutation, byte-for-byte backups are created, and the final
registry is atomically replaced.  Sources are never deleted.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
import uuid

from lct_python_backend.services.runtime_paths import (
    get_attendee_session_registry_path,
)


class RegistryValidationError(ValueError):
    """A source is not a valid attendee-session registry."""


class RegistryConflictError(ValueError):
    """Two registries contain different records for the same identity."""


@dataclass(frozen=True)
class RegistryBackup:
    source: Path
    backup: Path
    sha256: str
    records: int


@dataclass(frozen=True)
class RegistryMigrationReport:
    destination: Path
    destination_records: int
    source_records: int
    excluded_records: int
    identical_duplicates: int
    backups: Tuple[RegistryBackup, ...]

    def to_json_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["destination"] = str(self.destination)
        payload["backups"] = [
            {
                **backup,
                "source": str(backup["source"]),
                "backup": str(backup["backup"]),
            }
            for backup in payload["backups"]
        ]
        return payload


def _read_registry(path: Path) -> Tuple[Dict[str, Dict[str, Any]], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise RegistryValidationError(f"Could not read registry {path}: {exc}") from exc
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RegistryValidationError(f"Registry {path} is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(decoded, dict):
        raise RegistryValidationError(f"Registry {path} must contain a top-level object")

    records: Dict[str, Dict[str, Any]] = {}
    for conversation_id, record in decoded.items():
        if not isinstance(conversation_id, str) or not conversation_id:
            raise RegistryValidationError(f"Registry {path} contains an invalid record key")
        if not isinstance(record, dict):
            raise RegistryValidationError(
                f"Registry {path} record {conversation_id!r} must be an object"
            )
        embedded_id = record.get("conversation_id")
        if embedded_id != conversation_id:
            raise RegistryValidationError(
                f"Registry {path} record {conversation_id!r} has mismatched conversation_id"
            )
        records[conversation_id] = record
    return records, raw


def _unique_existing_inputs(sources: Iterable[Path], destination: Path) -> List[Path]:
    ordered: List[Path] = []
    seen = set()
    candidates = ([destination] if destination.is_file() else []) + list(sources)
    for candidate in candidates:
        resolved = Path(candidate).expanduser().resolve()
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        ordered.append(resolved)
    return ordered


def _backup_inputs(
    inputs: Sequence[Tuple[Path, Mapping[str, Any], bytes]], destination: Path
) -> Tuple[RegistryBackup, ...]:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_directory = (
        destination.parent / "migration-backups" / f"{timestamp}-{uuid.uuid4().hex}"
    )
    backup_directory.mkdir(parents=True, exist_ok=False)
    backups: List[RegistryBackup] = []
    for index, (source, records, raw) in enumerate(inputs, start=1):
        backup = backup_directory / f"{index:02d}-{source.name}"
        shutil.copy2(source, backup)
        copied = backup.read_bytes()
        if copied != raw:
            raise OSError(f"Backup verification failed for {source}: {backup}")
        backups.append(
            RegistryBackup(
                source=source,
                backup=backup,
                sha256=hashlib.sha256(raw).hexdigest(),
                records=len(records),
            )
        )
    return tuple(backups)


def _atomic_write_registry(destination: Path, records: Mapping[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(records, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    temporary_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def migrate_attendee_registries(
    *,
    sources: Sequence[Path],
    destination: Path,
    source_exclusion_manifests: Optional[Mapping[Path, Path]] = None,
) -> RegistryMigrationReport:
    """Merge validated registries into *destination* without deleting inputs.

    Existing destination state is merged first. Different records with the same
    key are ambiguous and stop the migration before backups or replacement.
    """

    if not sources:
        raise RegistryValidationError("At least one registry source is required")
    destination = Path(destination).expanduser().resolve()
    input_paths = _unique_existing_inputs(sources, destination)
    if not input_paths:
        raise RegistryValidationError("No registry inputs exist")

    source_keys = {os.path.normcase(str(Path(path).expanduser().resolve())) for path in sources}
    exclusion_ids: Dict[str, set] = {}
    exclusion_inputs: List[Tuple[Path, Dict[str, Dict[str, Any]], bytes]] = []
    for source, manifest in (source_exclusion_manifests or {}).items():
        resolved_source = Path(source).expanduser().resolve()
        source_key = os.path.normcase(str(resolved_source))
        if source_key not in source_keys:
            raise RegistryValidationError(
                f"Exclusion source is not one of the migration sources: {resolved_source}"
            )
        resolved_manifest = Path(manifest).expanduser().resolve()
        manifest_records, manifest_raw = _read_registry(resolved_manifest)
        exclusion_ids[source_key] = set(manifest_records)
        exclusion_inputs.append((resolved_manifest, manifest_records, manifest_raw))

    inputs: List[Tuple[Path, Dict[str, Dict[str, Any]], bytes]] = []
    merged: Dict[str, Dict[str, Any]] = {}
    origins: Dict[str, Path] = {}
    duplicates = 0
    source_records = 0
    excluded_records = 0
    for path in input_paths:
        records, raw = _read_registry(path)
        inputs.append((path, records, raw))
        path_key = os.path.normcase(str(path))
        excluded = exclusion_ids.get(path_key, set())
        missing_exclusions = excluded - set(records)
        if missing_exclusions:
            raise RegistryValidationError(
                f"Exclusion manifest contains {len(missing_exclusions)} record(s) absent from {path}"
            )
        if path != destination:
            source_records += len(records) - len(excluded)
            excluded_records += len(excluded)
        for conversation_id, record in records.items():
            if conversation_id in excluded:
                continue
            if conversation_id not in merged:
                merged[conversation_id] = record
                origins[conversation_id] = path
                continue
            if merged[conversation_id] == record:
                duplicates += 1
                continue
            raise RegistryConflictError(
                "Conflicting attendee registry record "
                f"{conversation_id!r} in {origins[conversation_id]} and {path}; "
                "destination was not changed"
            )

    destination.parent.mkdir(parents=True, exist_ok=True)
    backup_inputs = list(inputs)
    known_backup_paths = {os.path.normcase(str(path)) for path, _, _ in backup_inputs}
    for manifest_input in exclusion_inputs:
        if os.path.normcase(str(manifest_input[0])) not in known_backup_paths:
            backup_inputs.append(manifest_input)
    backups = _backup_inputs(backup_inputs, destination)
    _atomic_write_registry(destination, merged)
    verified, _ = _read_registry(destination)
    if verified != merged:
        raise OSError(f"Destination verification failed after migration: {destination}")

    return RegistryMigrationReport(
        destination=destination,
        destination_records=len(merged),
        source_records=source_records,
        excluded_records=excluded_records,
        identical_duplicates=duplicates,
        backups=backups,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Merge preserved attendee registries into stable per-user LCT data"
    )
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        type=Path,
        help="Registry to preserve and merge; may be supplied more than once",
    )
    parser.add_argument(
        "--exclude-records-from",
        action="append",
        default=[],
        metavar="SOURCE=MANIFEST",
        help=(
            "Exclude from one source exactly the record IDs listed by a validated "
            "registry manifest; both files are preserved in migration backups"
        ),
    )
    parser.add_argument(
        "--destination",
        type=Path,
        default=None,
        help="Destination registry (defaults to the current per-user LCT data path)",
    )
    args = parser.parse_args(argv)
    destination = args.destination or get_attendee_session_registry_path()
    exclusions: Dict[Path, Path] = {}
    for specification in args.exclude_records_from:
        source_text, separator, manifest_text = specification.partition("=")
        if not separator or not source_text.strip() or not manifest_text.strip():
            parser.error("--exclude-records-from must use SOURCE=MANIFEST")
        exclusions[Path(source_text)] = Path(manifest_text)
    report = migrate_attendee_registries(
        sources=args.source,
        destination=destination,
        source_exclusion_manifests=exclusions,
    )
    print(json.dumps(report.to_json_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

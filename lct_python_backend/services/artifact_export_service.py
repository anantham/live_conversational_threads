"""Backend-owned artifact export writer for paired Obsidian files."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional

from sqlalchemy import delete, select

from lct_python_backend.models import PipelineArtifact
from lct_python_backend.services.artifact_settings_service import (
    normalize_artifact_export_settings,
    validate_artifact_export_settings,
)
from lct_python_backend.services.conversation_artifacts import (
    build_linear_transcript_text,
    sanitize_artifact_basename,
)
from lct_python_backend.services.conversation_reader import (
    build_chunk_dict_from_utterances,
    build_graph_data_from_nodes,
    fetch_conversation_bundle,
)
from lct_python_backend.services.speaker_naming_service import (
    is_confirmed_speaker_name,
    normalize_speaker_name,
)

logger = logging.getLogger(__name__)

ARTIFACT_EXPORT_STAGE = "artifact_export"
ARTIFACT_TYPE_CANVAS = "obsidian_canvas"
ARTIFACT_TYPE_TRANSCRIPT = "linear_transcript"


def _coerce_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        raw = float(value)
        if raw > 1_000_000_000_000:
            raw = raw / 1000.0
        try:
            return datetime.fromtimestamp(raw, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def resolve_artifact_timestamp(conversation: Any) -> datetime:
    source_metadata = getattr(conversation, "source_metadata", None)
    if isinstance(source_metadata, Mapping):
        for key in (
            "recording_started_at",
            "recorded_at",
            "started_at",
            "source_started_at",
            "timestamp",
            "created_at",
        ):
            parsed = _coerce_datetime(source_metadata.get(key))
            if parsed is not None:
                return parsed
    started_at = _coerce_datetime(getattr(conversation, "started_at", None))
    if started_at is not None:
        return started_at
    return datetime.now(timezone.utc)


def build_artifact_base_name(conversation: Any) -> str:
    title = sanitize_artifact_basename(
        getattr(conversation, "conversation_name", None) or "conversation"
    )
    timestamp = resolve_artifact_timestamp(conversation).astimezone(timezone.utc)
    return sanitize_artifact_basename(f"{title} ({timestamp.strftime('%Y-%m-%d %H-%M-%S')})")


def build_canvas_edge_records(relationships: Iterable[Any]) -> list[dict[str, str]]:
    canvas_edges: list[dict[str, str]] = []
    for rel in relationships:
        rel_type = getattr(rel, "relationship_type", None) or "related"
        rel_type_lower = rel_type.lower()
        if rel_type_lower in {"supports", "informs", "builds_on", "enables", "affirms"}:
            color = "4"
        elif rel_type_lower in {
            "contradicts",
            "opposes",
            "refutes",
            "challenges",
            "conflicts",
            "disagrees",
            "rebuts",
        }:
            color = "1"
        else:
            color = "3"
        canvas_edges.append(
            {
                "id": f"edge_{getattr(rel, 'id', uuid.uuid4())}",
                "fromNode": str(getattr(rel, "from_node_id", "")),
                "toNode": str(getattr(rel, "to_node_id", "")),
                "label": rel_type,
                "color": color,
            }
        )
    return canvas_edges


async def build_export_artifacts_for_conversation(
    *,
    db,
    conversation_id: str | uuid.UUID,
    include_chunks: bool = False,
) -> Dict[str, Any]:
    from lct_python_backend.canvas_api import convert_conversation_to_canvas

    conversation_uuid = conversation_id if isinstance(conversation_id, uuid.UUID) else uuid.UUID(str(conversation_id))
    conversation, nodes, relationships, utterances = await fetch_conversation_bundle(db, conversation_uuid)
    if not conversation:
        raise ValueError(f"Conversation not found: {conversation_id}")

    graph_data = build_graph_data_from_nodes(nodes, relationships)
    chunk_dict = build_chunk_dict_from_utterances(utterances) if include_chunks else {}
    canvas = convert_conversation_to_canvas(
        [graph_data],
        chunk_dict,
        getattr(conversation, "conversation_name", None) or "Untitled Conversation",
        include_chunks,
        edge_records=build_canvas_edge_records(relationships),
    )
    transcript_text = build_linear_transcript_text(
        conversation=conversation,
        utterances=utterances,
        chunk_dict=build_chunk_dict_from_utterances(utterances),
    )
    return {
        "conversation": conversation,
        "utterances": utterances,
        "canvas_data": canvas.model_dump(),
        "transcript_text": transcript_text,
        "base_name": build_artifact_base_name(conversation),
    }


def _resolve_unique_base_name(
    root: Path,
    base_name: str,
    *,
    write_canvas: bool,
    write_transcript: bool,
    exclude_paths: Iterable[Path] | None = None,
) -> str:
    suffixes = []
    if write_canvas:
        suffixes.append(".canvas")
    if write_transcript:
        suffixes.append(".txt")
    excluded = {str(Path(path)) for path in (exclude_paths or [])}

    def _path_exists(candidate_name: str, suffix: str) -> bool:
        path = root / f"{candidate_name}{suffix}"
        if str(path) in excluded:
            return False
        return path.exists()

    candidate = base_name
    counter = 2
    while suffixes and any(_path_exists(candidate, suffix) for suffix in suffixes):
        candidate = f"{base_name}__{counter}"
        counter += 1
    return candidate


def _resolve_export_directory(
    root: Path,
    *,
    utterances: Iterable[Any],
    self_name: str = "",
) -> Path:
    normalized_self_name = normalize_speaker_name(self_name).casefold()
    confirmed_names = []
    seen = set()

    for utterance in utterances or []:
        speaker_id = normalize_speaker_name(getattr(utterance, "speaker_id", None))
        speaker_name = normalize_speaker_name(getattr(utterance, "speaker_name", None))
        if not is_confirmed_speaker_name(speaker_id=speaker_id, speaker_name=speaker_name):
            continue
        normalized_name = speaker_name.casefold()
        if normalized_self_name and normalized_name == normalized_self_name:
            continue
        if normalized_name in seen:
            continue
        seen.add(normalized_name)
        confirmed_names.append(speaker_name)

    if len(confirmed_names) == 1:
        participant_dir = root / sanitize_artifact_basename(confirmed_names[0])
        participant_dir.mkdir(parents=True, exist_ok=True)
        return participant_dir

    root.mkdir(parents=True, exist_ok=True)
    return root


def _atomic_write_text(path: Path, text: str) -> None:
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.stem}.",
        suffix=".tmp",
        delete=False,
    )
    temp_path = Path(handle.name)
    try:
        with handle:
            handle.write(text)
            handle.flush()
        temp_path.replace(path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _artifact_type_for_suffix(suffix: str) -> str | None:
    normalized = str(suffix or "").strip().lower()
    if normalized == ".canvas":
        return ARTIFACT_TYPE_CANVAS
    if normalized == ".txt":
        return ARTIFACT_TYPE_TRANSCRIPT
    return None


def _tracked_artifact_type_to_suffix(artifact_type: str) -> str | None:
    normalized = str(artifact_type or "").strip().lower()
    if normalized == ARTIFACT_TYPE_CANVAS:
        return ".canvas"
    if normalized == ARTIFACT_TYPE_TRANSCRIPT:
        return ".txt"
    return None


async def _load_tracked_artifact_rows(*, db, conversation_uuid: uuid.UUID) -> list[PipelineArtifact]:
    result = await db.execute(
        select(PipelineArtifact)
        .where(PipelineArtifact.conversation_id == conversation_uuid)
        .where(PipelineArtifact.stage == ARTIFACT_EXPORT_STAGE)
        .order_by(PipelineArtifact.stage_index.asc(), PipelineArtifact.created_at.asc())
    )
    return list(result.scalars().all())


async def _persist_artifact_manifest(
    *,
    db,
    conversation_uuid: uuid.UUID,
    result_payload: Mapping[str, Any],
    source: str,
) -> None:
    written_files = [str(path) for path in (result_payload.get("written_files") or []) if str(path or "").strip()]
    written_types = []
    for index, written_path in enumerate(written_files):
        path = Path(written_path)
        artifact_type = _artifact_type_for_suffix(path.suffix)
        if not artifact_type:
            continue
        written_types.append(artifact_type)
        metadata = {
            "source": source,
            "base_name": str(result_payload.get("base_name") or ""),
            "root_path": str(result_payload.get("root_path") or ""),
            "resolved_root_path": str(result_payload.get("resolved_root_path") or ""),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        existing_result = await db.execute(
            select(PipelineArtifact)
            .where(PipelineArtifact.conversation_id == conversation_uuid)
            .where(PipelineArtifact.stage == ARTIFACT_EXPORT_STAGE)
            .where(PipelineArtifact.artifact_type == artifact_type)
        )
        existing = existing_result.scalar_one_or_none()
        if existing is None:
            existing = PipelineArtifact(
                conversation_id=conversation_uuid,
                stage=ARTIFACT_EXPORT_STAGE,
                stage_index=index,
                artifact_type=artifact_type,
            )
            db.add(existing)
        existing.stage_index = index
        existing.artifact_path = written_path
        existing.artifact_metadata = metadata

    if written_types:
        await db.execute(
            delete(PipelineArtifact)
            .where(PipelineArtifact.conversation_id == conversation_uuid)
            .where(PipelineArtifact.stage == ARTIFACT_EXPORT_STAGE)
            .where(PipelineArtifact.artifact_type.notin_(written_types))
        )

    await db.commit()


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        logger.warning("Failed to delete superseded artifact file: %s", path, exc_info=True)


async def reroute_conversation_artifacts(
    *,
    db,
    conversation_id: str,
    settings: Mapping[str, Any],
) -> Dict[str, Any]:
    normalized = normalize_artifact_export_settings(settings)
    if not normalized.get("enabled"):
        return {
            "ok": True,
            "rerouted": False,
            "reason": "artifact_export_disabled",
            "conversation_id": str(conversation_id),
        }

    root = validate_artifact_export_settings(normalized, require_target=True)
    assert root is not None

    conversation_uuid = uuid.UUID(str(conversation_id))
    tracked_rows = await _load_tracked_artifact_rows(db=db, conversation_uuid=conversation_uuid)
    if not tracked_rows:
        return {
            "ok": True,
            "rerouted": False,
            "reason": "no_tracked_artifacts",
            "conversation_id": str(conversation_id),
        }

    tracked_suffixes = {
        _tracked_artifact_type_to_suffix(row.artifact_type)
        for row in tracked_rows
    }
    tracked_suffixes.discard(None)
    write_canvas = ".canvas" in tracked_suffixes
    write_transcript = ".txt" in tracked_suffixes

    payload = await build_export_artifacts_for_conversation(
        db=db,
        conversation_id=conversation_uuid,
        include_chunks=bool(normalized.get("include_chunks")),
    )
    target_root = _resolve_export_directory(
        root,
        utterances=payload.get("utterances") or [],
        self_name=str(normalized.get("self_name") or ""),
    )

    previous_paths = [Path(str(row.artifact_path)) for row in tracked_rows if str(row.artifact_path or "").strip()]
    base_name = _resolve_unique_base_name(
        target_root,
        payload["base_name"],
        write_canvas=write_canvas,
        write_transcript=write_transcript,
        exclude_paths=previous_paths,
    )
    canvas_path = target_root / f"{base_name}.canvas"
    transcript_path = target_root / f"{base_name}.txt"

    def _write() -> None:
        if write_canvas:
            _atomic_write_text(canvas_path, json.dumps(payload["canvas_data"], indent=2))
        if write_transcript:
            _atomic_write_text(transcript_path, str(payload["transcript_text"]))

    await asyncio.to_thread(_write)

    written_files: list[str] = []
    if write_canvas:
        written_files.append(str(canvas_path))
    if write_transcript:
        written_files.append(str(transcript_path))

    removed_files: list[str] = []
    written_set = set(written_files)
    for previous_path in previous_paths:
        previous_str = str(previous_path)
        if previous_str in written_set:
            continue
        _safe_unlink(previous_path)
        removed_files.append(previous_str)

    result_payload = {
        "ok": True,
        "rerouted": True,
        "root_path": str(root),
        "resolved_root_path": str(target_root),
        "base_name": base_name,
        "written_files": written_files,
        "removed_files": removed_files,
        "conversation_id": str(conversation_id),
        "include_chunks": bool(normalized.get("include_chunks")),
    }
    await _persist_artifact_manifest(
        db=db,
        conversation_uuid=conversation_uuid,
        result_payload=result_payload,
        source="reroute_after_speaker_naming",
    )
    logger.info(
        "Rerouted %d tracked artifacts for %s into %s (removed=%d)",
        len(written_files),
        conversation_id,
        target_root,
        len(removed_files),
    )
    return result_payload


async def auto_export_conversation_artifacts(
    *,
    db,
    conversation_id: str,
    settings: Mapping[str, Any],
) -> Dict[str, Any]:
    normalized = normalize_artifact_export_settings(settings)
    root = validate_artifact_export_settings(normalized, require_target=True)
    assert root is not None

    write_canvas = bool(normalized.get("write_canvas"))
    write_transcript = bool(normalized.get("write_transcript"))
    include_chunks = bool(normalized.get("include_chunks"))
    payload = await build_export_artifacts_for_conversation(
        db=db,
        conversation_id=conversation_id,
        include_chunks=include_chunks,
    )
    target_root = _resolve_export_directory(
        root,
        utterances=payload.get("utterances") or [],
        self_name=str(normalized.get("self_name") or ""),
    )

    base_name = _resolve_unique_base_name(
        target_root,
        payload["base_name"],
        write_canvas=write_canvas,
        write_transcript=write_transcript,
    )
    canvas_path = target_root / f"{base_name}.canvas"
    transcript_path = target_root / f"{base_name}.txt"

    def _write() -> None:
        if write_canvas:
            _atomic_write_text(canvas_path, json.dumps(payload["canvas_data"], indent=2))
        if write_transcript:
            _atomic_write_text(transcript_path, str(payload["transcript_text"]))

    await asyncio.to_thread(_write)

    written_files: list[str] = []
    if write_canvas:
        written_files.append(str(canvas_path))
    if write_transcript:
        written_files.append(str(transcript_path))

    logger.info(
        "Auto-exported %d conversation artifacts for %s into %s",
        len(written_files),
        conversation_id,
        root,
    )
    result_payload = {
        "ok": True,
        "root_path": str(root),
        "resolved_root_path": str(target_root),
        "base_name": base_name,
        "written_files": written_files,
        "conversation_id": str(conversation_id),
        "include_chunks": include_chunks,
    }
    await _persist_artifact_manifest(
        db=db,
        conversation_uuid=uuid.UUID(str(conversation_id)),
        result_payload=result_payload,
        source="auto_import_complete",
    )
    return result_payload

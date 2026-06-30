"""Checkpoint helpers for resumable import pipeline.

Uses the existing PipelineArtifact table to persist per-chunk STT results
so that long audio transcriptions can be resumed after connection drops.

Checkpoint layout (one row per completed STT chunk):
  stage        = "stt_checkpoint"
  stage_index  = chunk index (1-based)
  content_hash = SHA-256 of the uploaded file (stable across re-uploads)
  artifact_json = { "text": "...", "elapsed_ms": ..., "stt_backend": "..." }
  artifact_metadata = { "total_chunks": N, "file_name": "...", "file_size_bytes": ... }

A single "stt_checkpoint_manifest" row stores aggregate state:
  stage        = "stt_checkpoint_manifest"
  stage_index  = 0
  artifact_json = { "total_chunks": N, "completed_chunks": N, "transcript_text": "..." }
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import PipelineArtifact

logger = logging.getLogger(__name__)

STAGE_CHUNK = "stt_checkpoint"
STAGE_MANIFEST = "stt_checkpoint_manifest"


def compute_file_hash(file_path: Path, chunk_size: int = 65536) -> str:
    """Compute SHA-256 hash of a file for stable identification across re-uploads."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            sha256.update(data)
    return sha256.hexdigest()


async def find_checkpoint(
    db: AsyncSession,
    file_hash: str,
) -> Optional[dict[str, Any]]:
    """Look up an existing checkpoint manifest for a file hash.

    Returns dict with keys: conversation_id, total_chunks, completed_chunks,
    completed_chunk_texts (list of {index, text}), or None if no checkpoint.
    """
    result = await db.execute(
        select(PipelineArtifact)
        .where(PipelineArtifact.content_hash == file_hash)
        .where(PipelineArtifact.stage == STAGE_MANIFEST)
        .order_by(PipelineArtifact.created_at.desc())
        .limit(1)
    )
    manifest = result.scalar_one_or_none()
    if manifest is None:
        return None

    conversation_id = str(manifest.conversation_id) if manifest.conversation_id else None
    manifest_data = manifest.artifact_json or {}

    # Load individual chunk rows
    chunk_result = await db.execute(
        select(PipelineArtifact)
        .where(PipelineArtifact.content_hash == file_hash)
        .where(PipelineArtifact.stage == STAGE_CHUNK)
        .order_by(PipelineArtifact.stage_index.asc())
    )
    chunk_rows = chunk_result.scalars().all()
    completed_texts = []
    for row in chunk_rows:
        data = row.artifact_json or {}
        completed_texts.append({
            "index": row.stage_index,
            "text": data.get("text", ""),
        })

    return {
        "conversation_id": conversation_id,
        "total_chunks": manifest_data.get("total_chunks"),
        "completed_chunks": len(completed_texts),
        "completed_chunk_texts": completed_texts,
        "transcript_text": manifest_data.get("transcript_text", ""),
        "stt_backend": manifest_data.get("stt_backend", ""),
        "file_name": manifest_data.get("file_name", ""),
    }


async def save_chunk_checkpoint(
    db: AsyncSession,
    *,
    conversation_id: str,
    file_hash: str,
    chunk_index: int,
    total_chunks: int,
    chunk_text: str,
    accumulated_transcript: str,
    stt_backend: str = "",
    elapsed_ms: float = 0,
    file_name: str = "",
    file_size_bytes: int = 0,
) -> None:
    """Persist a single completed STT chunk and update the manifest.

    Called after each successful chunk transcription in the pipeline.
    Uses merge-style upsert: checks for existing row before inserting.
    """
    conv_uuid = uuid.UUID(conversation_id)

    # Upsert chunk row
    existing_chunk = await db.execute(
        select(PipelineArtifact)
        .where(PipelineArtifact.content_hash == file_hash)
        .where(PipelineArtifact.stage == STAGE_CHUNK)
        .where(PipelineArtifact.stage_index == chunk_index)
    )
    chunk_row = existing_chunk.scalar_one_or_none()
    if chunk_row is None:
        chunk_row = PipelineArtifact(
            id=uuid.uuid4(),
            conversation_id=conv_uuid,
            stage=STAGE_CHUNK,
            stage_index=chunk_index,
            content_hash=file_hash,
            artifact_type="stt_chunk",
            artifact_json={"text": chunk_text, "elapsed_ms": elapsed_ms, "stt_backend": stt_backend},
            artifact_metadata={"total_chunks": total_chunks, "file_name": file_name, "file_size_bytes": file_size_bytes},
        )
        db.add(chunk_row)
    else:
        chunk_row.artifact_json = {"text": chunk_text, "elapsed_ms": elapsed_ms, "stt_backend": stt_backend}

    # Upsert manifest row
    existing_manifest = await db.execute(
        select(PipelineArtifact)
        .where(PipelineArtifact.content_hash == file_hash)
        .where(PipelineArtifact.stage == STAGE_MANIFEST)
    )
    manifest_row = existing_manifest.scalar_one_or_none()
    manifest_json = {
        "total_chunks": total_chunks,
        "completed_chunks": chunk_index,
        "transcript_text": accumulated_transcript,
        "stt_backend": stt_backend,
        "file_name": file_name,
    }
    if manifest_row is None:
        manifest_row = PipelineArtifact(
            id=uuid.uuid4(),
            conversation_id=conv_uuid,
            stage=STAGE_MANIFEST,
            stage_index=0,
            content_hash=file_hash,
            artifact_type="stt_manifest",
            artifact_json=manifest_json,
            artifact_metadata={"file_size_bytes": file_size_bytes},
        )
        db.add(manifest_row)
    else:
        manifest_row.artifact_json = manifest_json
        manifest_row.conversation_id = conv_uuid

    await db.commit()
    logger.debug(
        "[CHECKPOINT] Saved chunk %d/%d for file_hash=%s conv=%s",
        chunk_index, total_chunks, file_hash[:12], conversation_id,
    )


async def clear_checkpoint(
    db: AsyncSession,
    file_hash: str,
) -> int:
    """Remove all checkpoint rows for a file hash (called after successful completion)."""
    result = await db.execute(
        delete(PipelineArtifact)
        .where(PipelineArtifact.content_hash == file_hash)
        .where(PipelineArtifact.stage.in_([STAGE_CHUNK, STAGE_MANIFEST]))
    )
    await db.commit()
    deleted = result.rowcount  # type: ignore[union-attr]
    if deleted:
        logger.info("[CHECKPOINT] Cleared %d checkpoint rows for file_hash=%s", deleted, file_hash[:12])
    return deleted

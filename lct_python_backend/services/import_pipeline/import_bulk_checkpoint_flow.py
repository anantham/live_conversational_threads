"""Checkpoint lookup, resume, and persistence for bulk import processing."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Node
from .import_bulk_helpers import coerce_checkpoint_total
from .import_bulk_stage_events import ImportBulkStageEvents
from .import_checkpoint import (
    clear_checkpoint,
    compute_file_hash,
    find_checkpoint,
    save_chunk_checkpoint,
)

logger = logging.getLogger(__name__)


@dataclass
class CheckpointFlowState:
    """Mutable checkpoint state threaded through the bulk import worker."""

    file_hash: Optional[str] = None
    existing_checkpoint: Optional[dict[str, Any]] = None
    checkpoint_transcript_parts: list[str] = field(default_factory=list)
    resume_from_chunk: int = 0
    resolved_conversation_id: str = ""
    cache_hit: bool = False


async def bootstrap_audio_checkpoint_flow(
    *,
    db: AsyncSession,
    temp_path: str,
    filename: str,
    content_size: int,
    conversation_id: str,
    is_likely_audio: bool,
    stt_backend: str,
    stage_events: ImportBulkStageEvents,
    telemetry: dict[str, Any],
    log: logging.Logger,
) -> CheckpointFlowState:
    """Hash the upload, resolve cache-hit / resume metadata, replay cached transcript SSE."""
    state = CheckpointFlowState(resolved_conversation_id=conversation_id)
    telemetry["checkpoint_chunks"] = 0
    telemetry["resume_available"] = False

    if not is_likely_audio:
        return state

    try:
        state.file_hash = compute_file_hash(Path(temp_path))
        telemetry["file_hash"] = state.file_hash
        state.existing_checkpoint = await find_checkpoint(db, state.file_hash)

        if state.existing_checkpoint and state.existing_checkpoint.get("conversation_id"):
            completed = int(state.existing_checkpoint.get("completed_chunks") or 0)
            total = int(state.existing_checkpoint.get("total_chunks") or 0)
            prior_conv = state.existing_checkpoint["conversation_id"]
            if total > 0 and completed >= total:
                node_count_row = await db.execute(
                    select(func.count(Node.id)).where(Node.conversation_id == prior_conv)
                )
                prior_node_count = int(node_count_row.scalar() or 0)
                if prior_node_count > 0:
                    log.info(
                        "[PROCESS FILE] STT cache HIT for %s: redirecting to existing "
                        "conversation %s (%d nodes, %d/%d chunks). Skipping STT+LLM.",
                        filename,
                        prior_conv,
                        prior_node_count,
                        completed,
                        total,
                    )
                    persisted_audio_path = None
                    try:
                        from lct_python_backend.stt_api import audio_storage

                        existing = audio_storage.get_status(prior_conv)
                        if not existing.get("has_source"):
                            persisted_audio_path = audio_storage.persist_source_audio(
                                prior_conv,
                                temp_path,
                                Path(temp_path).suffix.lower(),
                            )
                    except Exception as audio_exc:  # noqa: BLE001
                        log.warning(
                            "[PROCESS FILE] cache-hit audio backfill failed for %s: %s",
                            prior_conv,
                            audio_exc,
                        )
                    await stage_events.emit_cache_hit_done(
                        prior_conv=prior_conv,
                        prior_node_count=prior_node_count,
                        completed=completed,
                        total=total,
                        file_hash=state.file_hash,
                        persisted_audio_path=persisted_audio_path,
                    )
                    state.cache_hit = True
                    return state

        if state.existing_checkpoint and state.existing_checkpoint.get("conversation_id"):
            state.resolved_conversation_id = state.existing_checkpoint["conversation_id"]

        if state.existing_checkpoint and state.existing_checkpoint.get("completed_chunks", 0) > 0:
            state.resume_from_chunk = state.existing_checkpoint["completed_chunks"]
            telemetry["checkpoint_chunks"] = state.resume_from_chunk
            telemetry["resume_available"] = True
            checkpoint_total = coerce_checkpoint_total(state.existing_checkpoint, telemetry)
            if checkpoint_total is not None:
                telemetry["checkpoint_total_chunks"] = checkpoint_total
            state.checkpoint_transcript_parts = [
                ct["text"]
                for ct in state.existing_checkpoint.get("completed_chunk_texts", [])
                if ct.get("text")
            ]
            log.info(
                "[PROCESS FILE] Found checkpoint for %s: %d/%s chunks completed, resuming from chunk %d",
                filename,
                state.resume_from_chunk,
                state.existing_checkpoint.get("total_chunks", "?"),
                state.resume_from_chunk + 1,
            )
            await stage_events.emit_resume_checkpoint(
                resume_from_chunk=state.resume_from_chunk,
                checkpoint_total=checkpoint_total,
                stt_backend=stt_backend,
                is_likely_audio=is_likely_audio,
            )
            await stage_events.emit_checkpoint_transcript_replays(state.existing_checkpoint)

    except Exception as hash_exc:  # noqa: BLE001
        log.warning("[PROCESS FILE] Checkpoint lookup failed (non-fatal): %s", hash_exc)
        state.file_hash = None

    return state


async def persist_chunk_checkpoint_safe(
    db: AsyncSession,
    *,
    file_hash: Optional[str],
    conversation_id: str,
    chunk_index: int,
    total_chunks: int,
    chunk_text: str,
    accumulated_transcript: str,
    stt_backend: str,
    elapsed_ms: int,
    file_name: str,
    file_size_bytes: int,
    log: logging.Logger,
    failure_label: str = "Checkpoint save",
) -> None:
    if not file_hash or not chunk_text:
        return
    try:
        await save_chunk_checkpoint(
            db,
            conversation_id=conversation_id,
            file_hash=file_hash,
            chunk_index=chunk_index,
            total_chunks=total_chunks,
            chunk_text=chunk_text,
            accumulated_transcript=accumulated_transcript,
            stt_backend=stt_backend,
            elapsed_ms=elapsed_ms,
            file_name=file_name,
            file_size_bytes=file_size_bytes,
        )
    except Exception as ckpt_exc:  # noqa: BLE001
        log.warning("[PROCESS FILE] %s failed (non-fatal): %s", failure_label, ckpt_exc)


async def clear_import_checkpoint_safe(
    db: AsyncSession,
    file_hash: Optional[str],
    telemetry: dict[str, Any],
    log: logging.Logger,
) -> None:
    if not file_hash:
        return
    try:
        await clear_checkpoint(db, file_hash)
        telemetry["checkpoint_cleared"] = True
    except Exception as ckpt_clear_exc:  # noqa: BLE001
        log.warning("[PROCESS FILE] Checkpoint clear failed (non-fatal): %s", ckpt_clear_exc)
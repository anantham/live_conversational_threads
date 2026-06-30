"""
API endpoints for importing transcripts.

Thin router — delegates parsing/validation/persistence to ``import_orchestrator``
and source-specific helpers to ``import_validation`` / ``import_fetchers``.
"""

import logging
import os
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.import_schemas import (
    ExtractTurnsRequest,
    ImportFromTextRequest,
    ImportFromUrlRequest,
    ImportStatusResponse,
    ImportTurnsResponse,
    ParsedTranscriptResponse,
    ServiceHealthInfo,
    ServicesStatusResponse,
    UtteranceResponse,
    ValidationResponse,
)

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.owner_context import resolve_owner_id
from lct_python_backend.services.import_pipeline.import_fetchers import (
    download_url_text,
    save_upload_to_temp_file,
)
from lct_python_backend.services.import_pipeline.import_diarization_queue import (
    enqueue_import_diarization_job,
    get_import_diarization_job,
    get_import_diarization_job_events,
    is_async_import_diarization_enabled,
)
from lct_python_backend.services.import_pipeline.import_orchestrator import (
    extract_graph_for_conversation,
    parse_transcript,
    parse_validate_and_persist,
    validate_or_raise,
)
from lct_python_backend.services.graph_persistence import persist_turns
from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1
from lct_python_backend.services.import_pipeline.import_validation import (
    get_supported_import_formats,
    is_url_import_enabled,
    validate_import_url,
    validate_transcript_filename,
)
from lct_python_backend.services.import_pipeline.import_bulk_processor import (
    build_process_file_stream,
    cleanup_temp_file as cleanup_bulk_temp_file,
    copy_temp_upload_for_async_job as copy_bulk_temp_upload_for_async_job,
    diarization_job_urls as build_bulk_diarization_job_urls,
)
from lct_python_backend.services.file_transcriber import (
    chunk_transcript_lines,
    transcribe_audio_segmented,
    transcribe_uploaded_file,
)
from lct_python_backend.services.import_pipeline.import_graph_refinement import refine_import_graph_nodes
from lct_python_backend.services.llm_config import (
    load_llm_config,
    load_llm_providers as _db_load_llm_providers,
    get_env_llm_defaults,
)
from lct_python_backend.services.stt.stt_settings_service import load_stt_settings
from lct_python_backend.services.artifact_settings_service import load_artifact_export_settings
from lct_python_backend.services.artifact_export_service import auto_export_conversation_artifacts
from lct_python_backend.services.stt.stt_health_service import (
    derive_health_url_from_http_url,
    probe_health_url,
)
from lct_python_backend.services.transcript_processing import TranscriptProcessor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/import", tags=["import"])


def _is_url_import_enabled() -> bool:
    """Backward-compatible wrapper used by tests and existing imports."""
    return is_url_import_enabled()


def _validate_import_url(raw_url: str) -> str:
    """Backward-compatible wrapper used by tests and existing imports."""
    return validate_import_url(raw_url)


async def _download_url_text(url: str) -> str:
    """Backward-compatible wrapper used by tests and existing imports."""
    return await download_url_text(url)


def _is_async_import_diarization_enabled() -> bool:
    return is_async_import_diarization_enabled()


async def _enqueue_import_diarization_job(**kwargs):
    return await enqueue_import_diarization_job(**kwargs)


async def _get_import_diarization_job(job_id: str):
    return await get_import_diarization_job(job_id)


async def _get_import_diarization_job_events(job_id: str, *, cursor: int = 0):
    return await get_import_diarization_job_events(job_id, cursor=cursor)


def _cleanup_temp_file(temp_path: Optional[str]) -> None:
    cleanup_bulk_temp_file(temp_path, logger=logger)


def _copy_temp_upload_for_async_job(temp_path: Path, *, suffix: str) -> Path:
    return copy_bulk_temp_upload_for_async_job(temp_path, suffix=suffix)


def _diarization_job_urls(job_id: str) -> dict:
    return build_bulk_diarization_job_urls(job_id)


async def _probe_health_url_async(health_url: str, timeout_seconds: float) -> Dict[str, Any]:
    """Run blocking health probe in a worker thread to avoid event-loop stalls."""
    return await asyncio.to_thread(probe_health_url, health_url, timeout_seconds)


async def load_llm_providers(session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    """Runtime wrapper that preserves provider secrets for server-side execution."""
    return await _db_load_llm_providers(session, include_secrets=True)


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/google-meet", response_model=ImportStatusResponse)
async def import_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
    conversation_name: Optional[str] = Form(None, description="Name for this conversation"),
    owner_id: Optional[str] = Form(None, description="Owner/user ID"),
    db: AsyncSession = Depends(get_async_session),
):
    """Import a Google Meet transcript from PDF or TXT file."""
    file_ext = validate_transcript_filename(file.filename)

    temp_path = None
    try:
        temp_path, content_size = await save_upload_to_temp_file(file, file_ext)
        logger.info("Saved upload to %s (%s bytes)", temp_path, content_size)

        result = await parse_validate_and_persist(
            db, temp_path, is_file=True,
            source_type="google_meet",
            conversation_name=conversation_name or file.filename or "Google Meet Transcript",
            owner_id=resolve_owner_id(owner_id),
            metadata={"source_file": file.filename},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to import transcript: {exc}")
    finally:
        _cleanup_temp_file(temp_path)

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.post("/google-meet/preview", response_model=ParsedTranscriptResponse)
async def preview_google_meet_transcript(
    file: UploadFile = File(..., description="Google Meet transcript (PDF or TXT)"),
):
    """Preview/validate a Google Meet transcript without saving to database."""
    import uuid as _uuid

    file_ext = validate_transcript_filename(file.filename)

    temp_path = None
    try:
        temp_path, _ = await save_upload_to_temp_file(file, file_ext)
        parser, transcript = parse_transcript(temp_path, is_file=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected error during parsing: {exc}")
    finally:
        _cleanup_temp_file(temp_path)

    validation = parser.validate_transcript(transcript)

    sample_utterances = [
        UtteranceResponse(
            speaker=u.speaker, text=u.text,
            start_time=u.start_time, end_time=u.end_time,
            sequence_number=u.sequence_number,
        )
        for u in transcript.utterances[:10]
    ]

    return ParsedTranscriptResponse(
        conversation_id=str(_uuid.uuid4()),
        utterance_count=len(transcript.utterances),
        participant_count=len(transcript.participants),
        participants=transcript.participants,
        duration=transcript.duration,
        validation=ValidationResponse(
            is_valid=validation.is_valid,
            errors=validation.errors,
            warnings=validation.warnings,
            stats=validation.stats,
        ),
        sample_utterances=sample_utterances,
    )


@router.post("/from-url", response_model=ImportStatusResponse)
async def import_from_url(
    request: ImportFromUrlRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a transcript from a URL."""
    if not _is_url_import_enabled():
        raise HTTPException(
            status_code=403,
            detail="URL import is disabled. Set ENABLE_URL_IMPORT=true to enable (SSRF risk — only for trusted networks).",
        )

    validated_url = _validate_import_url(request.url)
    content = await _download_url_text(validated_url)

    try:
        result = await parse_validate_and_persist(
            db, content, is_file=False,
            source_type="url",
            conversation_name=request.conversation_name or f"Transcript from {validated_url}",
            owner_id=resolve_owner_id(request.owner_id),
            metadata={"source_url": validated_url},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("URL import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {exc}")

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.post("/from-text", response_model=ImportStatusResponse)
async def import_from_text(
    request: ImportFromTextRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a transcript from pasted text."""
    try:
        result = await parse_validate_and_persist(
            db, request.text, is_file=False,
            source_type="text",
            conversation_name=request.conversation_name or "Pasted Transcript",
            owner_id=resolve_owner_id(request.owner_id),
            metadata={"source": "pasted_text"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Text import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save to database: {exc}")

    return ImportStatusResponse(
        success=True,
        conversation_id=result.conversation_id,
        message=f"Successfully imported transcript with {result.utterance_count} utterances",
        utterance_count=result.utterance_count,
        participant_count=result.participant_count,
    )


@router.post("/turns/extract", response_model=ImportTurnsResponse)
async def extract_turns(
    request: ExtractTurnsRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Phase 2 of the structured RawTurn pipeline: build the auditable graph from
    turns already persisted by ``POST /api/import/turns``.

    Separating persist (idempotent mirror) from extract (the LLM pass) makes
    extraction re-runnable WITHOUT IndrasNet re-sending the turns — re-extract a
    conversation (e.g. with a better model) by POSTing its ``conversation_id`` or
    ``group_id`` again. Utterance UUIDs are authored at persist time and threaded
    onto ``node.utterance_ids`` here, so every node is auditable to its raw turns.
    Owner-scoped (AUTH_TOKEN). Runs synchronously — the graph is destructively
    re-materialized; the persisted turns are left untouched.
    """
    try:
        stats = await extract_graph_for_conversation(
            db,
            conversation_id=request.conversation_id,
            group_id=request.group_id,
            owner_id=resolve_owner_id(request.owner_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Structured turn extraction failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to extract turns: {exc}")

    return ImportTurnsResponse(
        success=True,
        conversation_id=stats["conversation_id"],
        utterance_count=stats["utterance_count"],
        node_count=stats["node_count"],
        auditable_node_count=stats["auditable_node_count"],
        indrasnet_group_id=stats.get("indrasnet_group_id"),
        message=(
            f"Extracted {stats['node_count']} nodes from {stats['utterance_count']} turns "
            f"({stats['auditable_node_count']} auditable)"
        ),
    )


@router.post("/turns", response_model=ImportStatusResponse)
async def import_turns(
    request: RawTurnsPayloadV1,
    db: AsyncSession = Depends(get_async_session),
):
    """Import a conversation as a structured ``RawTurn[]`` payload (P1).

    The provenance-bearing ingest that replaces the lossy markdown ``/from-text``
    for IndrasNet pushes: each turn becomes an ``Utterance`` carrying a stable
    ``source_identifier``; re-pushing the same ``group_id`` replaces the
    conversation in place (stable ``conversation_id``). Contract + rationale:
    docs/plans/2026-06-17-p1-rawturn-data-contract.md.
    """
    try:
        result = await persist_turns(db=db, payload=request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("RawTurn import failed: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save turns: {exc}")

    return ImportStatusResponse(
        success=True,
        conversation_id=result["conversation_id"],
        message=f"Imported {result['utterance_count']} turns ({result['participant_count']} speakers)",
        utterance_count=result["utterance_count"],
        participant_count=result["participant_count"],
    )


@router.get("/health")
async def health_check():
    """Health check endpoint for import API."""
    url_import_enabled = _is_url_import_enabled()
    supported_formats = get_supported_import_formats(url_import_enabled)
    return {
        "status": "healthy",
        "service": "import_api",
        "url_import_enabled": url_import_enabled,
        "supported_formats": supported_formats,
        "timestamp": datetime.now().isoformat(),
    }


@router.get("/status", response_model=ServicesStatusResponse)
async def get_services_status(
    db: AsyncSession = Depends(get_async_session),
):
    """Get health status of STT and LLM backend services.

    Returns status of:
    - whisperx: Local WhisperX via IndrasNet orchestrator
    - modal_whisperx: Modal WhisperX fallback
    - llm: Active LLM backend (local or Modal)
    """
    # Get config settings
    llm_config = await load_llm_config(db)
    stt_settings = await load_stt_settings(db)

    services: Dict[str, ServiceHealthInfo] = {}

    # ── Resolve the Whisper HTTP endpoint from STT settings ─────────────────
    # In practice http_url is the configured IndrasNet orchestrator over
    # Tailscale (default 100.81.65.74:7777, see indrasnet_client.py /
    # docs/INDRASNET_INTEGRATION.md). The 127.0.0.1:7777 literal is only a
    # last-resort fallback for a co-located IndrasNet; it is NOT "local WhisperX".
    local_stt_url = stt_settings.get("http_url", "http://127.0.0.1:7777/api/transcribe")
    local_stt_health_url = derive_health_url_from_http_url(local_stt_url)
    if not local_stt_health_url:
        local_stt_health_url = local_stt_url.rstrip("/") + "/health"
    local_stt_probe_task = asyncio.create_task(
        _probe_health_url_async(local_stt_health_url, timeout_seconds=5.0)
    )

    # ── Check Modal WhisperX fallback ───────────────────────────────────────
    modal_whisperx_url = os.getenv("MODAL_WHISPERX_URL", "https://adityaarpitha--whisperx-server-serve.modal.run")
    modal_stt_probe_task = None
    if modal_whisperx_url:
        modal_whisperx_health_url = modal_whisperx_url.rstrip("/") + "/health"
        modal_stt_probe_task = asyncio.create_task(
            _probe_health_url_async(modal_whisperx_health_url, timeout_seconds=10.0)
        )

    local_stt_probe = await local_stt_probe_task
    services["whisperx"] = ServiceHealthInfo(
        healthy=local_stt_probe["ok"],
        backend="local",
        latency_ms=int(local_stt_probe["latency_ms"]) if local_stt_probe["latency_ms"] else None,
        url=local_stt_url,
        error=local_stt_probe.get("error"),
    )
    if modal_stt_probe_task is not None:
        modal_stt_probe = await modal_stt_probe_task
        services["modal_whisperx"] = ServiceHealthInfo(
            healthy=modal_stt_probe["ok"],
            backend="modal",
            latency_ms=int(modal_stt_probe["latency_ms"]) if modal_stt_probe["latency_ms"] else None,
            url=modal_whisperx_url,
            error=modal_stt_probe.get("error"),
        )

    # ── Check LLM backend ───────────────────────────────────────────────────
    llm_base_url = llm_config.get("base_url", "")
    llm_model = llm_config.get("chat_model", "")
    llm_mode = llm_config.get("mode", "local")

    # Determine if using Modal or local based on URL
    is_modal_llm = "modal.run" in llm_base_url
    llm_backend_type = "modal" if is_modal_llm else "local"

    # Health check URL for vLLM/LM Studio
    llm_health_url = llm_base_url.rstrip("/") + "/health"
    llm_probe = await _probe_health_url_async(llm_health_url, timeout_seconds=10.0)

    services["llm"] = ServiceHealthInfo(
        healthy=llm_probe["ok"],
        backend=llm_backend_type,
        latency_ms=int(llm_probe["latency_ms"]) if llm_probe["latency_ms"] else None,
        url=llm_base_url,
        model=llm_model,
        error=llm_probe.get("error"),
    )

    # ── Determine active backends ───────────────────────────────────────────
    # STT: prefer local if healthy, else Modal
    if services["whisperx"].healthy:
        active_stt = "local_whisperx"
    elif services.get("modal_whisperx", ServiceHealthInfo(healthy=False, backend="modal")).healthy:
        active_stt = "modal_whisperx"
    else:
        active_stt = "unavailable"

    # LLM: use what's configured
    if services["llm"].healthy:
        active_llm = f"{llm_backend_type}_{llm_model}" if llm_model else llm_backend_type
    else:
        active_llm = "unavailable"

    return ServicesStatusResponse(
        services=services,
        active_stt_backend=active_stt,
        active_llm_backend=active_llm,
        timestamp=datetime.now().isoformat(),
    )


@router.get("/diarization-jobs/{job_id}")
async def get_diarization_job_status(job_id: str):
    """Get status/telemetry snapshot for an async diarization job."""
    snapshot = await _get_import_diarization_job(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"Diarization job not found: {job_id}")
    return snapshot


@router.get("/diarization-jobs/{job_id}/events")
async def get_diarization_job_events(job_id: str, cursor: int = 0):
    """Get incremental events for an async diarization job."""
    if cursor < 0:
        raise HTTPException(status_code=400, detail="cursor must be >= 0")
    snapshot = await _get_import_diarization_job_events(job_id, cursor=cursor)
    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"Diarization job not found: {job_id}")
    return snapshot


_ALLOWED_AUDIO_SUFFIXES = frozenset({
    ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4",
})
_ALLOWED_TEXT_SUFFIXES = frozenset({
    ".txt", ".md", ".markdown", ".json", ".html", ".htm", ".vtt", ".srt",
})
_ALLOWED_UPLOAD_SUFFIXES = _ALLOWED_AUDIO_SUFFIXES | _ALLOWED_TEXT_SUFFIXES
_ALLOWED_UPLOAD_CONTENT_TYPES = frozenset({
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/mpeg", "audio/mp3",
    "audio/mp4", "audio/x-m4a", "audio/m4a",
    "audio/ogg", "audio/flac", "audio/x-flac",
    "audio/aac", "audio/webm",
    "video/mp4", "video/webm",
    "text/plain", "text/markdown", "text/html",
    "application/json", "application/octet-stream",
})


def _validate_upload_file(file: UploadFile) -> None:
    """Reject uploads whose declared content-type and filename suffix are
    both outside the allowed set. Accepts either signal individually so
    clients that omit one don't get false 400s."""
    filename = (file.filename or "").strip()
    suffix = Path(filename).suffix.lower() if filename else ""
    suffix_ok = suffix in _ALLOWED_UPLOAD_SUFFIXES

    content_type = (file.content_type or "").strip().lower()
    # Strip any "; charset=..." parameter
    base_ct = content_type.split(";", 1)[0].strip()
    ct_ok = base_ct in _ALLOWED_UPLOAD_CONTENT_TYPES or base_ct.startswith("audio/")

    if suffix_ok or ct_ok:
        return

    raise HTTPException(
        status_code=400,
        detail=(
            f"Unsupported upload type: filename={filename!r}, "
            f"content_type={content_type!r}. Allowed audio suffixes: "
            f"{sorted(_ALLOWED_AUDIO_SUFFIXES)}; text: {sorted(_ALLOWED_TEXT_SUFFIXES)}."
        ),
    )


@router.post("/process-file")
async def process_file(
    request: Request,
    file: UploadFile = File(..., description="Audio/text transcript file"),
    source_type: str = Form("auto"),
    conversation_id: Optional[str] = Form(None),
    speaker_id: Optional[str] = Form(None),
    provider: Optional[str] = Form(None),
    byok_session_token: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_async_session),
):
    """Process uploaded file through STT/parsing + transcript-to-graph pipeline.

    Streams SSE events:
    - status
    - transcript
    - graph (existing_json/chunk_dict)
    - done / error
    """
    _validate_upload_file(file)
    return await build_process_file_stream(
        request=request,
        file=file,
        source_type=source_type,
        conversation_id=conversation_id,
        speaker_id=speaker_id,
        provider=provider,
        byok_session_token=byok_session_token,
        db=db,
        save_upload_to_temp_file=save_upload_to_temp_file,
        load_stt_settings=load_stt_settings,
        load_artifact_export_settings=load_artifact_export_settings,
        load_llm_config=load_llm_config,
        load_llm_providers=load_llm_providers,
        transcribe_uploaded_file=transcribe_uploaded_file,
        transcribe_audio_segmented=transcribe_audio_segmented,
        chunk_transcript_lines=chunk_transcript_lines,
        transcript_processor_cls=TranscriptProcessor,
        refine_import_graph_nodes=refine_import_graph_nodes,
        auto_export_conversation_artifacts=auto_export_conversation_artifacts,
        is_async_import_diarization_enabled=_is_async_import_diarization_enabled,
        enqueue_import_diarization_job=_enqueue_import_diarization_job,
        copy_temp_upload_for_async_job=_copy_temp_upload_for_async_job,
        cleanup_temp_file=_cleanup_temp_file,
        build_diarization_job_urls=_diarization_job_urls,
        logger=logger,
    )

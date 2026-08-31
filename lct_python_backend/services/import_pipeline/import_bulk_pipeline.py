"""Core worker pipeline for /api/import/process-file SSE processing."""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Optional

from fastapi import Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.graph_persistence import ensure_conversation_row
from .import_bulk_artifact_export import run_import_artifact_export
from .import_bulk_diarization_enqueue import (
    enqueue_async_diarization_if_enabled,
)
from .import_bulk_graph_refinement import run_import_graph_refinement
from .import_bulk_persistence import (
    derive_conversation_name,
    persist_import_pipeline_results,
    run_hierarchy_consolidation,
    stitch_utterance_chunk_ids,
)
from .import_bulk_graph_pass import (
    ProgressiveChunkHandlers,
    run_segmented_graph_pass,
    run_sequential_graph_pass,
    should_use_segmented_processing,
)
from .import_bulk_helpers import (
    AUDIO_SUFFIXES as _AUDIO_SUFFIXES,
    SEGMENT_PROCESSING_THRESHOLD_BYTES,
    coerce_checkpoint_total as _coerce_checkpoint_total,
    format_duration_for_display as _format_duration_for_display,
    get_audio_duration_ms as _get_audio_duration_ms,
    is_retryable_import_failure as _is_retryable_import_failure,
    resolve_candidate_backend_label as _candidate_backend_label,
    resolve_llm_backend_label as _resolve_llm_backend_label,
)
from .import_bulk_checkpoint_flow import bootstrap_audio_checkpoint_flow
from .import_bulk_stage_events import ImportBulkStageEvents
from .import_bulk_telemetry import (
    attach_bottleneck_stage,
    elapsed_ms,
    estimate_initial_eta_ms,
)

from .import_bulk_byok import (
    apply_llm_byok_overlay,
    apply_stt_byok_overlay,
    resolve_stt_byok_session,
)
from lct_python_backend.services.provider_selection import resolve_import_audio_candidates


async def run_bulk_processing_worker(
    *,
    request: Request,
    file: UploadFile,
    source_type: str,
    conversation_id: Optional[str],
    speaker_id: Optional[str],
    provider: Optional[str],
    byok_session_token: Optional[str],
    db: AsyncSession,
    temp_path: str,
    content_size: int,
    emit: Callable[[str, dict[str, Any]], Awaitable[None]],
    load_stt_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_artifact_export_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_config: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    load_llm_providers: Optional[Callable[[AsyncSession], Awaitable[dict[str, Any]]]] = None,
    transcribe_uploaded_file: Callable[..., Awaitable[Any]],
    transcribe_audio_segmented: Optional[Callable[..., AsyncGenerator[Any, None]]] = None,
    chunk_transcript_lines: Callable[[str], list[str]],
    transcript_processor_cls: Callable[..., Any],
    refine_import_graph_nodes: Callable[..., Awaitable[dict[str, Any]]],
    auto_export_conversation_artifacts: Callable[..., Awaitable[dict[str, Any]]],
    is_async_import_diarization_enabled: Callable[[], bool],
    enqueue_import_diarization_job: Callable[..., Awaitable[dict[str, Any]]],
    copy_temp_upload_for_async_job: Callable[..., Path],
    cleanup_temp_file: Callable[[Optional[str]], None],
    build_diarization_job_urls: Callable[[str], dict[str, str]],
    logger: logging.Logger,
) -> None:
    """Execute bulk upload pipeline and emit SSE payloads."""
    filename = file.filename or "upload.bin"
    suffix = Path(filename).suffix.lower() or ".bin"
    resolved_conversation_id = conversation_id or str(uuid.uuid4())
    resolved_speaker_id = speaker_id or "speaker_1"
    pipeline_started_at = time.perf_counter()
    transcription_started_at: Optional[float] = None
    graph_started_at: Optional[float] = None
    active_stage = "uploading"
    existing_checkpoint: Optional[dict[str, Any]] = None

    logger.info(
        "[PROCESS FILE] Starting pipeline for %s (%d bytes, source_type=%s, provider=%s)",
        filename,
        content_size,
        source_type,
        provider or "auto",
    )

    telemetry: dict[str, Any] = {
        "file_name": filename,
        "file_size_bytes": content_size,
    }
    stage_events = ImportBulkStageEvents(
        emit=emit,
        pipeline_started_at=pipeline_started_at,
        telemetry=telemetry,
    )

    try:
        await stage_events.emit_upload_received(filename=filename, content_size=content_size)

        stt_settings = await load_stt_settings(db)
        byok_session = resolve_stt_byok_session(byok_session_token)
        runtime_stt_settings, provider_override = apply_stt_byok_overlay(
            stt_settings,
            byok_session,
            provider,
        )

        import_candidates = resolve_import_audio_candidates(
            settings=runtime_stt_settings,
            provider_override=provider_override,
        )
        primary_import_candidate = import_candidates[0] if import_candidates else None
        stt_http_url = str(
            (primary_import_candidate or {}).get("http_url")
            or (primary_import_candidate or {}).get("base_url")
            or ""
        ).strip()
        stt_backend = _candidate_backend_label(primary_import_candidate, stt_http_url)
        telemetry["stt_backend"] = stt_backend
        telemetry["stt_http_url"] = stt_http_url
        if isinstance(primary_import_candidate, dict):
            telemetry["stt_candidate_provider"] = str(primary_import_candidate.get("provider") or "")
            telemetry["stt_candidate_transport"] = str(primary_import_candidate.get("transport") or "")
            telemetry["stt_authority_id"] = str(primary_import_candidate.get("authority_id") or "")
            telemetry["stt_authority_scope"] = str(primary_import_candidate.get("authority_scope") or "")

        # Emit progress before the (potentially slow) transcription call.
        resolved_source_type = source_type if source_type != "auto" else None
        is_likely_audio = (
            resolved_source_type == "audio"
            or (resolved_source_type is None and suffix in _AUDIO_SUFFIXES)
        )
        if is_likely_audio and not import_candidates:
            raise ValueError(
                "No approved local STT authority is enabled. Enable the M5 or Asus "
                "authority, or start a validated BYOK session for this import."
            )
        active_stage = "transcribing" if is_likely_audio else "parsing"
        telemetry["is_likely_audio"] = is_likely_audio
        telemetry["source_type_override"] = resolved_source_type or "auto"

        # Detect audio duration for better progress feedback
        audio_duration_ms: Optional[float] = None
        if is_likely_audio:
            audio_duration_ms = _get_audio_duration_ms(Path(temp_path))
            telemetry["audio_duration_ms"] = audio_duration_ms

        checkpoint_state = await bootstrap_audio_checkpoint_flow(
            db=db,
            temp_path=temp_path,
            filename=filename,
            content_size=content_size,
            conversation_id=resolved_conversation_id,
            is_likely_audio=is_likely_audio,
            stt_backend=stt_backend,
            stage_events=stage_events,
            telemetry=telemetry,
            log=logger,
        )
        if checkpoint_state.cache_hit:
            return
        file_hash = checkpoint_state.file_hash
        existing_checkpoint = checkpoint_state.existing_checkpoint
        checkpoint_transcript_parts = checkpoint_state.checkpoint_transcript_parts
        resume_from_chunk = checkpoint_state.resume_from_chunk
        resolved_conversation_id = checkpoint_state.resolved_conversation_id

        # Materialize the parent conversation row up front so that
        # pipeline_artifacts (checkpoint manifest, ADR-030 §D9 telemetry, etc.)
        # have a valid FK to point at. Without this the FK-violation on every
        # streaming write silently rolls back the checkpoint, breaking resume.
        try:
            inserted = await ensure_conversation_row(
                db=db,
                conversation_id=resolved_conversation_id,
                conversation_name=Path(filename).stem or None,
                source_type="audio" if is_likely_audio else "transcript",
                source_metadata={"file_name": filename, "file_size_bytes": content_size},
            )
            if inserted:
                logger.info(
                    "[PROCESS FILE] Materialized conversation row %s for %s",
                    resolved_conversation_id, filename,
                )
        except Exception as ensure_exc:  # noqa: BLE001
            logger.warning(
                "[PROCESS FILE] Early conversation row creation failed (non-fatal): %s",
                ensure_exc,
            )

        # Empirical initial ETA from past transcription timings
        initial_eta_ms: Optional[float] = None
        if is_likely_audio and audio_duration_ms and stt_backend:
            initial_eta_ms = estimate_initial_eta_ms(
                stt_backend=stt_backend,
                audio_duration_ms=audio_duration_ms,
            )
            if initial_eta_ms is not None:
                telemetry["initial_eta_ms"] = initial_eta_ms

        # Build transcription message with duration if available
        duration_str = _format_duration_for_display(audio_duration_ms)
        if is_likely_audio and duration_str:
            transcribe_msg = f"Transcribing {duration_str} of audio..."
        elif is_likely_audio:
            transcribe_msg = "Transcribing audio..."
        else:
            transcribe_msg = "Extracting transcript text..."

        await stage_events.emit_transcription_start(
            is_likely_audio=is_likely_audio,
            transcribe_msg=transcribe_msg,
            stt_backend=stt_backend,
            stt_http_url=stt_http_url,
            audio_duration_ms=audio_duration_ms,
            initial_eta_ms=initial_eta_ms,
        )
        transcription_started_at = time.perf_counter()

        progressive_processor_ref: list = []

        use_segmented_processing = should_use_segmented_processing(
            is_likely_audio=is_likely_audio,
            content_size=content_size,
            transcribe_audio_segmented=transcribe_audio_segmented,
            primary_import_candidate=primary_import_candidate,
        )
        telemetry["segmented_processing"] = use_segmented_processing

        if use_segmented_processing:
            logger.info(
                "[PROCESS FILE] Using interleaved segmented processing for %s (%d bytes, threshold=%d)",
                filename,
                content_size,
                SEGMENT_PROCESSING_THRESHOLD_BYTES,
            )
        else:
            logger.info(
                "[PROCESS FILE] Using sequential processing for %s (%d bytes, is_audio=%s, segmented_fn=%s)",
                filename,
                content_size,
                is_likely_audio,
                transcribe_audio_segmented is not None,
            )

        llm_config = await load_llm_config(db)
        llm_providers: list[dict[str, Any]] = []
        # Load LLM providers for fallback support
        if load_llm_providers:
            llm_providers_config = await load_llm_providers(db)
            providers = llm_providers_config.get("providers")
            if isinstance(providers, list):
                llm_providers = providers

        runtime_llm_config, runtime_llm_providers = apply_llm_byok_overlay(
            llm_config,
            llm_providers,
            byok_session,
        )

        # Determine LLM backend for UI indicators (will be updated by processor)
        llm_backend = _resolve_llm_backend_label(runtime_llm_config, runtime_llm_providers)
        telemetry["llm_backend"] = llm_backend

        processor = transcript_processor_cls(
            send_update=stage_events.send_graph_update,
            send_status=stage_events.send_analysis_status,
            llm_config=runtime_llm_config,
            providers=runtime_llm_providers,
        )
        # Enable progressive graph generation during STT phase
        progressive_processor_ref.append(processor)
        graph_started_at = time.perf_counter()

        progressive_handlers = ProgressiveChunkHandlers(
            stage_events=stage_events,
            telemetry=telemetry,
            db=db,
            file_hash=file_hash,
            conversation_id=resolved_conversation_id,
            filename=filename,
            content_size=content_size,
            checkpoint_transcript_parts=checkpoint_transcript_parts,
            progressive_processor_ref=progressive_processor_ref,
            transcription_started_at=transcription_started_at,
            log=logger,
        )

        if use_segmented_processing:
            graph_pass_result = await run_segmented_graph_pass(
                request=request,
                temp_path=temp_path,
                runtime_stt_settings=runtime_stt_settings,
                stt_candidates=import_candidates,
                transcribe_audio_segmented=transcribe_audio_segmented,
                resume_from_chunk=resume_from_chunk,
                checkpoint_transcript_parts=checkpoint_transcript_parts,
                file_hash=file_hash,
                conversation_id=resolved_conversation_id,
                filename=filename,
                content_size=content_size,
                db=db,
                stage_events=stage_events,
                telemetry=telemetry,
                pipeline_started_at=pipeline_started_at,
                transcription_started_at=transcription_started_at,
                audio_duration_ms=audio_duration_ms,
                stt_backend=stt_backend,
                processor=processor,
                llm_backend=llm_backend,
                chunk_transcript_lines=chunk_transcript_lines,
                log=logger,
            )
        else:
            graph_pass_result = await run_sequential_graph_pass(
                request=request,
                file=file,
                temp_path=temp_path,
                filename=filename,
                resolved_source_type=resolved_source_type,
                provider_override=provider_override,
                runtime_stt_settings=runtime_stt_settings,
                is_likely_audio=is_likely_audio,
                resume_from_chunk=resume_from_chunk,
                checkpoint_transcript_parts=checkpoint_transcript_parts,
                transcribe_uploaded_file=transcribe_uploaded_file,
                progressive_handlers=progressive_handlers,
                processor=processor,
                llm_backend=llm_backend,
                chunk_transcript_lines=chunk_transcript_lines,
                stage_events=stage_events,
                emit=emit,
                telemetry=telemetry,
                pipeline_started_at=pipeline_started_at,
                transcription_started_at=transcription_started_at,
                graph_started_at=graph_started_at,
                audio_duration_ms=audio_duration_ms,
            )

        if graph_pass_result.early_exit:
            return

        active_stage = graph_pass_result.active_stage
        final_source_type = graph_pass_result.final_source_type
        final_source_metadata = graph_pass_result.final_source_metadata
        final_source_utterances = graph_pass_result.final_source_utterances
        final_speaker_segments = graph_pass_result.final_speaker_segments
        final_transcript_text = graph_pass_result.final_transcript_text

        await run_import_graph_refinement(
            processor=processor,
            final_source_utterances=final_source_utterances,
            final_transcript_text=final_transcript_text,
            runtime_llm_config=runtime_llm_config,
            runtime_llm_providers=runtime_llm_providers,
            refine_import_graph_nodes=refine_import_graph_nodes,
            stage_events=stage_events,
            emit=emit,
            telemetry=telemetry,
            pipeline_started_at=pipeline_started_at,
            conversation_id=resolved_conversation_id,
            log=logger,
        )

        conversation_title_from_arcs, executive_summary = await run_hierarchy_consolidation(
            processor=processor,
            runtime_llm_providers=runtime_llm_providers,
            stage_events=stage_events,
            telemetry=telemetry,
            log=logger,
        )

        derived_name = derive_conversation_name(
            processor.existing_json,
            Path(filename).stem or "Imported conversation",
        )
        if conversation_title_from_arcs:
            derived_name = conversation_title_from_arcs
            telemetry["conversation_title_source"] = "arcs_consolidation"

        stitch_utterance_chunk_ids(
            processor=processor,
            final_source_utterances=final_source_utterances,
            telemetry=telemetry,
            conversation_id=resolved_conversation_id,
            log=logger,
        )

        await persist_import_pipeline_results(
            db=db,
            processor=processor,
            conversation_id=resolved_conversation_id,
            filename=filename,
            temp_path=temp_path,
            file_hash=file_hash,
            final_source_type=final_source_type,
            final_source_metadata=final_source_metadata,
            final_source_utterances=final_source_utterances,
            final_speaker_segments=final_speaker_segments,
            derived_name=derived_name,
            executive_summary=executive_summary,
            conversation_title_from_arcs=conversation_title_from_arcs,
            telemetry=telemetry,
            log=logger,
        )

        artifact_export_payload = await run_import_artifact_export(
            db=db,
            conversation_id=resolved_conversation_id,
            load_artifact_export_settings=load_artifact_export_settings,
            auto_export_conversation_artifacts=auto_export_conversation_artifacts,
            emit=emit,
            telemetry=telemetry,
            pipeline_started_at=pipeline_started_at,
            log=logger,
        )

        telemetry["graph_generation_ms"] = (
            elapsed_ms(graph_started_at)
            if graph_started_at is not None
            else None
        )
        telemetry["total_processing_ms"] = elapsed_ms(pipeline_started_at)
        telemetry["source_type"] = final_source_type
        telemetry["source_metadata"] = final_source_metadata
        telemetry["node_count"] = len(processor.existing_json)
        telemetry["chunk_count"] = len(processor.chunk_dict)
        attach_bottleneck_stage(telemetry)

        logger.info(
            "[PROCESS FILE TELEMETRY] %s",
            json.dumps(telemetry, ensure_ascii=False, sort_keys=True),
        )

        diarization_job_payload = await enqueue_async_diarization_if_enabled(
            final_source_type=final_source_type,
            is_async_import_diarization_enabled=is_async_import_diarization_enabled,
            copy_temp_upload_for_async_job=copy_temp_upload_for_async_job,
            enqueue_import_diarization_job=enqueue_import_diarization_job,
            build_diarization_job_urls=build_diarization_job_urls,
            cleanup_temp_file=cleanup_temp_file,
            emit=emit,
            temp_path=temp_path,
            suffix=suffix,
            filename=filename,
            content_type=file.content_type,
            resolved_source_type=resolved_source_type,
            provider_override=provider_override,
            conversation_id=resolved_conversation_id,
            speaker_id=resolved_speaker_id,
            runtime_stt_settings=runtime_stt_settings,
            llm_config=llm_config,
            final_source_metadata=final_source_metadata,
            telemetry=telemetry,
            pipeline_started_at=pipeline_started_at,
            log=logger,
        )

        await stage_events.emit_done(
            {
                "conversation_id": resolved_conversation_id,
                "speaker_id": resolved_speaker_id,
                "node_count": len(processor.existing_json),
                "chunk_count": len(processor.chunk_dict),
                "source_type": final_source_type,
                "file_name": derived_name,
                "telemetry": telemetry,
                "artifact_export": artifact_export_payload,
                "diarization_job": diarization_job_payload,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Bulk file processing failed for %s", filename)
        err_msg = str(exc) or f"{type(exc).__name__}"
        checkpoint_chunks = int(telemetry.get("checkpoint_chunks") or 0)
        checkpoint_total_chunks = _coerce_checkpoint_total(existing_checkpoint, telemetry)
        retryable = _is_retryable_import_failure(exc, active_stage=active_stage)
        resume_available = checkpoint_chunks > 0
        error_telemetry = {
            **telemetry,
            "active_stage": active_stage,
            "failure_stage": active_stage,
            "retryable": retryable,
            "resume_available": resume_available,
            "checkpoint_chunks": checkpoint_chunks,
            "checkpoint_total_chunks": checkpoint_total_chunks,
            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
        }
        await stage_events.emit_pipeline_error(
            err_msg=err_msg,
            filename=filename,
            conversation_id=resolved_conversation_id,
            active_stage=active_stage,
            retryable=retryable,
            resume_available=resume_available,
            checkpoint_chunks=checkpoint_chunks,
            checkpoint_total_chunks=checkpoint_total_chunks,
            error_telemetry=error_telemetry,
        )

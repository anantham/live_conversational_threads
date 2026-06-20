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

from lct_python_backend.services.hierarchy_consolidator import (
    consolidate_ideas_to_topics,
    consolidate_topics_to_themes,
    consolidate_themes_to_arcs,
)
from lct_python_backend.services.graph_persistence import (
    ensure_conversation_row,
    persist_graph as persist_import_graph,
)
from lct_python_backend.services.import_bulk_helpers import (
    AUDIO_SUFFIXES as _AUDIO_SUFFIXES,
    SEGMENT_PROCESSING_FORCE_ENABLED,
    SEGMENT_PROCESSING_THRESHOLD_BYTES,
    coerce_checkpoint_total as _coerce_checkpoint_total,
    format_duration_for_display as _format_duration_for_display,
    get_audio_duration_ms as _get_audio_duration_ms,
    is_retryable_import_failure as _is_retryable_import_failure,
    resolve_candidate_backend_label as _candidate_backend_label,
    resolve_llm_backend_label as _resolve_llm_backend_label,
)
from lct_python_backend.services.import_bulk_checkpoint_flow import (
    bootstrap_audio_checkpoint_flow,
    clear_import_checkpoint_safe,
    persist_chunk_checkpoint_safe,
)
from lct_python_backend.services.import_bulk_stage_events import ImportBulkStageEvents
from lct_python_backend.services.import_bulk_telemetry import (
    attach_bottleneck_stage,
    calculate_segmented_progress,
    elapsed_ms,
    estimate_analysis_eta_ms,
    estimate_initial_eta_ms,
    estimate_segment_eta_ms,
    estimate_transcription_eta_ms,
    record_transcription_timing,
)

from lct_python_backend.services.import_bulk_byok import (
    apply_llm_byok_overlay,
    apply_stt_byok_overlay,
    resolve_stt_byok_session,
)
from lct_python_backend.services.provider_selection import resolve_import_audio_candidates
from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
from lct_python_backend.services.transcript_linearization import build_line_utterances
from lct_python_backend.services.tuning_constants import (
    MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
    MIN_THEMES_FOR_ARC_CONSOLIDATION,
    MIN_TOPICS_FOR_THEME_CONSOLIDATION,
)


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

        stt_http_url = str(runtime_stt_settings.get("http_url", "")).strip()
        import_candidates = resolve_import_audio_candidates(
            settings=runtime_stt_settings,
            provider_override=provider_override,
        )
        primary_import_candidate = import_candidates[0] if import_candidates else None
        stt_backend = _candidate_backend_label(primary_import_candidate, stt_http_url)
        telemetry["stt_backend"] = stt_backend
        telemetry["stt_http_url"] = stt_http_url
        if isinstance(primary_import_candidate, dict):
            telemetry["stt_candidate_provider"] = str(primary_import_candidate.get("provider") or "")
            telemetry["stt_candidate_transport"] = str(primary_import_candidate.get("transport") or "")

        # Emit progress before the (potentially slow) transcription call.
        resolved_source_type = source_type if source_type != "auto" else None
        is_likely_audio = (
            resolved_source_type == "audio"
            or (resolved_source_type is None and suffix in _AUDIO_SUFFIXES)
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

        # Progressive graph generation: feed transcript to LLM as STT chunks arrive
        # instead of waiting for all chunks to finish. The processor ref is set once
        # the processor is created (after LLM config is loaded).
        progressive_processor_ref: list = []  # mutable container for closure
        PROGRESSIVE_BATCH_CHARS = 400  # accumulate ~400 chars before triggering LLM
        progressive_buffer: list[str] = []
        progressive_buffer_chars = [0]

        async def _flush_progressive_buffer():
            if not progressive_processor_ref or not progressive_buffer:
                return
            batch_text = "\n".join(progressive_buffer)
            progressive_buffer.clear()
            progressive_buffer_chars[0] = 0
            try:
                await progressive_processor_ref[0].handle_final_text(batch_text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[PROCESS FILE] Progressive graph gen failed (non-fatal): %s", exc)

        async def on_chunk_progress(chunk_idx: int, total: int, chunk_text: str):
            frac = chunk_idx / total
            # With progressive graph gen, STT+analysis happen together: 0.10 → 0.85
            progress = 0.10 + frac * (0.75 if progressive_processor_ref else 0.25)
            telemetry["stt_chunks_completed"] = chunk_idx
            telemetry["stt_chunks_total"] = total
            transcription_elapsed_ms = (
                elapsed_ms(transcription_started_at)
                if transcription_started_at is not None
                else None
            )
            transcription_eta_ms, transcription_estimated_total_ms = estimate_transcription_eta_ms(
                transcription_elapsed_ms=transcription_elapsed_ms,
                chunk_idx=chunk_idx,
                total_chunks=total,
            )
            normalized_chunk_text = str(chunk_text or "").strip()
            await stage_events.emit_chunk_progress(
                chunk_idx=chunk_idx,
                total=total,
                progress=progress,
                normalized_chunk_text=normalized_chunk_text,
                transcription_elapsed_ms=transcription_elapsed_ms,
                transcription_eta_ms=transcription_eta_ms,
                transcription_estimated_total_ms=transcription_estimated_total_ms,
            )
            if normalized_chunk_text:
                # Accumulate transcript for checkpoint
                checkpoint_transcript_parts.append(normalized_chunk_text)
                telemetry["checkpoint_chunks"] = len(checkpoint_transcript_parts)
                telemetry["checkpoint_total_chunks"] = total
                telemetry["resume_available"] = True

                await persist_chunk_checkpoint_safe(
                    db,
                    file_hash=file_hash,
                    conversation_id=resolved_conversation_id,
                    chunk_index=chunk_idx,
                    total_chunks=total,
                    chunk_text=normalized_chunk_text,
                    accumulated_transcript="\n".join(checkpoint_transcript_parts),
                    stt_backend=telemetry.get("stt_backend", ""),
                    elapsed_ms=transcription_elapsed_ms or 0,
                    file_name=filename,
                    file_size_bytes=content_size,
                    log=logger,
                )

                # Progressive graph generation: feed to LLM as text accumulates
                if progressive_processor_ref:
                    progressive_buffer.append(normalized_chunk_text)
                    progressive_buffer_chars[0] += len(normalized_chunk_text)
                    if progressive_buffer_chars[0] >= PROGRESSIVE_BATCH_CHARS:
                        await _flush_progressive_buffer()

        async def on_provider_fallback(
            from_provider: str,
            to_provider: str,
            error_message: str,
        ) -> None:
            fallback_record = {
                "from_provider": str(from_provider or "").strip().lower() or "unknown",
                "to_provider": str(to_provider or "").strip().lower() or "unknown",
                "error": str(error_message or "").strip() or "unknown_error",
            }
            fallback_events = telemetry.setdefault("stt_provider_fallbacks", [])
            if isinstance(fallback_events, list):
                fallback_events.append(fallback_record)
            await stage_events.emit_provider_fallback(
                fallback_record,
                transcription_elapsed_ms=(
                    elapsed_ms(transcription_started_at)
                    if transcription_started_at is not None
                    else None
                ),
            )

        # Determine if we should use interleaved segmented processing
        # This is beneficial for large audio files (> threshold) as it provides
        # progressive feedback: users see nodes appearing as each segment completes
        use_segmented_processing = (
            is_likely_audio
            and transcribe_audio_segmented is not None
            and (
                SEGMENT_PROCESSING_FORCE_ENABLED
                or content_size > SEGMENT_PROCESSING_THRESHOLD_BYTES
            )
            and (
                not isinstance(primary_import_candidate, dict)
                or str(primary_import_candidate.get("transport") or "backend_http").strip().lower() == "backend_http"
            )
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

        # Track final source type (set by either path)
        final_source_type = "audio" if is_likely_audio else "text"
        final_source_metadata: dict[str, Any] = {}
        final_source_utterances: list[dict[str, Any]] = []
        final_speaker_segments: list[dict[str, Any]] = []
        final_transcript_text = ""

        if use_segmented_processing:
            # ────────────────────────────────────────────────────────────────
            # INTERLEAVED SEGMENTED PROCESSING
            # Process each natural audio segment through the full pipeline
            # so users see nodes appearing progressively
            # ────────────────────────────────────────────────────────────────
            active_stage = "segmented_transcribing"
            total_transcript_chars = 0
            total_nodes_generated = 0
            segmented_transcript_parts: list[str] = list(checkpoint_transcript_parts)  # seed from checkpoint

            # Get STT URL from settings
            stt_http_url = str(runtime_stt_settings.get("http_url", "")).strip()
            if not stt_http_url:
                logger.error("[PROCESS FILE] No STT HTTP URL configured for segmented transcription")
                raise ValueError("No STT HTTP URL configured for segmented transcription.")

            logger.info(
                "[PROCESS FILE] Starting segmented transcription using STT URL: %s",
                stt_http_url,
            )

            segment_idx = 0
            accumulated_utterances: list[dict[str, Any]] = []
            async for segment in transcribe_audio_segmented(
                file_path=Path(temp_path),
                http_url=stt_http_url,
                model=str(runtime_stt_settings.get("http_model", "")).strip(),
                language=str(runtime_stt_settings.get("http_language", "")).strip(),
                timeout_seconds=float(runtime_stt_settings.get("http_timeout_seconds", 120.0) or 120.0),
                resume_from_segment=resume_from_chunk,
                resumed_segment_texts=checkpoint_transcript_parts if resume_from_chunk > 0 else None,
            ):
                segment_idx += 1
                if await request.is_disconnected():
                    logger.info(
                        "[PROCESS FILE] Client disconnected during segment %d/%d",
                        segment.segment_index,
                        segment.segment_total,
                    )
                    return

                await stage_events.emit_segment_started(
                    segment_index=segment.segment_index,
                    segment_total=segment.segment_total,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                )

                stt_progress = calculate_segmented_progress(
                    segment.segment_index,
                    segment.segment_total,
                    "transcribing",
                    1.0,
                )
                segment_eta_ms, _segment_estimated_total_ms = estimate_segment_eta_ms(
                    total_elapsed_ms=elapsed_ms(pipeline_started_at),
                    segments_completed=segment.segment_index,
                    segments_total=segment.segment_total,
                )
                await stage_events.emit_segment_transcribed(
                    segment_index=segment.segment_index,
                    segment_total=segment.segment_total,
                    stt_progress=stt_progress,
                    segment_elapsed_ms=segment.elapsed_ms,
                    segment_eta_ms=segment_eta_ms,
                    llm_backend=llm_backend,
                    segment_stt_backend=str(segment.metadata.get("stt_backend") or ""),
                )

                if segment.metadata.get("stt_backend"):
                    telemetry["stt_backend"] = segment.metadata.get("stt_backend")

                is_resumed_segment = bool(segment.metadata.get("resumed"))
                normalized_segment_text = str(segment.transcript_text or "").strip()
                if normalized_segment_text and not is_resumed_segment:
                    segmented_transcript_parts.append(normalized_segment_text)
                await stage_events.emit_segment_transcript(
                    segment_index=segment.segment_index,
                    segment_total=segment.segment_total,
                    transcript_text=segment.transcript_text,
                    resumed=is_resumed_segment,
                )

                if not is_resumed_segment:
                    await persist_chunk_checkpoint_safe(
                        db,
                        file_hash=file_hash,
                        conversation_id=resolved_conversation_id,
                        chunk_index=segment.segment_index,
                        total_chunks=segment.segment_total,
                        chunk_text=normalized_segment_text,
                        accumulated_transcript="\n".join(segmented_transcript_parts),
                        stt_backend=telemetry.get("stt_backend", ""),
                        elapsed_ms=elapsed_ms(pipeline_started_at) or 0,
                        file_name=filename,
                        file_size_bytes=content_size,
                        log=logger,
                        failure_label="Segment checkpoint save",
                    )

                # Now analyze this segment's transcript
                active_stage = "analyzing"
                segment_chunks = chunk_transcript_lines(segment.transcript_text)
                total_transcript_chars += len(segment.transcript_text)
                segment_utterances = build_line_utterances(
                    segment.transcript_text,
                    default_speaker_id="SPEAKER_00",
                    window_start_s=float(segment.start_ms) / 1000.0,
                    window_end_s=float(segment.end_ms) / 1000.0,
                    start_sequence=len(accumulated_utterances) + 1,
                    source_label="segmented_import_window",
                )
                accumulated_utterances.extend(segment_utterances)

                for chunk_idx, chunk in enumerate(segment_chunks, start=1):
                    if await request.is_disconnected():
                        return

                    # Calculate progress for analysis phase of this segment
                    analysis_stage_progress = chunk_idx / max(1, len(segment_chunks))
                    overall_progress = calculate_segmented_progress(
                        segment.segment_index,
                        segment.segment_total,
                        "analyzing",
                        analysis_stage_progress,
                    )

                    await stage_events.emit_segment_analyzing(
                        segment_index=segment.segment_index,
                        segment_total=segment.segment_total,
                        chunk_idx=chunk_idx,
                        chunk_total=len(segment_chunks),
                        overall_progress=overall_progress,
                        llm_backend=llm_backend,
                    )

                    await processor.handle_final_text(chunk)

                # Flush segment to emit nodes from this segment
                nodes_after_segment = await processor.flush_segment()
                nodes_this_segment = nodes_after_segment - total_nodes_generated
                total_nodes_generated = nodes_after_segment

                await stage_events.emit_segment_complete(
                    segment_index=segment.segment_index,
                    segment_total=segment.segment_total,
                    nodes_generated=nodes_this_segment,
                    total_nodes=total_nodes_generated,
                    segment_elapsed_ms=segment.elapsed_ms,
                )

                logger.info(
                    "[PROCESS FILE] Segment %d/%d complete: %d nodes (+%d this segment)",
                    segment.segment_index,
                    segment.segment_total,
                    total_nodes_generated,
                    nodes_this_segment,
                )

            # Final flush after all segments
            await processor.flush()
            telemetry["segment_count"] = segment_idx
            telemetry["transcript_chars"] = total_transcript_chars
            # Record empirical timing for segmented transcription
            if transcription_started_at is not None and audio_duration_ms and stt_backend:
                record_transcription_timing(
                    stt_backend=stt_backend,
                    audio_duration_ms=audio_duration_ms,
                    transcription_ms=elapsed_ms(transcription_started_at),
                )
            final_source_type = "audio"
            final_source_utterances = accumulated_utterances
            final_transcript_text = "\n".join(segmented_transcript_parts).strip()

        else:
            # ────────────────────────────────────────────────────────────────
            # SEQUENTIAL PROCESSING (existing flow)
            # Transcribe entire file, then analyze all at once
            # ────────────────────────────────────────────────────────────────
            transcript_result = await transcribe_uploaded_file(
                temp_path=Path(temp_path),
                filename=filename,
                content_type=file.content_type,
                stt_settings=runtime_stt_settings,
                provider_override=provider_override,
                source_type_override=resolved_source_type,
                on_chunk_progress=on_chunk_progress if is_likely_audio else None,
                on_provider_fallback=on_provider_fallback if is_likely_audio else None,
                resume_from_chunk=resume_from_chunk,
                resumed_chunk_texts=checkpoint_transcript_parts if resume_from_chunk > 0 else None,
            )
            source_timings = transcript_result.metadata.get("timings_ms", {})
            if isinstance(source_timings, dict):
                telemetry["stt_provider_ms"] = source_timings.get("stt_ms")
                telemetry["diarization_ms"] = source_timings.get("diarization_ms")
                telemetry["alignment_ms"] = source_timings.get("alignment_ms")
            if transcript_result.metadata.get("provider_fallback_used"):
                telemetry["stt_provider_fallback_used"] = True
                telemetry["stt_provider_fallback_from"] = transcript_result.metadata.get("provider_fallback_from")
                telemetry["stt_provider_fallback_to"] = transcript_result.metadata.get("provider_fallback_to")
            # Store stt_backend for later use in send_status
            if transcript_result.metadata.get("stt_backend"):
                telemetry["stt_backend"] = transcript_result.metadata.get("stt_backend")
            if transcription_started_at is not None:
                telemetry["transcription_ms"] = elapsed_ms(transcription_started_at)
                # Record empirical timing for future ETA estimates
                if audio_duration_ms and telemetry.get("stt_backend"):
                    record_transcription_timing(
                        stt_backend=telemetry["stt_backend"],
                        audio_duration_ms=audio_duration_ms,
                        transcription_ms=telemetry["transcription_ms"],
                    )
            status_message = f"Got {transcript_result.source_type} transcript."
            if transcript_result.source_type == "audio" and transcript_result.metadata.get("provider_fallback_used"):
                fallback_from = transcript_result.metadata.get("provider_fallback_from") or "local"
                fallback_to = transcript_result.metadata.get("provider") or "fallback provider"
                status_message = f"Got audio transcript via fallback ({fallback_from} -> {fallback_to})."
            await emit(
                "status",
                {
                    "stage": "transcribed",
                    "progress": 0.35,
                    "message": status_message,
                    "source_type": transcript_result.source_type,
                    "metadata": transcript_result.metadata,
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "transcription_ms": telemetry.get("transcription_ms"),
                        "stt_provider_ms": telemetry.get("stt_provider_ms"),
                        "diarization_ms": telemetry.get("diarization_ms"),
                        "alignment_ms": telemetry.get("alignment_ms"),
                        "stt_backend": transcript_result.metadata.get("stt_backend"),
                    },
                },
            )
            active_stage = "chunking"
            final_source_utterances = list(getattr(transcript_result, "utterances", []) or [])
            final_speaker_segments = list(getattr(transcript_result, "speaker_segments", []) or [])

            transcript_text = transcript_result.transcript_text.strip()
            if not transcript_text:
                raise ValueError("No transcript text could be extracted from file.")

            # Flush any remaining progressive buffer from STT phase
            await _flush_progressive_buffer()
            progressive_nodes = len(processor.existing_json) if hasattr(processor, "existing_json") else 0

            chunking_started_at = time.perf_counter()
            transcript_chunks = chunk_transcript_lines(transcript_text)
            if not transcript_chunks:
                raise ValueError("Transcript parser produced no usable chunks.")
            telemetry["chunking_ms"] = elapsed_ms(chunking_started_at)
            telemetry["transcript_chars"] = len(transcript_text)
            telemetry["transcript_chunk_count"] = len(transcript_chunks)
            telemetry["progressive_nodes"] = progressive_nodes

            if progressive_nodes > 0:
                # Progressive generation already produced nodes during STT.
                # Just flush to ensure all pending text is processed.
                logger.info(
                    "[PROCESS FILE] Progressive generation produced %d nodes during STT. "
                    "Flushing final batch (skipping redundant re-analysis).",
                    progressive_nodes,
                )
                active_stage = "analyzing"
                await emit(
                    "status",
                    {
                        "stage": "analyzing",
                        "progress": 0.90,
                        "message": f"Finalizing graph ({progressive_nodes} nodes from progressive analysis)...",
                        "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                        "llm_backend": llm_backend,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "progressive_nodes": progressive_nodes,
                            "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                            "llm_backend": llm_backend,
                        },
                    },
                )
                await processor.flush()

            else:
                # No progressive nodes — fall back to full post-STT analysis
                active_stage = "analyzing"
                await emit(
                    "status",
                    {
                        "stage": "analyzing",
                        "progress": 0.55,
                        "message": f"Generating graph from {len(transcript_chunks)} transcript chunks...",
                        "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                        "llm_backend": llm_backend,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "chunking_ms": telemetry.get("chunking_ms"),
                            "transcript_chunk_count": len(transcript_chunks),
                            "stt_backend": transcript_result.metadata.get("stt_backend", ""),
                            "llm_backend": llm_backend,
                        },
                    },
                )

            # Analysis loop — only runs if progressive generation didn't handle it
            for index, chunk in enumerate(transcript_chunks, start=1):
                if progressive_nodes > 0:
                    break  # Already processed progressively

                if await request.is_disconnected():
                    logger.info(
                        "[PROCESS FILE] Client disconnected, aborting at chunk %d/%d",
                        index,
                        len(transcript_chunks),
                    )
                    return

                # Calculate ETA for analysis stage
                analysis_elapsed_ms = (
                    elapsed_ms(graph_started_at) if graph_started_at is not None else None
                )
                analysis_eta_ms, analysis_estimated_total_ms = estimate_analysis_eta_ms(
                    analysis_elapsed_ms=analysis_elapsed_ms,
                    chunk_idx=index - 1,  # Use completed chunks for ETA
                    total_chunks=len(transcript_chunks),
                )

                # Calculate progress within analysis phase (0.55 to 0.95)
                analysis_progress = 0.55 + (index / len(transcript_chunks)) * 0.40

                await emit(
                    "status",
                    {
                        "stage": "analyzing",
                        "progress": round(analysis_progress, 3),
                        "message": f"Analyzing chunk {index}/{len(transcript_chunks)}...",
                        "stt_backend": telemetry.get("stt_backend", ""),
                        "llm_backend": telemetry.get("llm_backend", ""),
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "analysis_elapsed_ms": analysis_elapsed_ms,
                            "analysis_eta_ms": analysis_eta_ms,
                            "analysis_estimated_total_ms": analysis_estimated_total_ms,
                            "analysis_chunks_completed": index - 1,
                            "analysis_chunks_total": len(transcript_chunks),
                            "stt_backend": telemetry.get("stt_backend", ""),
                            "llm_backend": telemetry.get("llm_backend", ""),
                        },
                    },
                )

                await emit(
                    "transcript",
                    {
                        "phase": "analyzing",
                        "chunk_id": f"segment-{index}",
                        "index": index,
                        "total": len(transcript_chunks),
                        "text": chunk,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "graph_elapsed_ms": analysis_elapsed_ms,
                            "analysis_eta_ms": analysis_eta_ms,
                        },
                    },
                )

                logger.info(
                    "[PROCESS FILE] Processing chunk %d/%d (eta: %s ms)",
                    index,
                    len(transcript_chunks),
                    analysis_eta_ms,
                )
                await processor.handle_final_text(chunk)

            await processor.flush()

            final_source_type = transcript_result.source_type
            final_source_metadata = transcript_result.metadata
            final_transcript_text = transcript_text

        graph_refinement_result = None
        if processor.existing_json and final_source_utterances and final_transcript_text:
            await emit(
                "status",
                {
                    "stage": "refining_graph",
                    "progress": 0.955,
                    "message": "Refining graph into denser subthreads and tangents...",
                    "stt_backend": telemetry.get("stt_backend", ""),
                    "llm_backend": telemetry.get("llm_backend", ""),
                    "telemetry": {
                        "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        "node_count": len(processor.existing_json),
                        "utterance_count": len(final_source_utterances),
                    },
                },
            )
            graph_refinement_result = await refine_import_graph_nodes(
                transcript_text=final_transcript_text,
                utterances=final_source_utterances,
                existing_nodes=processor.existing_json,
                llm_config=runtime_llm_config,
                providers=runtime_llm_providers,
            )
            telemetry["graph_refinement"] = {
                key: value
                for key, value in graph_refinement_result.items()
                if key != "nodes"
            }
            logger.info(
                "[PROCESS FILE] Graph refinement result for %s: %s",
                resolved_conversation_id,
                json.dumps(telemetry["graph_refinement"], ensure_ascii=False, sort_keys=True),
            )
            if graph_refinement_result.get("applied") and isinstance(graph_refinement_result.get("nodes"), list):
                processor.existing_json = list(graph_refinement_result["nodes"])
                await stage_events.send_graph_update(processor.existing_json, processor.chunk_dict)
                await emit(
                    "status",
                    {
                        "stage": "refining_graph",
                        "progress": 0.965,
                        "message": (
                            f"Refined graph from {graph_refinement_result.get('original_node_count', len(processor.existing_json))} "
                            f"to {graph_refinement_result.get('refined_node_count', len(processor.existing_json))} nodes."
                        ),
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "graph_refinement_ms": graph_refinement_result.get("refinement_ms"),
                            "graph_refinement_backend": graph_refinement_result.get("backend"),
                        },
                    },
                )
            elif graph_refinement_result.get("reason") == "refinement_failed":
                await emit(
                    "status",
                    {
                        "level": "warning",
                        "stage": "refining_graph",
                        "progress": 0.965,
                        "message": (
                            "Graph subthread refinement failed; keeping the first-pass graph. "
                            f"{graph_refinement_result.get('error') or ''}".strip()
                        ),
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "graph_refinement_ms": graph_refinement_result.get("refinement_ms"),
                            "graph_refinement_backend": graph_refinement_result.get("backend"),
                        },
                    },
                )
            else:
                await emit(
                    "status",
                    {
                        "level": "info",
                        "stage": "refining_graph",
                        "progress": 0.965,
                        "message": (
                            "Graph subthread refinement skipped; keeping the first-pass graph. "
                            f"Reason: {graph_refinement_result.get('reason') or 'unknown'}"
                        ),
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                            "graph_refinement_ms": graph_refinement_result.get("refinement_ms"),
                            "graph_refinement_backend": graph_refinement_result.get("backend"),
                        },
                    },
                )

        # Post-streaming hierarchy consolidation passes (A5 — ideas → topics
        # → themes → arcs + title + exec summary). The streaming LLM only
        # authors chunks+ideas correctly per-batch; it cannot cluster across
        # batches. These passes run on the COMPLETED graph and each see their
        # whole input tier in one LLM call, producing meaningful compression.
        consolidation_telemetry: dict[str, Any] = {}
        conversation_title_from_arcs: Optional[str] = None
        executive_summary: Optional[str] = None
        try:
            existing = list(processor.existing_json or [])

            def _of_level(level: int) -> list[dict[str, Any]]:
                return [
                    n for n in existing
                    if isinstance(n, dict) and int(n.get("semantic_level") or n.get("level") or 0) == level
                ]

            ideas_in = _of_level(2)
            consolidation_telemetry["ideas_in"] = len(ideas_in)
            if len(ideas_in) >= MIN_IDEAS_FOR_TOPIC_CONSOLIDATION:
                await stage_events.emit_consolidation_status(
                    progress=0.97,
                    message=f"Clustering {len(ideas_in)} ideas into topics...",
                )
                topics = await consolidate_ideas_to_topics(ideas_in, providers=runtime_llm_providers)
                if topics:
                    existing.extend(topics)
                    consolidation_telemetry["topics_out"] = len(topics)
                    logger.info("[CONSOLIDATE] ideas=%d -> topics=%d", len(ideas_in), len(topics))

                    if len(topics) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
                        await stage_events.emit_consolidation_status(
                            progress=0.975,
                            message=f"Clustering {len(topics)} topics into themes...",
                        )
                        themes = await consolidate_topics_to_themes(topics, providers=runtime_llm_providers)
                        if themes:
                            existing.extend(themes)
                            consolidation_telemetry["themes_out"] = len(themes)
                            logger.info("[CONSOLIDATE] topics=%d -> themes=%d", len(topics), len(themes))

                            if len(themes) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
                                await stage_events.emit_consolidation_status(
                                    progress=0.98,
                                    message=f"Synthesizing {len(themes)} themes into arcs + executive summary...",
                                )
                                arcs, title, summary = await consolidate_themes_to_arcs(
                                    themes, providers=runtime_llm_providers,
                                )
                                if arcs:
                                    existing.extend(arcs)
                                    consolidation_telemetry["arcs_out"] = len(arcs)
                                    logger.info("[CONSOLIDATE] themes=%d -> arcs=%d", len(themes), len(arcs))
                                if title:
                                    conversation_title_from_arcs = title
                                if summary:
                                    executive_summary = summary

            processor.existing_json = existing
            telemetry["consolidation"] = consolidation_telemetry
        except Exception as cons_exc:  # noqa: BLE001
            logger.warning(
                "[PROCESS FILE] Hierarchy consolidation failed (non-fatal): %s",
                cons_exc,
            )
            telemetry["consolidation_error"] = str(cons_exc) or type(cons_exc).__name__

        # Generate a descriptive conversation name from the graph nodes
        def _derive_conversation_name(nodes: list, fallback: str) -> str:
            """Build a short title from the first few node names."""
            names = [
                str(n.get("node_name") or "").strip()
                for n in (nodes or [])
                if isinstance(n, dict) and str(n.get("node_name") or "").strip()
            ]
            if not names:
                return fallback
            # Use up to 3 node names, max 60 chars total
            parts = []
            total = 0
            for name in names[:3]:
                if total + len(name) > 55:
                    break
                parts.append(name)
                total += len(name)
            title = " / ".join(parts)
            if len(names) > len(parts):
                title += " ..."
            return title or fallback

        derived_name = _derive_conversation_name(
            processor.existing_json,
            Path(filename).stem or "Imported conversation",
        )
        # LLM-authored title from the arcs consolidation pass (A4) wins over
        # the slug-concat fallback when available.
        if conversation_title_from_arcs:
            derived_name = conversation_title_from_arcs
            telemetry["conversation_title_source"] = "arcs_consolidation"

        # Populate utterance.chunk_id from processor.chunk_dict ({chunk_uuid:
        # transcript_text}) so the speaker rollup can later join utterances to
        # nodes via chunk_id. Audio-only diarization writes utterances with
        # null chunk_id; without this stitch, post-hoc diarization-repair
        # updates on utterances can't propagate back to node.speaker_info.
        chunk_text_by_id = getattr(processor, "chunk_dict", {}) or {}
        if chunk_text_by_id and final_source_utterances:
            normalized_chunks = [
                (cid, (text or "").lower())
                for cid, text in chunk_text_by_id.items()
                if isinstance(cid, str) and text
            ]
            stitched = 0
            for utterance in final_source_utterances:
                if not isinstance(utterance, dict):
                    continue
                if utterance.get("chunk_id"):
                    continue
                utt_text = (utterance.get("text") or "").strip().lower()
                if len(utt_text) < 4:
                    continue
                for cid, lower_chunk in normalized_chunks:
                    if utt_text in lower_chunk:
                        utterance["chunk_id"] = cid
                        stitched += 1
                        break
            telemetry["utterance_chunk_stitched"] = stitched
            if stitched:
                logger.info(
                    "[PROCESS FILE] Stitched chunk_id onto %d/%d utterances for %s",
                    stitched, len(final_source_utterances), resolved_conversation_id,
                )

        # Persist graph to DB (enables canvas export and other DB-backed features).
        # Merge executive_summary from arcs consolidation (A4) into source_metadata
        # so the conversation banner can display it.
        final_metadata = dict(final_source_metadata or {}) if isinstance(final_source_metadata, dict) else {}
        if executive_summary:
            final_metadata["executive_summary"] = executive_summary
        if conversation_title_from_arcs:
            final_metadata["conversation_title"] = conversation_title_from_arcs
        try:
            persisted_count = await persist_import_graph(
                db=db,
                conversation_id=resolved_conversation_id,
                existing_json=processor.existing_json,
                utterances=final_source_utterances,
                conversation_name=derived_name,
                source_type=final_source_type,
                source_metadata=final_metadata,
            )
            logger.info("[PROCESS FILE] Persisted %d nodes to DB for %s", persisted_count, resolved_conversation_id)
            telemetry["graph_persisted_nodes"] = persisted_count

            # Copy the source upload into recordings/ so the audio endpoint
            # can serve it after the temp file is cleaned up.
            if final_source_type == "audio":
                try:
                    from lct_python_backend.stt_api import audio_storage
                    suffix = Path(temp_path).suffix.lower()
                    dest = audio_storage.persist_source_audio(
                        resolved_conversation_id, temp_path, suffix
                    )
                    if dest:
                        telemetry["source_audio_persisted"] = str(dest)
                except Exception as audio_exc:  # noqa: BLE001
                    logger.warning(
                        "[PROCESS FILE] source audio persist failed for %s: %s",
                        resolved_conversation_id, audio_exc,
                    )
                    telemetry["source_audio_persist_error"] = str(audio_exc)

            await clear_import_checkpoint_safe(db, file_hash, telemetry, logger)
        except Exception as persist_exc:  # noqa: BLE001
            logger.warning("[PROCESS FILE] Graph persistence failed (non-fatal): %s", persist_exc)
            telemetry["graph_persist_error"] = str(persist_exc) or type(persist_exc).__name__

        if final_source_type == "audio" and final_speaker_segments:
            try:
                materialization_result = await persist_speaker_refinement(
                    conversation_id=resolved_conversation_id,
                    segments=final_speaker_segments,
                    source_text="\n".join(segment.get("text", "") for segment in final_speaker_segments if isinstance(segment, dict)),
                    provider=str(final_source_metadata.get("provider") or ""),
                    model=str(final_source_metadata.get("model") or ""),
                    transport=str(final_source_metadata.get("transport") or final_source_metadata.get("stt_backend") or ""),
                )
                telemetry["speaker_materialization"] = materialization_result
            except Exception as speaker_exc:  # noqa: BLE001
                speaker_error = str(speaker_exc) or type(speaker_exc).__name__
                telemetry["speaker_materialization_error"] = speaker_error
                logger.warning(
                    "[PROCESS FILE] Speaker materialization failed for %s: %s",
                    resolved_conversation_id,
                    speaker_error,
                )

        artifact_export_settings = await load_artifact_export_settings(db)
        artifact_export_payload = None
        if (
            artifact_export_settings.get("enabled")
            and artifact_export_settings.get("trigger_on_import_complete")
        ):
            try:
                await emit(
                    "status",
                    {
                        "stage": "exporting_artifacts",
                        "progress": 0.97,
                        "message": "Writing paired canvas/transcript artifacts...",
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )
                artifact_export_payload = await auto_export_conversation_artifacts(
                    db=db,
                    conversation_id=resolved_conversation_id,
                    settings=artifact_export_settings,
                )
                telemetry["artifact_export"] = artifact_export_payload
                await emit(
                    "status",
                    {
                        "stage": "exporting_artifacts",
                        "progress": 0.99,
                        "message": f"Exported {len(artifact_export_payload.get('written_files', []))} artifact files.",
                        "artifact_export": artifact_export_payload,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )
            except Exception as artifact_exc:  # noqa: BLE001
                artifact_error = str(artifact_exc) or type(artifact_exc).__name__
                telemetry["artifact_export_error"] = artifact_error
                logger.warning(
                    "[PROCESS FILE] Artifact auto-export failed for %s: %s",
                    resolved_conversation_id,
                    artifact_error,
                )
                await emit(
                    "status",
                    {
                        "level": "warning",
                        "stage": "exporting_artifacts",
                        "progress": 0.99,
                        "message": f"Artifact export failed: {artifact_error}",
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
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

        diarization_job_payload = None
        if (
            final_source_type == "audio"
            and is_async_import_diarization_enabled()
        ):
            async_audio_copy: Optional[Path] = None
            try:
                async_audio_copy = copy_temp_upload_for_async_job(Path(temp_path), suffix=suffix)
                job_snapshot = await enqueue_import_diarization_job(
                    audio_path=async_audio_copy,
                    filename=filename,
                    content_type=file.content_type,
                    source_type_override=resolved_source_type,
                    provider_override=provider_override,
                    conversation_id=resolved_conversation_id,
                    speaker_id=resolved_speaker_id,
                    stt_settings=runtime_stt_settings,
                    llm_config=llm_config,
                    source_metadata=final_source_metadata,
                )
                job_id = str(job_snapshot["job_id"])
                telemetry["async_diarization_job_id"] = job_id
                diarization_job_payload = {
                    "id": job_id,
                    "status": job_snapshot.get("status"),
                    **build_diarization_job_urls(job_id),
                }
                await emit(
                    "status",
                    {
                        "stage": "queued",
                        "progress": 0.98,
                        "message": "Queued background diarization job.",
                        "diarization_job": diarization_job_payload,
                        "telemetry": {
                            "total_elapsed_ms": elapsed_ms(pipeline_started_at),
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001
                if async_audio_copy is not None:
                    cleanup_temp_file(str(async_audio_copy))
                enqueue_error = str(exc) or type(exc).__name__
                telemetry["async_diarization_enqueue_error"] = enqueue_error
                logger.warning(
                    "Failed to enqueue async diarization job for %s: %s",
                    filename,
                    enqueue_error,
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

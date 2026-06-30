"""Consolidation, naming, utterance stitching, and DB persistence for bulk import."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.graph_persistence import persist_graph as persist_import_graph
from lct_python_backend.services.hierarchy_consolidator import (
    consolidate_ideas_to_topics,
    consolidate_topics_to_themes,
    consolidate_themes_to_arcs,
)
from .import_bulk_checkpoint_flow import clear_import_checkpoint_safe
from .import_bulk_stage_events import ImportBulkStageEvents
from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
from lct_python_backend.services.tuning_constants import (
    MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
    MIN_THEMES_FOR_ARC_CONSOLIDATION,
    MIN_TOPICS_FOR_THEME_CONSOLIDATION,
)


@dataclass
class ImportPersistenceResult:
    derived_name: str
    conversation_title_from_arcs: Optional[str] = None
    executive_summary: Optional[str] = None


def derive_conversation_name(nodes: list, fallback: str) -> str:
    """Build a short title from the first few node names."""
    names = [
        str(n.get("node_name") or "").strip()
        for n in (nodes or [])
        if isinstance(n, dict) and str(n.get("node_name") or "").strip()
    ]
    if not names:
        return fallback
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


def stitch_utterance_chunk_ids(
    *,
    processor: Any,
    final_source_utterances: list[dict[str, Any]],
    telemetry: dict[str, Any],
    conversation_id: str,
    log: logging.Logger,
) -> None:
    """Join utterances to graph chunks via substring match when chunk_id is missing."""
    chunk_text_by_id = getattr(processor, "chunk_dict", {}) or {}
    if not chunk_text_by_id or not final_source_utterances:
        return

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
        log.info(
            "[PROCESS FILE] Stitched chunk_id onto %d/%d utterances for %s",
            stitched,
            len(final_source_utterances),
            conversation_id,
        )


async def run_hierarchy_consolidation(
    *,
    processor: Any,
    runtime_llm_providers: list[dict[str, Any]],
    stage_events: ImportBulkStageEvents,
    telemetry: dict[str, Any],
    log: logging.Logger,
) -> tuple[Optional[str], Optional[str]]:
    """Run ideas→topics→themes→arcs consolidation on the completed graph."""
    consolidation_telemetry: dict[str, Any] = {}
    conversation_title_from_arcs: Optional[str] = None
    executive_summary: Optional[str] = None
    try:
        existing = list(processor.existing_json or [])

        def _of_level(level: int) -> list[dict[str, Any]]:
            return [
                n
                for n in existing
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
                log.info("[CONSOLIDATE] ideas=%d -> topics=%d", len(ideas_in), len(topics))

                if len(topics) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
                    await stage_events.emit_consolidation_status(
                        progress=0.975,
                        message=f"Clustering {len(topics)} topics into themes...",
                    )
                    themes = await consolidate_topics_to_themes(topics, providers=runtime_llm_providers)
                    if themes:
                        existing.extend(themes)
                        consolidation_telemetry["themes_out"] = len(themes)
                        log.info("[CONSOLIDATE] topics=%d -> themes=%d", len(topics), len(themes))

                        if len(themes) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
                            await stage_events.emit_consolidation_status(
                                progress=0.98,
                                message=f"Synthesizing {len(themes)} themes into arcs + executive summary...",
                            )
                            arcs, title, summary = await consolidate_themes_to_arcs(
                                themes,
                                providers=runtime_llm_providers,
                            )
                            if arcs:
                                existing.extend(arcs)
                                consolidation_telemetry["arcs_out"] = len(arcs)
                                log.info("[CONSOLIDATE] themes=%d -> arcs=%d", len(themes), len(arcs))
                            if title:
                                conversation_title_from_arcs = title
                            if summary:
                                executive_summary = summary

        processor.existing_json = existing
        telemetry["consolidation"] = consolidation_telemetry
    except Exception as cons_exc:  # noqa: BLE001
        log.warning(
            "[PROCESS FILE] Hierarchy consolidation failed (non-fatal): %s",
            cons_exc,
        )
        telemetry["consolidation_error"] = str(cons_exc) or type(cons_exc).__name__

    return conversation_title_from_arcs, executive_summary


async def _persist_graph_via_pipeline(
    *,
    db: AsyncSession,
    conversation_id: str,
    existing_json: list[dict[str, Any]],
    utterances: list[dict[str, Any]],
    conversation_name: str,
    source_type: str,
    source_metadata: dict[str, Any],
) -> int:
    """Route the canonical graph write through the ``ConversationPipeline`` spine
    (ADR-059 PR-1) — the FIRST production call site of the pipeline.

    Behavior-preserving beachhead: the injected ``persist_fn`` adapter forwards to
    the SAME ``persist_graph`` on the SAME request-scoped ``db`` (NOT PersistStage's
    default ``persist_live_graph_snapshot``, which opens a second session and would
    split the request transaction). The import-only kwargs (``db``, ``utterances``,
    ``conversation_name``) ride the closure, and ``source_type`` is pinned to the
    import's raw value ("audio"/"text") rather than PersistStage's remap. A persist
    failure is surfaced by re-raising, so the caller's existing non-fatal handler
    (telemetry["graph_persist_error"]) still applies.
    """
    from lct_python_backend.services.conversation_pipeline import (
        ConversationPipeline,
        PersistStage,
        PipelineState,
    )
    from lct_python_backend.services.conversation_pipeline.events import (
        GraphPersisted,
        StageFailed,
    )

    nodes = list(existing_json or [])

    # PersistStage early-returns (no fn call) when graph.nodes is empty, but
    # persist_graph still writes utterances on an empty graph — so a 0-node import
    # that carries utterances would be silently dropped if routed through the stage.
    # Preserve that edge case with a direct call.
    if not nodes:
        return await persist_import_graph(
            db=db,
            conversation_id=conversation_id,
            existing_json=existing_json,
            utterances=utterances,
            conversation_name=conversation_name,
            source_type=source_type,
            source_metadata=source_metadata,
        )

    pinned_source_type = source_type  # import raw ("audio"/"text"); ignore stage remap

    async def _adapter(*, conversation_id, existing_json, metadata, source_type):  # noqa: ARG001
        return await persist_import_graph(
            db=db,
            conversation_id=conversation_id,
            existing_json=existing_json,
            utterances=utterances,
            conversation_name=conversation_name,
            source_type=pinned_source_type,
            source_metadata=source_metadata,
        )

    state = PipelineState(
        conversation_id=conversation_id,
        source_metadata=dict(source_metadata or {}),
    )
    state.graph.nodes = nodes
    state.graph_persist_requested = True

    captured: dict[str, Any] = {}

    async def _emit(event: Any) -> None:
        if isinstance(event, GraphPersisted):
            captured["count"] = event.persisted_node_count
        elif isinstance(event, StageFailed) and getattr(event, "stage", None) == "persist":
            captured["error"] = event.detail

    # Suppress the orchestrator's stage_failure artifact write so this beachhead is
    # byte-for-byte behavior-identical to the prior direct call (no new DB rows).
    async def _noop_artifact_writer(**_kwargs: Any) -> None:
        return None

    pipeline = ConversationPipeline(
        [PersistStage(persist_fn=_adapter)],
        artifact_writer=_noop_artifact_writer,
    )
    await pipeline.run(state, _emit)

    if "error" in captured:
        raise RuntimeError(captured["error"])
    return int(captured.get("count", 0))


async def persist_import_pipeline_results(
    *,
    db: AsyncSession,
    processor: Any,
    conversation_id: str,
    filename: str,
    temp_path: str,
    file_hash: Optional[str],
    final_source_type: str,
    final_source_metadata: dict[str, Any],
    final_source_utterances: list[dict[str, Any]],
    final_speaker_segments: list[dict[str, Any]],
    derived_name: str,
    executive_summary: Optional[str],
    conversation_title_from_arcs: Optional[str],
    telemetry: dict[str, Any],
    log: logging.Logger,
) -> None:
    """Persist graph, source audio, checkpoints, and speaker materialization."""
    final_metadata = dict(final_source_metadata or {}) if isinstance(final_source_metadata, dict) else {}
    if executive_summary:
        final_metadata["executive_summary"] = executive_summary
    if conversation_title_from_arcs:
        final_metadata["conversation_title"] = conversation_title_from_arcs
    try:
        persisted_count = await _persist_graph_via_pipeline(
            db=db,
            conversation_id=conversation_id,
            existing_json=processor.existing_json,
            utterances=final_source_utterances,
            conversation_name=derived_name,
            source_type=final_source_type,
            source_metadata=final_metadata,
        )
        log.info("[PROCESS FILE] Persisted %d nodes to DB for %s", persisted_count, conversation_id)
        telemetry["graph_persisted_nodes"] = persisted_count

        if final_source_type == "audio":
            try:
                from lct_python_backend.stt_api import audio_storage

                suffix = Path(temp_path).suffix.lower()
                dest = audio_storage.persist_source_audio(conversation_id, temp_path, suffix)
                if dest:
                    telemetry["source_audio_persisted"] = str(dest)
            except Exception as audio_exc:  # noqa: BLE001
                log.warning(
                    "[PROCESS FILE] source audio persist failed for %s: %s",
                    conversation_id,
                    audio_exc,
                )
                telemetry["source_audio_persist_error"] = str(audio_exc)

        await clear_import_checkpoint_safe(db, file_hash, telemetry, log)
    except Exception as persist_exc:  # noqa: BLE001
        log.warning("[PROCESS FILE] Graph persistence failed (non-fatal): %s", persist_exc)
        telemetry["graph_persist_error"] = str(persist_exc) or type(persist_exc).__name__

    if final_source_type == "audio" and final_speaker_segments:
        try:
            materialization_result = await persist_speaker_refinement(
                conversation_id=conversation_id,
                segments=final_speaker_segments,
                source_text="\n".join(
                    segment.get("text", "")
                    for segment in final_speaker_segments
                    if isinstance(segment, dict)
                ),
                provider=str(final_source_metadata.get("provider") or ""),
                model=str(final_source_metadata.get("model") or ""),
                transport=str(
                    final_source_metadata.get("transport")
                    or final_source_metadata.get("stt_backend")
                    or ""
                ),
            )
            telemetry["speaker_materialization"] = materialization_result
        except Exception as speaker_exc:  # noqa: BLE001
            speaker_error = str(speaker_exc) or type(speaker_exc).__name__
            telemetry["speaker_materialization_error"] = speaker_error
            log.warning(
                "[PROCESS FILE] Speaker materialization failed for %s: %s",
                conversation_id,
                speaker_error,
            )
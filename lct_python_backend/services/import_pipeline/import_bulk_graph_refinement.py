"""Second-pass graph refinement for bulk import processing."""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable, Optional

from .import_bulk_stage_events import ImportBulkStageEvents
from .import_bulk_telemetry import elapsed_ms

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]


async def run_import_graph_refinement(
    *,
    processor: Any,
    final_source_utterances: list[dict[str, Any]],
    final_transcript_text: str,
    runtime_llm_config: dict[str, Any],
    runtime_llm_providers: list[dict[str, Any]],
    refine_import_graph_nodes: Callable[..., Awaitable[dict[str, Any]]],
    stage_events: ImportBulkStageEvents,
    emit: EmitFn,
    telemetry: dict[str, Any],
    pipeline_started_at: float,
    conversation_id: str,
    log: logging.Logger,
) -> Optional[dict[str, Any]]:
    """Run optional second-pass graph refinement and emit status updates."""
    if not (processor.existing_json and final_source_utterances and final_transcript_text):
        return None

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
    log.info(
        "[PROCESS FILE] Graph refinement result for %s: %s",
        conversation_id,
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
    return graph_refinement_result
"""Post-import artifact auto-export for bulk processing."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.services.import_bulk_telemetry import elapsed_ms

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]


async def run_import_artifact_export(
    *,
    db: AsyncSession,
    conversation_id: str,
    load_artifact_export_settings: Callable[[AsyncSession], Awaitable[dict[str, Any]]],
    auto_export_conversation_artifacts: Callable[..., Awaitable[dict[str, Any]]],
    emit: EmitFn,
    telemetry: dict[str, Any],
    pipeline_started_at: float,
    log: logging.Logger,
) -> Optional[dict[str, Any]]:
    """Auto-export canvas/transcript artifacts when settings allow."""
    artifact_export_settings = await load_artifact_export_settings(db)
    if not (
        artifact_export_settings.get("enabled")
        and artifact_export_settings.get("trigger_on_import_complete")
    ):
        return None

    try:
        await emit(
            "status",
            {
                "stage": "exporting_artifacts",
                "progress": 0.97,
                "message": "Writing paired canvas/transcript artifacts...",
                "telemetry": {"total_elapsed_ms": elapsed_ms(pipeline_started_at)},
            },
        )
        artifact_export_payload = await auto_export_conversation_artifacts(
            db=db,
            conversation_id=conversation_id,
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
                "telemetry": {"total_elapsed_ms": elapsed_ms(pipeline_started_at)},
            },
        )
        return artifact_export_payload
    except Exception as artifact_exc:  # noqa: BLE001
        artifact_error = str(artifact_exc) or type(artifact_exc).__name__
        telemetry["artifact_export_error"] = artifact_error
        log.warning(
            "[PROCESS FILE] Artifact auto-export failed for %s: %s",
            conversation_id,
            artifact_error,
        )
        await emit(
            "status",
            {
                "level": "warning",
                "stage": "exporting_artifacts",
                "progress": 0.99,
                "message": f"Artifact export failed: {artifact_error}",
                "telemetry": {"total_elapsed_ms": elapsed_ms(pipeline_started_at)},
            },
        )
        return None
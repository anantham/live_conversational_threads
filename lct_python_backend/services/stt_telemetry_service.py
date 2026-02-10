"""STT telemetry aggregation service."""

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import select

from lct_python_backend.models import TranscriptEvent
from lct_python_backend.services.stt_config import STT_PROVIDER_IDS

logger = logging.getLogger(__name__)


def _utc_iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _to_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return round(parsed, 2)


def _empty_provider_bucket() -> Dict[str, Any]:
    return {
        "last_event_at": None,
        "last_partial_ms": None,
        "last_partial_at": None,
        "last_final_ms": None,
        "last_final_at": None,
        "avg_partial_ms": None,
        "avg_final_ms": None,
        "partial_samples": 0,
        "final_samples": 0,
        "event_count": 0,
    }


async def aggregate_telemetry(
    session, limit: int, stt_settings: Dict[str, Any]
) -> Dict[str, Any]:
    """Query recent transcript events and aggregate per-provider telemetry metrics."""
    configured_providers = list(STT_PROVIDER_IDS)
    providers: Dict[str, Dict[str, Any]] = {
        provider: _empty_provider_bucket() for provider in configured_providers
    }

    result = await session.execute(
        select(TranscriptEvent).order_by(TranscriptEvent.received_at.desc()).limit(limit)
    )
    events = result.scalars().all()

    partial_sums: Dict[str, float] = {p: 0.0 for p in providers}
    final_sums: Dict[str, float] = {p: 0.0 for p in providers}

    for event in events:
        provider = str(event.provider or "").strip().lower() or "unknown"
        if provider not in providers:
            providers[provider] = _empty_provider_bucket()
            partial_sums[provider] = 0.0
            final_sums[provider] = 0.0

        info = providers[provider]
        if info["last_event_at"] is None and event.received_at is not None:
            info["last_event_at"] = event.received_at.isoformat()
        info["event_count"] += 1

        metadata = event.event_metadata if isinstance(event.event_metadata, dict) else {}
        telemetry = metadata.get("telemetry") if isinstance(metadata.get("telemetry"), dict) else {}
        partial_ms = _to_float(telemetry.get("partial_turnaround_ms"))
        final_ms = _to_float(telemetry.get("final_turnaround_ms"))

        if partial_ms is not None:
            if info["last_partial_ms"] is None:
                info["last_partial_ms"] = partial_ms
                info["last_partial_at"] = (
                    event.received_at.isoformat() if event.received_at is not None else None
                )
            info["partial_samples"] += 1
            partial_sums[provider] += partial_ms

        if final_ms is not None:
            if info["last_final_ms"] is None:
                info["last_final_ms"] = final_ms
                info["last_final_at"] = (
                    event.received_at.isoformat() if event.received_at is not None else None
                )
            info["final_samples"] += 1
            final_sums[provider] += final_ms

    for provider, info in providers.items():
        if info["partial_samples"] > 0:
            info["avg_partial_ms"] = round(partial_sums[provider] / info["partial_samples"], 2)
        if info["final_samples"] > 0:
            info["avg_final_ms"] = round(final_sums[provider] / info["final_samples"], 2)

    return {
        "generated_at": _utc_iso_now(),
        "window_size": len(events),
        "active_provider": stt_settings.get("provider"),
        "providers": providers,
    }

"""STT telemetry aggregation service."""

import logging
import math
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
        "last_stt_request_ms": None,
        "avg_stt_request_ms": None,
        "p95_stt_request_ms": None,
        "stt_request_samples": 0,
        "last_stt_flush_request_ms": None,
        "avg_stt_flush_request_ms": None,
        "p95_stt_flush_request_ms": None,
        "stt_flush_request_samples": 0,
        "last_audio_decode_ms": None,
        "avg_audio_decode_ms": None,
        "p95_audio_decode_ms": None,
        "audio_decode_samples": 0,
        "event_count": 0,
    }


def _p95(values: list[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    # Nearest-rank percentile so small sample windows still surface tail latency.
    rank = max(1, int(math.ceil(0.95 * len(ordered))))
    idx = min(len(ordered) - 1, rank - 1)
    return round(float(ordered[idx]), 2)


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
    stt_request_sums: Dict[str, float] = {p: 0.0 for p in providers}
    stt_flush_sums: Dict[str, float] = {p: 0.0 for p in providers}
    audio_decode_sums: Dict[str, float] = {p: 0.0 for p in providers}
    stt_request_values: Dict[str, list[float]] = {p: [] for p in providers}
    stt_flush_values: Dict[str, list[float]] = {p: [] for p in providers}
    audio_decode_values: Dict[str, list[float]] = {p: [] for p in providers}

    for event in events:
        provider = str(event.provider or "").strip().lower() or "unknown"
        if provider not in providers:
            providers[provider] = _empty_provider_bucket()
            partial_sums[provider] = 0.0
            final_sums[provider] = 0.0
            stt_request_sums[provider] = 0.0
            stt_flush_sums[provider] = 0.0
            audio_decode_sums[provider] = 0.0
            stt_request_values[provider] = []
            stt_flush_values[provider] = []
            audio_decode_values[provider] = []

        info = providers[provider]
        if info["last_event_at"] is None and event.received_at is not None:
            info["last_event_at"] = event.received_at.isoformat()
        info["event_count"] += 1

        metadata = event.event_metadata if isinstance(event.event_metadata, dict) else {}
        telemetry = metadata.get("telemetry") if isinstance(metadata.get("telemetry"), dict) else {}
        partial_ms = _to_float(telemetry.get("partial_turnaround_ms"))
        final_ms = _to_float(telemetry.get("final_turnaround_ms"))
        stt_request_ms = _to_float(telemetry.get("stt_request_ms"))
        stt_flush_request_ms = _to_float(telemetry.get("stt_flush_request_ms"))
        audio_decode_ms = _to_float(telemetry.get("audio_decode_ms"))

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

        if stt_request_ms is not None:
            if info["last_stt_request_ms"] is None:
                info["last_stt_request_ms"] = stt_request_ms
            info["stt_request_samples"] += 1
            stt_request_sums[provider] += stt_request_ms
            stt_request_values[provider].append(stt_request_ms)

        if stt_flush_request_ms is not None:
            if info["last_stt_flush_request_ms"] is None:
                info["last_stt_flush_request_ms"] = stt_flush_request_ms
            info["stt_flush_request_samples"] += 1
            stt_flush_sums[provider] += stt_flush_request_ms
            stt_flush_values[provider].append(stt_flush_request_ms)

        if audio_decode_ms is not None:
            if info["last_audio_decode_ms"] is None:
                info["last_audio_decode_ms"] = audio_decode_ms
            info["audio_decode_samples"] += 1
            audio_decode_sums[provider] += audio_decode_ms
            audio_decode_values[provider].append(audio_decode_ms)

    for provider, info in providers.items():
        if info["partial_samples"] > 0:
            info["avg_partial_ms"] = round(partial_sums[provider] / info["partial_samples"], 2)
        if info["final_samples"] > 0:
            info["avg_final_ms"] = round(final_sums[provider] / info["final_samples"], 2)
        if info["stt_request_samples"] > 0:
            info["avg_stt_request_ms"] = round(
                stt_request_sums[provider] / info["stt_request_samples"], 2
            )
            info["p95_stt_request_ms"] = _p95(stt_request_values[provider])
        if info["stt_flush_request_samples"] > 0:
            info["avg_stt_flush_request_ms"] = round(
                stt_flush_sums[provider] / info["stt_flush_request_samples"], 2
            )
            info["p95_stt_flush_request_ms"] = _p95(stt_flush_values[provider])
        if info["audio_decode_samples"] > 0:
            info["avg_audio_decode_ms"] = round(
                audio_decode_sums[provider] / info["audio_decode_samples"], 2
            )
            info["p95_audio_decode_ms"] = _p95(audio_decode_values[provider])

    return {
        "generated_at": _utc_iso_now(),
        "window_size": len(events),
        "active_provider": stt_settings.get("provider"),
        "providers": providers,
    }

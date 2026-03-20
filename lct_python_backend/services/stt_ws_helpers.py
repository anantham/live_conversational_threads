"""Pure helper functions for the STT WebSocket session handler.

Extracted from stt_api.py to keep the router file focused on route wiring
and session orchestration. All functions here are stateless and free of
FastAPI / router dependencies.
"""

import logging
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from lct_python_backend.services.stt_config import STT_PROVIDER_IDS


# ---------------------------------------------------------------------------
# Numeric coercion helpers
# ---------------------------------------------------------------------------

def safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def now_ms() -> int:
    """Current wall-clock time in milliseconds."""
    return int(time.time() * 1000)


def elapsed_ms(started_at: float) -> float:
    """Milliseconds elapsed since a `time.perf_counter()` snapshot."""
    return round(max(0.0, (time.perf_counter() - started_at) * 1000.0), 2)


def coerce_latency_ms(value: Any) -> Optional[float]:
    """Return a non-negative latency value or None if the input is invalid."""
    parsed = safe_float(value, -1.0)
    if parsed < 0:
        return None
    return round(parsed, 2)


# ---------------------------------------------------------------------------
# Telemetry helpers
# ---------------------------------------------------------------------------

def build_telemetry_metadata(
    telemetry_state: Dict[str, Optional[int]],
    event_type: str,
    stage_metrics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Construct the telemetry metadata dict for a transcript event.

    Mutates *telemetry_state* to record first-partial / first-final
    timestamps on the first call for each event type.
    """
    now = now_ms()
    if event_type == "partial" and not telemetry_state.get("first_partial_at_ms"):
        telemetry_state["first_partial_at_ms"] = now
    if event_type == "final" and not telemetry_state.get("first_final_at_ms"):
        telemetry_state["first_final_at_ms"] = now

    started = telemetry_state.get("audio_send_started_at_ms")
    first_partial = telemetry_state.get("first_partial_at_ms")
    first_final = telemetry_state.get("first_final_at_ms")
    telemetry: Dict[str, Any] = {
        "event_received_at_ms": now,
        "audio_send_started_at_ms": started,
        "first_partial_at_ms": first_partial,
        "first_final_at_ms": first_final,
        "partial_turnaround_ms": (first_partial - started) if started and first_partial else None,
        "final_turnaround_ms": (first_final - started) if started and first_final else None,
    }
    if isinstance(stage_metrics, dict):
        for key, value in stage_metrics.items():
            if not key:
                continue
            parsed = coerce_latency_ms(value)
            if parsed is None:
                continue
            telemetry[str(key)] = parsed
    return telemetry


# ---------------------------------------------------------------------------
# STT provider helpers
# ---------------------------------------------------------------------------

def normalize_provider(provider: Any, fallback_provider: Any) -> str:
    """Return a canonical provider ID, falling back to 'parakeet' if unknown."""
    candidate = str(provider or "").strip().lower()
    if candidate in STT_PROVIDER_IDS:
        return candidate
    fallback = str(fallback_provider or "").strip().lower()
    if fallback in STT_PROVIDER_IDS:
        return fallback
    return "parakeet"


def should_emit_final_segment(
    latest_text: str,
    pending_parts: List[str],
    pending_chars: int,
) -> bool:
    """Return True when accumulated partials form a complete enough segment."""
    text = str(latest_text or "").strip()
    if not text:
        return False
    if len(pending_parts) >= 3:
        return True
    if pending_chars >= 180:
        return True
    return text.endswith((".", "!", "?", ";"))


# ---------------------------------------------------------------------------
# WebSocket send helpers
# ---------------------------------------------------------------------------

def ws_is_connected(websocket: WebSocket) -> bool:
    """Return True when the WebSocket is in the CONNECTED state."""
    try:
        return websocket.client_state.name == "CONNECTED"
    except Exception as exc:
        logger.debug("[WS] client_state check failed: %s", exc)
        return False


async def safe_send_json(websocket: WebSocket, payload: Dict[str, Any]) -> bool:
    """Send JSON to the WebSocket, swallowing disconnect/runtime errors.

    Returns True if the send succeeded.
    """
    if not ws_is_connected(websocket):
        return False
    try:
        await websocket.send_json(payload)
        return True
    except (WebSocketDisconnect, RuntimeError):
        return False


async def send_processor_update(
    websocket: WebSocket,
    existing_json: Any,
    chunk_dict: Any,
    logger: Any,
) -> None:
    """Push graph snapshot (existing_json + chunk_dict) to the client."""
    try:
        if websocket.client_state.name != "CONNECTED":
            return
        await websocket.send_json({"type": "existing_json", "data": existing_json})
        await websocket.send_json({"type": "chunk_dict", "data": chunk_dict})
    except WebSocketDisconnect:
        logger.info("[WS] Processor update failed - client disconnected")
    except RuntimeError:
        logger.info("[WS] Processor update failed - websocket already closed")

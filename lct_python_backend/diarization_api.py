"""Diarization settings + health-check endpoints.

Diarization is its own capability lane in Settings. These routes mirror the STT
settings/health-check surface so the UI can read/write the diarization config and
probe each backend independently.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.diarization_config import DIARIZATION_PROVIDER_IDS
from lct_python_backend.services.diarization_settings_service import (
    load_diarization_settings,
    load_diarization_settings_for_client,
    save_diarization_settings,
)
from lct_python_backend.services.stt.stt_health_service import probe_health_url

logger = logging.getLogger("lct_backend")

router = APIRouter()


@router.get("/api/settings/diarization")
async def read_diarization_settings(session=Depends(get_async_session)):
    return await load_diarization_settings_for_client(session)


@router.put("/api/settings/diarization")
async def update_diarization_settings(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")
    return await save_diarization_settings(session, payload)


@router.post("/api/settings/diarization/health-check")
async def diarization_health_check(payload: Dict[str, Any], session=Depends(get_async_session)):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")

    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in DIARIZATION_PROVIDER_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"provider must be one of: {', '.join(DIARIZATION_PROVIDER_IDS)}",
        )

    settings = await load_diarization_settings(session)
    backend = settings.get("backends", {}).get(provider, {}) if isinstance(settings.get("backends"), dict) else {}
    checked_at = datetime.utcnow().isoformat() + "Z"

    # FluidAudio / Senko run as HTTP sidecars → probe their health URL.
    url = str(payload.get("url") or backend.get("url") or "").strip()
    if provider in {"fluidaudio", "senko"}:
        if not url:
            return {
                "provider": provider, "checked_at": checked_at, "ok": False,
                "status": "not_configured",
                "error": f"No URL configured for the {provider} sidecar. "
                         f"{'Build/start the FluidAudio sidecar (planned).' if provider == 'fluidaudio' else 'Start the Senko service and set its URL.'}",
            }
        health_url = url.rstrip("/")
        if not health_url.endswith("/health"):
            health_url = f"{health_url}/health"
        try:
            timeout_seconds = min(max(float(payload.get("timeout_seconds", 3.0)), 0.5), 15.0)
        except (TypeError, ValueError):
            timeout_seconds = 3.0
        probe = await asyncio.to_thread(probe_health_url, health_url, timeout_seconds)
        return {"provider": provider, "health_url": health_url, "checked_at": checked_at, **probe}

    # pyannote runs in-process (post-flush refinement) → report config-derived status.
    enabled = bool(backend.get("enabled"))
    token_ok = bool(backend.get("hf_token_set"))
    if not enabled:
        status, ok, error = "disabled", False, "pyannote diarization is disabled in config."
    elif not token_ok:
        status, ok, error = "no_token", False, "pyannote requires a HuggingFace token (STT_PYANNOTE_HF_TOKEN / HF_TOKEN)."
    else:
        status, ok, error = "configured", True, None
    return {
        "provider": provider,
        "checked_at": checked_at,
        "ok": ok,
        "status": status,
        "error": error,
        "device": backend.get("device"),
        "warning": "MPS produces incorrect diarization on Apple Silicon; CPU is slow." if backend.get("device") == "mps" else None,
    }

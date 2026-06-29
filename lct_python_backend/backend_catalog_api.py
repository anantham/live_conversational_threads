"""Inference backend catalog endpoint.

GET /api/backend-catalog returns the merged catalog (benchmark seed + live
telemetry + active-config flags) for all three capability lanes (STT /
Diarization / LLM) that powers the 3-lane Settings UI and the home status chips.

Live health probing is intentionally NOT done here (it stays client-driven via the
existing /health-check endpoints) so this endpoint stays fast. This route only
reads cheap config + already-aggregated telemetry.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.backend_catalog import build_catalog, load_seed
from lct_python_backend.services.llm_config import load_llm_config, load_llm_providers
from lct_python_backend.services.stt.stt_config import STT_CLOUD_PROVIDER_IDS
from lct_python_backend.services.stt.stt_health_service import (
    derive_health_url_from_http_url,
    probe_health_url,
)
from lct_python_backend.services.stt.stt_settings_service import load_stt_settings
from lct_python_backend.services.stt.stt_telemetry_service import aggregate_telemetry

logger = logging.getLogger("lct_backend")

router = APIRouter()


def _health_url_from_base(base: str) -> str:
    base = str(base or "").rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/health") else f"{base}/health"


async def _resolve_probe_url(
    *, capability: str, entry: Dict[str, Any], stt_settings: Dict[str, Any], diar_settings: Dict[str, Any]
) -> Optional[str]:
    """Resolve a server-controlled health URL for a catalog entry (SSRF-safe)."""
    seed_probe = ((entry.get("health") or {}).get("probe_url")) if isinstance(entry.get("health"), dict) else None

    if capability == "stt":
        # Cloud STT providers have no HTTP /health endpoint. Deriving one from the
        # configured provider_http_urls (which has no cloud entry, so falls back to
        # the Whisper URL) would falsely mark the cloud backend healthy whenever
        # Whisper answers. Report no_probe; the UI uses the cloud-provider-test
        # (/api/settings/stt/cloud-provider-test) for these instead.
        if str(entry.get("provider_key") or "").lower() in STT_CLOUD_PROVIDER_IDS:
            return None
        # For the active local whisper server use the configured endpoint's /health,
        # so a user who repointed the URL still probes the right place.
        if entry.get("is_active"):
            provider = str(stt_settings.get("provider") or "").lower()
            http_urls = stt_settings.get("provider_http_urls") if isinstance(stt_settings.get("provider_http_urls"), dict) else {}
            configured = str(http_urls.get(provider) or stt_settings.get("http_url") or "").strip()
            if configured:
                return derive_health_url_from_http_url(configured)
        return seed_probe

    if capability == "diarization":
        provider = str(entry.get("provider_key") or "").lower()
        backends = diar_settings.get("backends") if isinstance(diar_settings.get("backends"), dict) else {}
        url = str((backends.get(provider) or {}).get("url") or "").strip()
        return _health_url_from_base(url) if url else None

    return seed_probe  # llm + fallthrough use the seed probe url


@router.post("/api/backend-catalog/probe")
async def probe_backend_entry(payload: Dict[str, Any], session=Depends(get_async_session)):
    """Live-probe a single catalog backend by (capability, id).

    The client only names an entry — the server resolves the URL from the seed /
    config, so this never probes arbitrary client-supplied URLs.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")
    capability = str(payload.get("capability") or "").strip().lower()
    entry_id = str(payload.get("id") or "").strip()
    if capability not in {"stt", "llm", "diarization"} or not entry_id:
        raise HTTPException(status_code=400, detail="capability (stt|llm|diarization) and id are required.")

    stt_settings = await load_stt_settings(session)
    diar_settings = await _safe_diar_settings(session)
    catalog = build_catalog(
        stt_settings=stt_settings,
        llm_settings=await load_llm_config(session),
        diar_settings=diar_settings,
    )
    entry = next((e for e in catalog.get(capability, []) if e.get("id") == entry_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"No {capability} backend with id '{entry_id}'.")

    checked_at = datetime.utcnow().isoformat() + "Z"
    # pyannote runs in-process — report config status instead of an HTTP probe.
    if capability == "diarization" and entry.get("provider_key") == "pyannote":
        backend = (diar_settings.get("backends") or {}).get("pyannote", {})
        ok = bool(backend.get("enabled")) and bool(backend.get("hf_token_set"))
        return {
            "id": entry_id, "capability": capability, "checked_at": checked_at,
            "ok": ok, "status": "configured" if ok else "needs_setup",
            "probe_kind": "in_process",
            "error": None if ok else "pyannote needs to be enabled with a HuggingFace token.",
        }

    health_url = await _resolve_probe_url(
        capability=capability, entry=entry, stt_settings=stt_settings, diar_settings=diar_settings
    )
    if not health_url:
        return {
            "id": entry_id, "capability": capability, "checked_at": checked_at,
            "ok": None, "status": "no_probe", "probe_kind": "none",
            "error": None,
            "note": "No health endpoint to probe (cloud or unconfigured backend). Use a real-inference test instead.",
        }

    try:
        timeout_seconds = min(max(float(payload.get("timeout_seconds", 3.0)), 0.5), 15.0)
    except (TypeError, ValueError):
        timeout_seconds = 3.0
    probe = await asyncio.to_thread(probe_health_url, health_url, timeout_seconds)
    return {
        "id": entry_id, "capability": capability, "checked_at": checked_at,
        "health_url": health_url, "probe_kind": "http", **probe,
    }


async def _safe_diar_settings(session):
    """Diarization config service lands in a later task; degrade gracefully."""
    try:
        from lct_python_backend.services.diarization_settings_service import (
            load_diarization_settings_for_client,
        )
    except Exception:  # noqa: BLE001 - optional until the service exists
        return {}
    try:
        return await load_diarization_settings_for_client(session)
    except Exception:  # noqa: BLE001
        logger.exception("[CATALOG] diarization settings load failed; using defaults")
        return {}


async def _safe_llm_telemetry(session):
    """LLM telemetry aggregation lands in a later task; degrade gracefully."""
    try:
        from lct_python_backend.services.llm_telemetry_service import aggregate_llm_telemetry
    except Exception:  # noqa: BLE001 - optional until the service exists
        return {}
    try:
        return await aggregate_llm_telemetry(session, 400)
    except Exception:  # noqa: BLE001
        logger.exception("[CATALOG] LLM telemetry aggregation failed; using empty")
        return {}


@router.get("/api/backend-catalog")
async def read_backend_catalog(session=Depends(get_async_session)):
    stt_settings = await load_stt_settings(session)
    llm_settings = await load_llm_config(session)
    llm_providers_config = await load_llm_providers(session, include_secrets=False)
    llm_providers = llm_providers_config.get("providers") if isinstance(llm_providers_config, dict) else []

    stt_telemetry = await aggregate_telemetry(session, 400, stt_settings)
    llm_telemetry = await _safe_llm_telemetry(session)
    diar_settings = await _safe_diar_settings(session)

    return build_catalog(
        stt_settings=stt_settings,
        llm_settings=llm_settings,
        llm_providers=llm_providers if isinstance(llm_providers, list) else [],
        diar_settings=diar_settings,
        stt_telemetry=stt_telemetry,
        llm_telemetry=llm_telemetry,
    )

"""Inference backend catalog: merge benchmark seed + live telemetry + active config.

The catalog is the single source of truth behind the 3-lane Settings UI (STT /
Diarization / LLM). It answers, per backend: what model, where it runs, how fast
(empirical), how accurate, what it costs, and whether it's the one currently
active. Static facts come from ``data/backend_catalog_seed.json`` (benchmark
derived); live numbers (observed latency + sample count) come from the per-provider
telemetry aggregates. We attach observed numbers ONLY to the active backend, since
telemetry is keyed per provider, not per engine variant — so we never imply that an
idle engine has live measurements it doesn't.

Live HEALTH probing stays client-driven (the existing /health-check endpoints), so
this endpoint stays fast and the UI controls probe cadence. See ADR for rationale.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from functools import lru_cache
from typing import Any, Dict, List, Optional

from lct_python_backend.services.llm_telemetry_service import catalog_provider_key

logger = logging.getLogger("lct_backend")

_SEED_FILENAME = "backend_catalog_seed.json"


def _seed_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", _SEED_FILENAME)


@lru_cache(maxsize=1)
def _load_seed_cached(mtime_key: float) -> Dict[str, Any]:  # noqa: ARG001 - mtime busts cache
    path = _seed_path()
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_seed() -> Dict[str, Any]:
    """Load the benchmark seed, re-reading if the file changed on disk."""
    path = _seed_path()
    try:
        mtime = os.path.getmtime(path)
    except OSError as exc:
        logger.error("[CATALOG] Seed file missing at %s: %s", path, exc)
        return {"stt": [], "llm": [], "diarization": [], "_meta": {}}
    try:
        return _load_seed_cached(mtime)
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("[CATALOG] Failed to parse seed %s: %s", path, exc)
        return {"stt": [], "llm": [], "diarization": [], "_meta": {}}


# ── active-backend matching ─────────────────────────────────────────────────

def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _active_stt_id(stt_entries: List[Dict[str, Any]], stt_settings: Dict[str, Any]) -> Optional[str]:
    """Pick which catalog STT entry is currently active from the configured provider."""
    provider = _norm(stt_settings.get("provider"))
    if not provider:
        return None
    provider_http_urls = (
        stt_settings.get("provider_http_urls")
        if isinstance(stt_settings.get("provider_http_urls"), dict)
        else {}
    )
    configured_url = _norm(provider_http_urls.get(provider) or stt_settings.get("http_url"))

    matching = [e for e in stt_entries if _norm(e.get("provider_key")) == provider]
    if not matching:
        return None
    # Several engines can share provider_key="whisper". Disambiguate by endpoint URL,
    # then fall back to the bundled default, then the first match.
    if configured_url:
        for entry in matching:
            endpoint = _norm(entry.get("endpoint"))
            if endpoint and endpoint == configured_url:
                return entry["id"]
        # Loose host:port match for the bundled local server (127.0.0.1:5095).
        for entry in matching:
            endpoint = _norm(entry.get("endpoint"))
            if endpoint and endpoint.split("/v1/")[0] in configured_url:
                return entry["id"]
    for entry in matching:
        if entry.get("is_default_local"):
            return entry["id"]
    return matching[0]["id"]


def _llm_first(llm_entries: List[Dict[str, Any]], predicate) -> Optional[str]:
    for entry in llm_entries:
        if predicate(entry):
            return entry["id"]
    return None


def _llm_id_for_base_url(llm_entries: List[Dict[str, Any]], base_url: str) -> Optional[str]:
    base_url = _norm(base_url)
    if "11434" in base_url:
        return _llm_first(llm_entries, lambda e: e["id"] == "local-ollama")
    if "100.81.65.74" in base_url or "tailscale" in base_url:
        return _llm_first(llm_entries, lambda e: e["id"] == "tailscale-rtx-llm")
    if "1234" in base_url:
        return _llm_first(llm_entries, lambda e: e["id"] == "local-lmstudio")
    return None


def _active_llm_id(llm_entries: List[Dict[str, Any]], llm_settings: Dict[str, Any]) -> Optional[str]:
    """The SELECTED LLM (what the lane edits via llm_config: mode + base_url).

    This is a preference, not necessarily what graph-gen runs — see
    _effective_llm_id. Online mode is Gemini (generate_lct_json routes online→Gemini).
    """
    mode = _norm(llm_settings.get("mode"))
    if mode == "online":
        return _llm_first(llm_entries, lambda e: e["id"] == "cloud-gemini")
    return _llm_id_for_base_url(llm_entries, llm_settings.get("base_url")) or _llm_first(
        llm_entries, lambda e: e.get("is_default_local")
    )


def _effective_llm_id(
    llm_entries: List[Dict[str, Any]],
    llm_settings: Dict[str, Any],
    llm_providers: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    """The LLM graph-gen ACTUALLY uses (mirrors generate_lct_json).

    Online → Gemini; local → the first ENABLED provider in the llm_providers list
    (generate_lct_json_local ignores llm_config.base_url), falling back to the
    config heuristic only when no providers resolve.
    """
    if _norm(llm_settings.get("mode")) == "online":
        return _llm_first(llm_entries, lambda e: e["id"] == "cloud-gemini")
    for provider in llm_providers or []:
        if not isinstance(provider, dict) or not provider.get("enabled", True):
            continue
        provider_key = catalog_provider_key(provider.get("base_url"), provider.get("type"))
        match = _llm_first(llm_entries, lambda e, pk=provider_key: _norm(e.get("provider_key")) == pk)
        if match:
            return match
        break  # first enabled provider decides; if no catalog entry, fall through
    return _active_llm_id(llm_entries, llm_settings)


def _active_diar_id(diar_entries: List[Dict[str, Any]], diar_settings: Optional[Dict[str, Any]]) -> Optional[str]:
    primary = _norm((diar_settings or {}).get("primary"))
    if primary:
        for entry in diar_entries:
            if _norm(entry.get("provider_key")) == primary or _norm(entry.get("id")) == primary:
                return entry["id"]
    for entry in diar_entries:
        if entry.get("is_default_local"):
            return entry["id"]
    return diar_entries[0]["id"] if diar_entries else None


# ── runnable / effective resolution ──────────────────────────────────────────
# "Active" = the backend the user SELECTED as primary (a preference). That is NOT
# the same as "running". A backend whose runtime isn't built (status=planned) or
# failed to install can be selected yet serve nothing. We expose `runnable` per
# entry and an `*_effective` id per lane = what would ACTUALLY serve right now, so
# the UI never shows a green "active" for something that isn't running.

_NOT_RUNNABLE_STATUSES = {"planned", "install_failed"}


def _simple_runnable(entry: Dict[str, Any]) -> bool:
    return entry.get("status") not in _NOT_RUNNABLE_STATUSES


def _diar_runnable(entry: Dict[str, Any], diar_settings: Dict[str, Any]) -> bool:
    """A diarizer is runnable only if its runtime exists AND it's configured."""
    if entry.get("status") in _NOT_RUNNABLE_STATUSES:
        return False
    pk = _norm(entry.get("provider_key"))
    backends = diar_settings.get("backends") if isinstance(diar_settings.get("backends"), dict) else {}
    cfg = backends.get(pk) if isinstance(backends.get(pk), dict) else {}
    if pk == "pyannote":
        return bool(cfg.get("enabled")) and bool(cfg.get("hf_token_set"))
    if pk == "senko":
        return bool(str(cfg.get("url") or "").strip())
    if pk == "fluidaudio":
        return bool(str(cfg.get("url") or "").strip())  # needs the sidecar URL
    return True


def _effective_simple_id(entries: List[Dict[str, Any]], selected_id: Optional[str]) -> Optional[str]:
    by_id = {e.get("id"): e for e in entries}
    selected = by_id.get(selected_id)
    if selected and _simple_runnable(selected):
        return selected_id
    for entry in entries:
        if _simple_runnable(entry):
            return entry["id"]
    return None


def _effective_diar_id(
    diar_entries: List[Dict[str, Any]], diar_settings: Dict[str, Any], selected_id: Optional[str]
) -> Optional[str]:
    """Walk [selected, primary] + fallback_priority and return the first one that can run."""
    by_pk = {_norm(e.get("provider_key")): e for e in diar_entries}
    by_id = {e.get("id"): e for e in diar_entries}
    # Seed the walk from the already-resolved selected entry so _active_diar_id
    # (matches on provider_key OR id) and this resolver can never disagree.
    selected = by_id.get(selected_id)
    order = []
    if selected:
        order.append(_norm(selected.get("provider_key")))
    order.append(_norm(diar_settings.get("primary")))
    order += [_norm(p) for p in (diar_settings.get("fallback_priority") or [])]
    seen = set()
    for pk in order:
        if not pk or pk in seen:
            continue
        seen.add(pk)
        entry = by_pk.get(pk)
        if entry and _diar_runnable(entry, diar_settings):
            return entry["id"]
    for entry in diar_entries:
        if _diar_runnable(entry, diar_settings):
            return entry["id"]
    return None


# ── observed-telemetry attachment ───────────────────────────────────────────

def _stt_observed(bucket: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Shape a live STT telemetry bucket into the catalog 'observed' block."""
    if not isinstance(bucket, dict):
        return None
    samples = int(bucket.get("final_samples") or 0) + int(bucket.get("stt_request_samples") or 0)
    if samples <= 0 and not bucket.get("last_event_at"):
        return None
    return {
        "source": "live_telemetry",
        "samples": samples,
        "avg_request_ms": bucket.get("avg_stt_request_ms"),
        "p95_request_ms": bucket.get("p95_stt_request_ms"),
        "avg_final_ms": bucket.get("avg_final_ms"),
        "avg_partial_ms": bucket.get("avg_partial_ms"),
        "last_seen": bucket.get("last_event_at"),
    }


def _llm_observed(bucket: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Shape a live LLM telemetry bucket into the catalog 'observed' block."""
    if not isinstance(bucket, dict):
        return None
    samples = int(bucket.get("samples") or 0)
    if samples <= 0 and not bucket.get("last_seen"):
        return None
    return {
        "source": "live_telemetry",
        "samples": samples,
        "avg_tokens_per_sec": bucket.get("avg_tokens_per_sec"),
        "avg_first_token_ms": bucket.get("avg_first_token_ms"),
        "avg_total_ms": bucket.get("avg_total_ms"),
        "p95_total_ms": bucket.get("p95_total_ms"),
        "valid_json_rate": bucket.get("valid_json_rate"),
        "last_seen": bucket.get("last_seen"),
    }


# ── public builder ──────────────────────────────────────────────────────────

def build_catalog(
    *,
    stt_settings: Optional[Dict[str, Any]] = None,
    llm_settings: Optional[Dict[str, Any]] = None,
    llm_providers: Optional[List[Dict[str, Any]]] = None,
    diar_settings: Optional[Dict[str, Any]] = None,
    stt_telemetry: Optional[Dict[str, Any]] = None,
    llm_telemetry: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Merge the benchmark seed with live config + telemetry into a client catalog."""
    seed = load_seed()
    stt_settings = stt_settings or {}
    llm_settings = llm_settings or {}
    diar_settings = diar_settings or {}

    stt_entries = [dict(e) for e in seed.get("stt", [])]
    llm_entries = [dict(e) for e in seed.get("llm", [])]
    diar_entries = [dict(e) for e in seed.get("diarization", [])]

    active_stt = _active_stt_id(stt_entries, stt_settings)
    active_llm = _active_llm_id(llm_entries, llm_settings)
    active_diar = _active_diar_id(diar_entries, diar_settings)

    stt_buckets = (stt_telemetry or {}).get("providers") if isinstance(stt_telemetry, dict) else {}
    stt_buckets = stt_buckets if isinstance(stt_buckets, dict) else {}
    llm_buckets = (llm_telemetry or {}).get("providers") if isinstance(llm_telemetry, dict) else {}
    llm_buckets = llm_buckets if isinstance(llm_buckets, dict) else {}

    runtime_labels = (seed.get("_meta", {}) or {}).get("runtime_locations", {})

    def decorate(entry: Dict[str, Any], active_id: Optional[str], observed: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        entry["runtime_label"] = runtime_labels.get(entry.get("runtime"), entry.get("runtime"))
        entry["is_active"] = entry.get("id") == active_id
        entry["is_local"] = bool(entry.get("is_local"))
        entry.setdefault("enabled", entry.get("status") not in {"install_failed"})
        # Only attach live numbers to the active backend (telemetry is per-provider).
        entry["observed"] = observed if entry["is_active"] else None
        entry.pop("_README", None)
        return entry

    for entry in stt_entries:
        bucket = stt_buckets.get(_norm(entry.get("provider_key"))) if entry.get("id") == active_stt else None
        decorate(entry, active_stt, _stt_observed(bucket) if bucket else None)
        entry["runnable"] = _simple_runnable(entry)
    for entry in llm_entries:
        bucket = llm_buckets.get(_norm(entry.get("provider_key"))) if entry.get("id") == active_llm else None
        decorate(entry, active_llm, _llm_observed(bucket) if bucket else None)
        entry["runnable"] = _simple_runnable(entry)
    for entry in diar_entries:
        decorate(entry, active_diar, None)
        entry["runnable"] = _diar_runnable(entry, diar_settings)

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "meta": seed.get("_meta", {}),
        "active": {
            "stt": active_stt,
            "llm": active_llm,
            "diarization": active_diar,
            # What would ACTUALLY serve right now (selected if runnable, else first
            # runnable fallback). Differs from the selected id when a chosen backend
            # isn't built/configured (e.g. FluidAudio sidecar not running yet).
            "stt_effective": _effective_simple_id(stt_entries, active_stt),
            "llm_effective": _effective_llm_id(llm_entries, llm_settings, llm_providers),
            "diarization_effective": _effective_diar_id(diar_entries, diar_settings, active_diar),
        },
        "stt": stt_entries,
        "llm": llm_entries,
        "diarization": diar_entries,
    }

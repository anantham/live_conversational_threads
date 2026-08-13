"""Diarization configuration: env defaults, merge, and client sanitization.

Diarization ("who spoke") is a separate capability from STT ("what words"). Until
now it was env-gated only (STT_PARAKEET_PYANNOTE_ENABLED + pyannote knobs) with no
UI. This module gives it a first-class config surface — a selectable primary
backend (FluidAudio / Senko / pyannote), a fallback order, and per-backend knobs —
persisted under the ``diarization_config`` AppSetting key, mirroring the STT/LLM
config services.

FluidAudio is the intended default (ANE, emits speaker embeddings → voice
enrollment / contact auto-labelling). Its Swift service is bundled, but remains an
explicitly enabled runtime because it only runs on Apple Silicon. The config stores
the user's PREFERENCE; availability is reported separately via the backend catalog.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from lct_python_backend.services.coercion_helpers import to_bool, coerce_str, safe_int

DIARIZATION_CONFIG_KEY = "diarization_config"
DIARIZATION_PROVIDER_IDS = ("fluidaudio", "senko", "pyannote")
DEFAULT_FLUIDAUDIO_URL = "http://127.0.0.1:5096"


def _env_pyannote_enabled() -> bool:
    return to_bool(os.getenv("STT_PARAKEET_PYANNOTE_ENABLED", "false"))


def get_env_diarization_defaults() -> Dict[str, Any]:
    """Seed diarization config from environment + the existing pyannote knobs."""
    pyannote_enabled = _env_pyannote_enabled()
    return {
        # Diarization on by default if anything is wired; FluidAudio is the
        # preferred primary even when this host has not enabled the M5 service.
        "enabled": pyannote_enabled or to_bool(os.getenv("DIARIZATION_ENABLED", "true")),
        "primary": os.getenv("DIARIZATION_PRIMARY", "fluidaudio").strip().lower(),
        "fallback_priority": ["senko", "pyannote"],
        "contact_mapping_enabled": to_bool(os.getenv("DIARIZATION_CONTACT_MAPPING", "true")),
        "voice_enrollment_enabled": to_bool(os.getenv("DIARIZATION_VOICE_ENROLLMENT", "true")),
        "backends": {
            "fluidaudio": {
                "enabled": to_bool(os.getenv("DIARIZATION_FLUIDAUDIO_ENABLED", "false")),
                "url": os.getenv("DIARIZATION_FLUIDAUDIO_URL", DEFAULT_FLUIDAUDIO_URL),
                "min_speakers": None,
                "max_speakers": None,
            },
            "senko": {
                "enabled": to_bool(os.getenv("DIARIZATION_SENKO_ENABLED", "false")),
                "url": os.getenv("DIARIZATION_SENKO_URL", ""),
                "min_speakers": None,
                "max_speakers": None,
            },
            "pyannote": {
                "enabled": pyannote_enabled,
                "model": os.getenv("STT_PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1"),
                "device": os.getenv("STT_PYANNOTE_DEVICE", "cpu"),
                "min_speakers": safe_int(os.getenv("STT_PYANNOTE_MIN_SPEAKERS", "1"), 1),
                "max_speakers": safe_int(os.getenv("STT_PYANNOTE_MAX_SPEAKERS", "6"), 6),
                "hf_token_set": bool(
                    os.getenv("STT_PYANNOTE_HF_TOKEN") or os.getenv("HF_TOKEN")
                ),
            },
        },
    }


def _normalize_backend(provider_id: str, raw: Any, default: Dict[str, Any]) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    merged = dict(default)
    merged["enabled"] = to_bool(raw.get("enabled", default.get("enabled", False)))
    if "url" in default:
        merged["url"] = coerce_str(raw.get("url", default.get("url", "")))
    for key in ("min_speakers", "max_speakers"):
        if key in default:
            val = raw.get(key, default.get(key))
            merged[key] = None if val in (None, "", "null") else safe_int(val, default.get(key) or 0)
    if provider_id == "pyannote":
        merged["model"] = coerce_str(raw.get("model", default.get("model", "")))
        merged["device"] = coerce_str(raw.get("device", default.get("device", "cpu"))) or "cpu"
        # hf_token_set is derived from env, never client-writable.
        merged["hf_token_set"] = bool(default.get("hf_token_set"))
    return merged


def merge_diarization_config(overrides: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    config = get_env_diarization_defaults()
    if not overrides:
        return config

    config["enabled"] = to_bool(overrides.get("enabled", config["enabled"]))
    config["contact_mapping_enabled"] = to_bool(
        overrides.get("contact_mapping_enabled", config["contact_mapping_enabled"])
    )
    config["voice_enrollment_enabled"] = to_bool(
        overrides.get("voice_enrollment_enabled", config["voice_enrollment_enabled"])
    )

    primary = coerce_str(overrides.get("primary")).lower()
    if primary in DIARIZATION_PROVIDER_IDS:
        config["primary"] = primary

    raw_priority = overrides.get("fallback_priority")
    if isinstance(raw_priority, list):
        ordered = [p for p in (coerce_str(x).lower() for x in raw_priority) if p in DIARIZATION_PROVIDER_IDS]
        # De-dup, drop the primary, then append any missing providers.
        seen, cleaned = set(), []
        for p in ordered:
            if p != config["primary"] and p not in seen:
                seen.add(p)
                cleaned.append(p)
        for p in DIARIZATION_PROVIDER_IDS:
            if p != config["primary"] and p not in seen:
                cleaned.append(p)
        config["fallback_priority"] = cleaned

    incoming_backends = overrides.get("backends") if isinstance(overrides.get("backends"), dict) else {}
    for provider_id in DIARIZATION_PROVIDER_IDS:
        config["backends"][provider_id] = _normalize_backend(
            provider_id,
            incoming_backends.get(provider_id),
            config["backends"][provider_id],
        )

    return config


def sanitize_diarization_config_for_client(config: Dict[str, Any]) -> Dict[str, Any]:
    """No raw secrets live in diarization config; this is a defensive passthrough."""
    sanitized = dict(config)
    backends = sanitized.get("backends")
    if isinstance(backends, dict):
        sanitized["backends"] = {k: dict(v) if isinstance(v, dict) else v for k, v in backends.items()}
    return sanitized

"""Pure helpers extracted from ``import_bulk_pipeline``.

Kept stateless and side-effect-free so the mega-worker in
``import_bulk_pipeline.run_bulk_processing_worker`` can stay readable.
None of these touch the database, emit events, or hold mutable state.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Optional

from lct_python_backend.services.audio_transcriber import _is_retryable_stt_error


# ---------------------------------------------------------------------------
# Environment-tunable constants
# ---------------------------------------------------------------------------

# Files larger than this use segmented (progressive) transcription.
# Default: 10 MB ≈ 10+ minutes of audio.
SEGMENT_PROCESSING_THRESHOLD_BYTES: int = int(
    os.getenv("SEGMENT_PROCESSING_THRESHOLD_BYTES", str(10 * 1024 * 1024))
)

# Override to force segmented processing on every audio file.
SEGMENT_PROCESSING_FORCE_ENABLED: bool = (
    os.getenv("SEGMENT_PROCESSING_FORCE_ENABLED", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)

AUDIO_SUFFIXES: frozenset[str] = frozenset({
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
    ".flac",
    ".aac",
    ".webm",
    ".mp4",
})


# ---------------------------------------------------------------------------
# Audio duration
# ---------------------------------------------------------------------------

def get_audio_duration_ms(file_path: Path) -> Optional[float]:
    """Return audio duration in milliseconds via ffprobe, or None."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            duration_seconds = float(result.stdout.strip())
            return duration_seconds * 1000
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        pass
    return None


def format_duration_for_display(ms: Optional[float]) -> str:
    """Format a millisecond duration as a human-readable string."""
    if ms is None or not isinstance(ms, (int, float)) or ms <= 0:
        return ""
    total_seconds = int(ms / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


# ---------------------------------------------------------------------------
# Backend label resolution (for telemetry / display)
# ---------------------------------------------------------------------------

def resolve_candidate_backend_label(
    candidate: Optional[dict[str, Any]],
    fallback_http_url: str,
) -> str:
    """Resolve a human-readable backend label for STT telemetry."""
    if isinstance(candidate, dict):
        transport = str(candidate.get("transport") or "").strip().lower()
        provider = str(candidate.get("provider") or "").strip().lower()
        http_url = str(candidate.get("http_url") or candidate.get("base_url") or "").strip()
        if transport in {"openai_audio", "openrouter_audio"}:
            return f"cloud_{transport}"
        if provider:
            if "modal" in http_url.lower():
                return f"modal_{provider}"
            if "127.0.0.1" in http_url or "localhost" in http_url:
                return f"local_{provider}"
            return f"remote_{provider}" if http_url else provider
    if "modal" in fallback_http_url.lower():
        return "modal_whisperx"
    if "127.0.0.1" in fallback_http_url or "localhost" in fallback_http_url:
        return "local_whisperx"
    return "whisperx"


def resolve_llm_backend_label(
    llm_config: Optional[dict[str, Any]],
    llm_providers: Optional[list[dict[str, Any]]],
) -> str:
    """Resolve a human-readable backend label for LLM telemetry."""
    enabled_providers = [
        provider
        for provider in (llm_providers or [])
        if isinstance(provider, dict) and provider.get("enabled", True)
    ]
    if enabled_providers:
        primary_provider = enabled_providers[0]
        provider_type = str(primary_provider.get("type") or "openai_compatible").strip().lower()
        base_url = str(primary_provider.get("base_url") or "").strip().lower()
        model = str(primary_provider.get("model") or "").strip()
        if provider_type == "openai":
            return f"openai_{model}" if model else "openai"
        if provider_type == "openrouter":
            return f"openrouter_{model}" if model else "openrouter"
        if "modal" in base_url:
            return f"modal_{model}" if model else "modal"
        if any(host in base_url for host in ("localhost", "127.0.0.1", "100.81.")):
            return f"local_{model}" if model else "local"
        return f"remote_{model}" if model else "remote"

    config = llm_config or {}
    llm_base_url = str(config.get("base_url", "")).strip()
    llm_model = str(config.get("chat_model", "")).strip()
    if str(config.get("mode") or "").strip().lower() == "online" and "gemini" in llm_model.lower():
        return f"online_{llm_model}" if llm_model else "online"
    return f"modal_{llm_model}" if "modal.run" in llm_base_url else f"local_{llm_model}"


# ---------------------------------------------------------------------------
# Checkpoint coercion
# ---------------------------------------------------------------------------

def coerce_checkpoint_total(
    checkpoint: Optional[dict[str, Any]],
    telemetry: dict[str, Any],
) -> Optional[int]:
    """Return the checkpoint's total_chunks as an int, or None."""
    raw_total = None
    if isinstance(checkpoint, dict):
        raw_total = checkpoint.get("total_chunks")
    if raw_total in (None, ""):
        raw_total = telemetry.get("checkpoint_total_chunks")
    try:
        return int(raw_total) if raw_total is not None else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Retry classification
# ---------------------------------------------------------------------------

_RETRYABLE_STAGES: frozenset[str] = frozenset({
    "transcribing",
    "resuming",
    "segmented_transcribing",
})


def is_retryable_import_failure(exc: Exception, *, active_stage: str) -> bool:
    """An import failure is retryable only during STT stages, and only for
    the underlying retryable STT error classes."""
    if str(active_stage or "").strip().lower() not in _RETRYABLE_STAGES:
        return False
    return _is_retryable_stt_error(exc)

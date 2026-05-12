"""Shared low-level helpers, constants, and dataclasses for the transcription pipeline."""

from __future__ import annotations

import logging
import os
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from lct_python_backend.services.coercion_helpers import (
    coerce_float,
    coerce_int,
    coerce_str,
    to_bool,
)

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Env parsing helpers
# ---------------------------------------------------------------------------

def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[STT CHUNK] Invalid %s=%r, using default=%d",
            name,
            raw,
            default,
        )
        return default
    bounded = max(minimum, min(maximum, value))
    if bounded != value:
        logger.warning(
            "[STT CHUNK] Clamped %s=%d to %d (allowed %d-%d)",
            name,
            value,
            bounded,
            minimum,
            maximum,
        )
    return bounded


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[STT CHUNK] Invalid %s=%r, using default=%.2f",
            name,
            raw,
            default,
        )
        return default


# ---------------------------------------------------------------------------
# Type coercion helpers — delegated to coercion_helpers
# ---------------------------------------------------------------------------

# Backward-compatible aliases so existing importers keep working.
_coerce_str = coerce_str
_coerce_float = coerce_float
_to_bool = to_bool


def _coerce_optional_int(value: Any) -> Optional[int]:
    """Coerce *value* to a positive int (>= 1), else ``None``.

    Delegates to ``coerce_int`` but rejects zero and negative values,
    which is the semantic contract callers (speaker counts, etc.) rely on.
    """
    result = coerce_int(coerce_str(value) or None)
    return result if result is not None and result >= 1 else None


def _elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


# ---------------------------------------------------------------------------
# Module-level environment constants
# ---------------------------------------------------------------------------

# Chunked audio transcription defaults
DEFAULT_CHUNK_DURATION_S = _bounded_env_int("STT_CHUNK_DURATION_S", default=30, minimum=20, maximum=30)
DEFAULT_CHUNK_OVERLAP_S = _bounded_env_int("STT_CHUNK_OVERLAP_S", default=1, minimum=0, maximum=3)
# Default to 4 retries (= 5 total attempts per chunk) — observed transient
# rates on Windows + Tailscale stacks routinely exhausted the prior 2 retries
# and aborted whole imports. 5 attempts with exponential backoff cover
# essentially all real transients (10054 resets, getaddrinfo blips, 502s).
DEFAULT_CHUNK_MAX_RETRIES = _bounded_env_int("STT_CHUNK_MAX_RETRIES", default=4, minimum=0, maximum=8)
DEFAULT_CHUNK_RETRY_BACKOFF_S = max(0.0, _env_float("STT_CHUNK_RETRY_BACKOFF_S", default=1.5))

# Dynamic silence-based segmentation defaults
DEFAULT_MIN_SEGMENT_MS = _bounded_env_int("SEGMENT_MIN_MS", default=120_000, minimum=60_000, maximum=300_000)
DEFAULT_MAX_SEGMENT_MS = _bounded_env_int("SEGMENT_MAX_MS", default=480_000, minimum=120_000, maximum=900_000)
DEFAULT_SILENCE_THRESH_DB = _bounded_env_int("SEGMENT_SILENCE_DB", default=-40, minimum=-60, maximum=-20)
DEFAULT_MIN_SILENCE_MS = _bounded_env_int("SEGMENT_SILENCE_MS", default=2000, minimum=500, maximum=5000)

# Pyannote diarization
STT_PARAKEET_PYANNOTE_ENABLED = (
    os.getenv("STT_PARAKEET_PYANNOTE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
)
STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT = (
    str(os.getenv("STT_PARAKEET_PYANNOTE_RESPONSE_FORMAT", "verbose_json")).strip().lower() or "verbose_json"
)
STT_PYANNOTE_MODEL = (
    str(os.getenv("STT_PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1")).strip()
    or "pyannote/speaker-diarization-3.1"
)
STT_PYANNOTE_DEVICE = str(os.getenv("STT_PYANNOTE_DEVICE", "cpu")).strip().lower() or "cpu"
STT_PYANNOTE_MIN_SPEAKERS = str(os.getenv("STT_PYANNOTE_MIN_SPEAKERS", "")).strip()
STT_PYANNOTE_MAX_SPEAKERS = str(os.getenv("STT_PYANNOTE_MAX_SPEAKERS", "")).strip()

# Provider selection
STT_UPLOAD_LOCAL_FIRST = os.getenv("STT_UPLOAD_LOCAL_FIRST", "true").strip().lower() in {"1", "true", "yes", "on"}
STT_UPLOAD_REMOTE_FALLBACK = (
    os.getenv("STT_UPLOAD_REMOTE_FALLBACK", "true").strip().lower() in {"1", "true", "yes", "on"}
)
STT_PROVIDER_ORDER: Tuple[str, ...] = ("parakeet", "senko", "ofc", "whisper")

# File extension sets
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4"}
TEXT_EXTENSIONS = {".txt", ".text", ".md", ".log"}
VTT_EXTENSIONS = {".vtt"}
SRT_EXTENSIONS = {".srt"}
GOOGLE_MEET_EXTENSIONS = {".pdf"}

# ---------------------------------------------------------------------------
# ContextVar: tracks which GPU backend handled the last transcription call
# ---------------------------------------------------------------------------

# Set by transcribe_audio_file_detailed(); read by transcribe_uploaded_file()
# to surface it in metadata → SSE events.
_last_stt_backend: ContextVar[str] = ContextVar("_last_stt_backend", default="")

# ---------------------------------------------------------------------------
# Type aliases for callbacks
# ---------------------------------------------------------------------------

ProgressCallback = Callable[[int, int, str], Awaitable[None]]
ProviderFallbackCallback = Callable[[str, str, str], Awaitable[None]]
SegmentStartedCallback = Callable[[int, int, int, int], Awaitable[None]]

# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class FileTranscriptResult:
    """Normalized transcript extraction result."""

    transcript_text: str
    source_type: str
    metadata: Dict[str, Any]
    utterances: List[Dict[str, Any]] = field(default_factory=list)
    speaker_segments: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class AudioTranscriptionDetail:
    """Detailed STT result with optional timestamped segments."""

    transcript_text: str
    asr_segments: List[Dict[str, Any]]
    diarized_segments: Optional[List[Dict[str, Any]]]
    raw_payload: Any
    backend: str = ""  # "local_whisperx" | "modal_whisperx" | "" (set when routed via IndrasNet)


@dataclass
class SegmentResult:
    """Result for a single audio segment in interleaved processing."""

    segment_index: int   # 1-based index
    segment_total: int   # Total number of segments
    start_ms: int
    end_ms: int
    transcript_text: str
    elapsed_ms: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

"""No-audio guard for live STT sessions.

A dead or muted microphone — or an automated test with a fake mic — streams
silent audio to OpenAI exactly like real speech, and OpenAI bills for every
uploaded second. This guard watches incoming PCM16 chunks and, once a session
has produced no real audio at all for a sustained stretch, stops forwarding to
the STT provider so credits aren't spent on silence.

It is deliberately a *dead-session* guard, not a per-chunk silence filter: the
moment any real audio is heard it goes permanently dormant, so genuine
recordings — and their transcript timestamps — are never affected.
"""

from __future__ import annotations

import os
from typing import Dict

import numpy as np


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


# RMS amplitude (PCM16 full-scale is 32767) at or above which a chunk counts as
# real audio. Set well below even quiet speech (~500+ RMS) — a muted/dead mic
# sits near zero. Erring low is safe: the guard simply never engages.
DEFAULT_SILENCE_RMS = _env_float("STT_NO_AUDIO_RMS_THRESHOLD", 90.0)
# Seconds of unbroken silence from session start before the client is warned.
DEFAULT_WARN_AFTER_S = _env_float("STT_NO_AUDIO_WARN_AFTER_S", 20.0)
# Seconds before forwarding to the STT provider stops entirely.
DEFAULT_STOP_AFTER_S = _env_float("STT_NO_AUDIO_STOP_AFTER_S", 60.0)
# Kill switch — set STT_NO_AUDIO_GUARD_ENABLED=false to disable (always forward).
DEFAULT_ENABLED = _env_bool("STT_NO_AUDIO_GUARD_ENABLED", True)


def chunk_rms(chunk_bytes: bytes) -> float:
    """RMS amplitude of a PCM16 little-endian mono buffer. 0.0 for empty input."""
    if not chunk_bytes or len(chunk_bytes) < 2:
        return 0.0
    usable = len(chunk_bytes) - (len(chunk_bytes) % 2)
    samples = np.frombuffer(chunk_bytes[:usable], dtype="<i2")
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))


class NoAudioGuard:
    """Tracks whether a live STT session has produced any real audio.

    Feed every incoming PCM16 chunk to ``observe()``. It returns a decision:

    * ``forward`` — send this chunk to the STT provider? Becomes False once the
      session is judged dead-silent, and stays False until real audio appears.
    * ``warn`` — True exactly once, when silence first crosses the warn
      threshold, so the caller can notify the client.
    * ``stop`` — True exactly once, when forwarding first halts.
    * ``silent_run_s`` / ``rms`` — diagnostics.

    The moment any real audio is heard the guard is permanently dormant:
    ``forward`` is True forever, so genuine recordings are never touched.
    """

    def __init__(
        self,
        *,
        silence_rms: float = DEFAULT_SILENCE_RMS,
        warn_after_s: float = DEFAULT_WARN_AFTER_S,
        stop_after_s: float = DEFAULT_STOP_AFTER_S,
        enabled: bool = DEFAULT_ENABLED,
    ) -> None:
        self.silence_rms = silence_rms
        self.warn_after_s = warn_after_s
        self.stop_after_s = stop_after_s
        self.enabled = enabled
        self.heard_speech = False
        self.silent_run_s = 0.0
        self._warned = False
        self._stopped = False

    def observe(self, chunk_bytes: bytes, sample_rate_hz: int) -> Dict[str, object]:
        """Classify one PCM16 chunk and return the forward/warn/stop decision."""
        rms = chunk_rms(chunk_bytes)

        if not self.enabled or self.heard_speech:
            return {"forward": True, "warn": False, "stop": False,
                    "silent_run_s": self.silent_run_s, "rms": rms}

        if rms >= self.silence_rms:
            # First real audio — the guard is dormant for the rest of the session.
            self.heard_speech = True
            return {"forward": True, "warn": False, "stop": False,
                    "silent_run_s": self.silent_run_s, "rms": rms}

        rate = sample_rate_hz if sample_rate_hz and sample_rate_hz > 0 else 16000
        self.silent_run_s += (len(chunk_bytes) // 2) / float(rate)

        warn = False
        if not self._warned and self.silent_run_s >= self.warn_after_s:
            self._warned = True
            warn = True

        forward = self.silent_run_s < self.stop_after_s
        stop = False
        if not forward and not self._stopped:
            self._stopped = True
            stop = True

        return {"forward": forward, "warn": warn, "stop": stop,
                "silent_run_s": self.silent_run_s, "rms": rms}

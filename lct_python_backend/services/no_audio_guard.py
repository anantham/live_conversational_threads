"""No-audio guard for live STT sessions.

A dead or muted microphone — or an automated test with a fake mic — streams
silent audio to OpenAI exactly like real speech, and OpenAI bills for every
uploaded second. This guard watches incoming PCM16 chunks and acts on
sustained silence so credits aren't spent on nothing:

* Guard A — *no real audio ever*: warn the client, then stop forwarding to the
  STT provider entirely (a dead/muted mic, or a fake-mic automated session).
* Guard B — *trailing silence after real speech*: a recording left running
  after the conversation ended. Signal a clean, resumable auto-pause.

It is deliberately not a per-chunk silence filter — silence inside an active
conversation is forwarded normally, so genuine recordings and their transcript
timestamps are never affected. The guard only acts on *sustained* silence.

It also tallies ``forwarded_audio_s`` — the audio actually sent to the
provider — so STT quota accounting can charge for billed time only (silence
the guard halts on is not counted).
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
# Guard A — seconds of silence from session start before the client is warned.
DEFAULT_WARN_AFTER_S = _env_float("STT_NO_AUDIO_WARN_AFTER_S", 20.0)
# Guard A — seconds before forwarding to the STT provider stops entirely.
DEFAULT_STOP_AFTER_S = _env_float("STT_NO_AUDIO_STOP_AFTER_S", 60.0)
# Guard B — seconds of trailing silence *after* real speech before a clean
# auto-pause is signalled. Generous, so a natural conversation lull doesn't
# trip it; a 5-minute unbroken silence really does mean "walked away".
DEFAULT_PAUSE_AFTER_S = _env_float("STT_NO_AUDIO_PAUSE_AFTER_S", 300.0)
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
    """Tracks the real-audio history of a live STT session.

    Feed every incoming PCM16 chunk to ``observe()``. It returns a decision:

    * ``forward`` — send this chunk to the STT provider? Becomes False once the
      session is judged dead-silent (guard A) or has crossed the trailing-
      silence auto-pause threshold (guard B).
    * ``warn`` — True exactly once: guard A's "no audio yet" client warning.
    * ``stop`` — True exactly once: guard A halts forwarding.
    * ``auto_pause`` — True exactly once: guard B — sustained silence after real
      speech; the caller should pause the recording.
    * ``silent_run_s`` / ``rms`` — diagnostics. ``silent_run_s`` is the current
      unbroken run of silence; it resets to 0 whenever real audio arrives.

    The instance also accumulates ``forwarded_audio_s`` — total seconds of
    audio actually forwarded to the provider — for STT quota accounting.
    """

    def __init__(
        self,
        *,
        silence_rms: float = DEFAULT_SILENCE_RMS,
        warn_after_s: float = DEFAULT_WARN_AFTER_S,
        stop_after_s: float = DEFAULT_STOP_AFTER_S,
        pause_after_s: float = DEFAULT_PAUSE_AFTER_S,
        enabled: bool = DEFAULT_ENABLED,
    ) -> None:
        self.silence_rms = silence_rms
        self.warn_after_s = warn_after_s
        self.stop_after_s = stop_after_s
        self.pause_after_s = pause_after_s
        self.enabled = enabled
        self.heard_speech = False
        self.silent_run_s = 0.0
        self.forwarded_audio_s = 0.0
        self._warned = False
        self._stopped = False
        self._auto_paused = False

    def _decision(
        self,
        rms: float,
        chunk_s: float,
        *,
        forward: bool = True,
        warn: bool = False,
        stop: bool = False,
        auto_pause: bool = False,
    ) -> Dict[str, object]:
        # Tally audio that actually reaches the (paid) provider — the single
        # point every observe() path funnels through.
        if forward:
            self.forwarded_audio_s += chunk_s
        return {
            "forward": forward,
            "warn": warn,
            "stop": stop,
            "auto_pause": auto_pause,
            "silent_run_s": self.silent_run_s,
            "rms": rms,
        }

    def observe(self, chunk_bytes: bytes, sample_rate_hz: int) -> Dict[str, object]:
        """Classify one PCM16 chunk and return the guard decision."""
        rms = chunk_rms(chunk_bytes)
        rate = sample_rate_hz if sample_rate_hz and sample_rate_hz > 0 else 16000
        chunk_s = (len(chunk_bytes) // 2) / float(rate)

        if not self.enabled:
            return self._decision(rms, chunk_s, forward=True)

        if rms >= self.silence_rms:
            # Real audio — mark speech heard and reset the trailing-silence run.
            self.heard_speech = True
            self.silent_run_s = 0.0
            return self._decision(rms, chunk_s, forward=True)

        # Silent chunk — extend the consecutive-silence run.
        self.silent_run_s += chunk_s

        if not self.heard_speech:
            # Guard A — the session has produced no real audio at all.
            warn = False
            if not self._warned and self.silent_run_s >= self.warn_after_s:
                self._warned = True
                warn = True
            forward = self.silent_run_s < self.stop_after_s
            stop = False
            if not forward and not self._stopped:
                self._stopped = True
                stop = True
            return self._decision(rms, chunk_s, forward=forward, warn=warn, stop=stop)

        # Guard B — real speech was heard, now a sustained trailing silence
        # (a recording left running after the conversation). Signal a clean,
        # resumable auto-pause once it crosses the threshold.
        auto_pause = False
        if not self._auto_paused and self.silent_run_s >= self.pause_after_s:
            self._auto_paused = True
            auto_pause = True
        forward = self.silent_run_s < self.pause_after_s
        return self._decision(rms, chunk_s, forward=forward, auto_pause=auto_pause)

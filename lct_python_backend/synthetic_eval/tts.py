"""Tier-2 TTS: render a SyntheticConversation to multi-speaker audio via Kokoro.

Orchestrator side (base env). Assigns a distinct Kokoro voice per speaker, writes a
render-spec, and invokes ``_kokoro_worker.py`` in the ``whisperlocal`` env (which has
kokoro + the audio stack). Returns the wav path + a per-turn timing manifest used by
the diarization scorer.

Kokoro is fixed-voice (no cloning) but ships 54 named voices — plenty to give every
speaker a clearly distinct voice. The scripted conversation is the stable artifact;
the TTS backend is swappable (Dia/cloud) behind this same interface later.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from lct_python_backend.synthetic_eval.schema import SyntheticConversation

# Diverse voices (alternating gender + accent) so speakers are easy to tell apart.
VOICE_POOL = [
    "af_heart", "am_adam", "bf_emma", "am_michael",
    "af_bella", "bm_george", "af_nicole", "am_eric",
]


def whisperlocal_py() -> Optional[str]:
    """Resolve the py3.10 `whisperlocal` interpreter (has kokoro + whisperx)."""
    explicit = os.getenv("SYNTH_EVAL_WHISPERLOCAL_PY")
    if explicit and os.path.exists(explicit):
        return explicit
    cand = os.path.expanduser("~/anaconda3/envs/whisperlocal/python.exe")
    return cand if os.path.exists(cand) else None


@dataclass
class RenderConfig:
    pause_ms: int = 300        # gap between turns
    overlap_ms: int = 0        # >0 overlaps consecutive turns (diarizer stress)
    noise_db: Optional[float] = None  # e.g. -30 adds room noise (stress)
    speed: float = 1.0
    sample_rate: int = 24000   # Kokoro native; WhisperX resamples to 16k on load


@dataclass
class RenderResult:
    ok: bool
    wav_path: str = ""
    manifest: Dict[str, Any] = field(default_factory=dict)
    voices: Dict[str, str] = field(default_factory=dict)
    error: str = ""
    elapsed_ms: float = 0.0


def assign_voices(convo: SyntheticConversation) -> Dict[str, str]:
    speakers = convo.personas or sorted({t.speaker for t in convo.turns})
    return {spk: VOICE_POOL[i % len(VOICE_POOL)] for i, spk in enumerate(speakers)}


def render_conversation(
    convo: SyntheticConversation,
    config: Optional[RenderConfig] = None,
    out_dir: Optional[str] = None,
) -> RenderResult:
    import time

    config = config or RenderConfig()
    wpy = whisperlocal_py()
    if not wpy:
        return RenderResult(ok=False, error="whisperlocal python not found (set SYNTH_EVAL_WHISPERLOCAL_PY)")

    voices = assign_voices(convo)
    spec = {
        "sample_rate": config.sample_rate,
        "pause_ms": config.pause_ms,
        "overlap_ms": config.overlap_ms,
        "noise_db": config.noise_db,
        "speed": config.speed,
        "lang_code": "a",
        "turns": [
            {"id": t.id, "speaker": t.speaker, "text": t.text, "voice": voices[t.speaker]}
            for t in convo.turns
        ],
    }

    out_dir = out_dir or os.path.join(os.path.dirname(__file__), "audio")
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, f"{convo.slug}.wav")
    manifest_path = os.path.join(out_dir, f"{convo.slug}.manifest.json")
    worker = os.path.join(os.path.dirname(__file__), "_kokoro_worker.py")

    fd, spec_path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)

    t0 = time.perf_counter()
    try:
        proc = subprocess.run(
            [wpy, worker, spec_path, wav_path, manifest_path],
            capture_output=True, text=True, encoding="utf-8",
            timeout=int(os.getenv("SYNTH_EVAL_TTS_TIMEOUT", "600")),
        )
    except subprocess.TimeoutExpired:
        return RenderResult(ok=False, voices=voices, error="kokoro render timed out")
    except Exception as exc:  # noqa: BLE001
        return RenderResult(ok=False, voices=voices, error=f"{type(exc).__name__}: {exc}")
    finally:
        try:
            os.unlink(spec_path)
        except Exception:
            pass
    elapsed = (time.perf_counter() - t0) * 1000.0

    if proc.returncode != 0:
        return RenderResult(
            ok=False, voices=voices, elapsed_ms=elapsed,
            error=f"kokoro worker exit {proc.returncode}: {(proc.stderr or '')[:400]}",
        )
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return RenderResult(ok=False, voices=voices, elapsed_ms=elapsed, error=f"no manifest: {exc}")

    return RenderResult(ok=True, wav_path=wav_path, manifest=manifest, voices=voices, elapsed_ms=elapsed)

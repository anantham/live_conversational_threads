"""Tier-2 STT: run WhisperX + pyannote diarization on a rendered wav.

Orchestrator side (base env). Invokes ``_whisperx_worker.py`` in the ``whisperlocal``
env (which has whisperx + pyannote + CUDA) and returns the transcript, word
timestamps, and per-segment speaker labels. Service-free — bypasses the (currently
down) :7777 orchestrator and the per-chunk-HTTP path entirely.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lct_python_backend.synthetic_eval.tts import whisperlocal_py


@dataclass
class SttResult:
    ok: bool
    text: str = ""
    segments: List[Dict[str, Any]] = field(default_factory=list)
    words: List[Dict[str, Any]] = field(default_factory=list)
    language: str = ""
    warnings: List[str] = field(default_factory=list)
    error: str = ""
    elapsed_ms: float = 0.0


def transcribe(
    wav_path: str,
    *,
    diarize: bool = True,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
    model: Optional[str] = None,
    compute_type: Optional[str] = None,
    language: Optional[str] = None,
) -> SttResult:
    wpy = whisperlocal_py()
    if not wpy:
        return SttResult(ok=False, error="whisperlocal python not found (set SYNTH_EVAL_WHISPERLOCAL_PY)")
    if not os.path.exists(wav_path):
        return SttResult(ok=False, error=f"wav not found: {wav_path}")

    spec = {
        "wav_path": os.path.abspath(wav_path),
        "diarize": diarize,
        "model": model or os.getenv("SYNTH_EVAL_WHISPER_MODEL", "large-v3"),
        "compute_type": compute_type or os.getenv("SYNTH_EVAL_WHISPER_COMPUTE", "int8"),
        "batch_size": int(os.getenv("SYNTH_EVAL_WHISPER_BATCH", "8")),
        "min_speakers": min_speakers,
        "max_speakers": max_speakers,
        # Pin the language: the synthetic audio is English, but WhisperX auto-detect
        # mis-fired to Norwegian on clean Kokoro speech and hallucinated 5 garbage
        # segments. "" / None restores auto-detect.
        "language": (language if language is not None else os.getenv("SYNTH_EVAL_WHISPER_LANG", "en")) or None,
    }
    worker = os.path.join(os.path.dirname(__file__), "_whisperx_worker.py")

    fd, spec_path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    fd2, out_path = tempfile.mkstemp(suffix=".json")
    os.close(fd2)

    t0 = time.perf_counter()
    try:
        proc = subprocess.run(
            [wpy, worker, spec_path, out_path],
            capture_output=True, text=True, encoding="utf-8",
            timeout=int(os.getenv("SYNTH_EVAL_STT_TIMEOUT", "1200")),
        )
    except subprocess.TimeoutExpired:
        return SttResult(ok=False, error="whisperx timed out (raise SYNTH_EVAL_STT_TIMEOUT)")
    except Exception as exc:  # noqa: BLE001
        return SttResult(ok=False, error=f"{type(exc).__name__}: {exc}")
    finally:
        try:
            os.unlink(spec_path)
        except Exception:
            pass
    elapsed = (time.perf_counter() - t0) * 1000.0

    try:
        with open(out_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return SttResult(
            ok=False, elapsed_ms=elapsed,
            error=f"no stt output ({exc}); worker stderr: {(proc.stderr or '')[:300]}",
        )
    finally:
        try:
            os.unlink(out_path)
        except Exception:
            pass

    if not data.get("ok"):
        return SttResult(
            ok=False, elapsed_ms=elapsed,
            error=data.get("error", "whisperx failed"),
            warnings=data.get("warnings", []),
        )
    return SttResult(
        ok=True, elapsed_ms=elapsed,
        text=data.get("text", ""),
        segments=data.get("segments", []),
        words=data.get("words", []),
        language=data.get("language", ""),
        warnings=data.get("warnings", []),
    )

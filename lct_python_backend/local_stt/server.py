"""
LCT local on-device STT server (Apple Silicon, MLX).

Serves an OpenAI-compatible `POST /v1/audio/transcriptions` that LCT's existing
HTTP STT provider seam (`services/stt_http_transcriber.py`,
`services/stt_provider_transports.py`) already POSTs to. So LCT transcribes
fully on-device by simply pointing a provider URL at this server — **no change to
LCT's STT code, and cloud providers (OpenAI / OpenRouter / remote whisper) stay
selectable.** Local is just one more entry in the provider menu (local-first by
default; flip to cloud anytime — see README.md).

Engine: `mlx-whisper` (Metal/ANE on Apple Silicon). Default model is the
multilingual large-v3-turbo (~56x realtime on M5 in our benchmark) — English now,
Malayalam-capable for the deferred multilingual mode (docs/FEATURE_MULTILINGUAL_TRANSCRIPTION.md).

Run (in its own venv, kept separate so LCT's backend venv stays lean):
    cd lct_python_backend/local_stt
    uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r requirements.txt
    LOCAL_STT_PORT=5095 .venv/bin/python server.py
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

DEFAULT_MODEL = os.getenv("LOCAL_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
PORT = int(os.getenv("LOCAL_STT_PORT", "5095"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("lct_local_stt")

app = FastAPI(title="LCT Local STT (mlx-whisper)")
_state = {"ready": False}


@app.get("/health")
def health() -> dict:
    # Matches what stt_health_service probes for an STT provider.
    return {
        "status": "healthy" if _state["ready"] else "starting",
        "engine": "mlx-whisper",
        "model": DEFAULT_MODEL,
        "backend": "mlx-metal-ane",
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
) -> JSONResponse:
    """OpenAI-compatible transcription. Returns {text, segments[], language}.

    Diarization is intentionally NOT done here — it's a separate on-device backend
    (Senko / FluidAudio) per the STT/diarization split. This server returns words +
    timestamps; LCT's pipeline attaches speakers separately when diarization is on.
    """
    import mlx_whisper  # imported lazily so --help / import of this module is cheap

    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    payload = await file.read()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(payload)
        tmp_path = tmp.name

    try:
        kwargs: dict = {"path_or_hf_repo": model or DEFAULT_MODEL}
        # language="auto"/None lets Whisper detect; an explicit code forces it
        # (used by the future Malayalam/multilingual mode).
        if language and language.strip().lower() not in ("", "auto", "none"):
            kwargs["language"] = language.strip()

        t0 = time.perf_counter()
        result = mlx_whisper.transcribe(tmp_path, **kwargs)
        elapsed = time.perf_counter() - t0

        segments = [
            {
                "id": i,
                "start": seg.get("start"),
                "end": seg.get("end"),
                "text": (seg.get("text") or "").strip(),
            }
            for i, seg in enumerate(result.get("segments", []) or [])
        ]
        audio_dur = segments[-1]["end"] if segments and segments[-1]["end"] else None
        _state["ready"] = True
        log.info(
            "transcribed file=%s audio=%.1fs in %.2fs (%.1fx realtime) segs=%d lang=%s",
            file.filename,
            audio_dur or 0.0,
            elapsed,
            (audio_dur / elapsed) if audio_dur else 0.0,
            len(segments),
            result.get("language"),
        )
        return JSONResponse(
            {
                "text": (result.get("text") or "").strip(),
                "segments": segments,
                "language": result.get("language"),
                "_engine": "mlx-whisper",
                "_model": model or DEFAULT_MODEL,
                "_elapsed_seconds": round(elapsed, 3),
            }
        )
    except Exception as exc:  # fail loudly, never silently (AGENTS.md §Error Logging)
        log.exception("transcription failed for %s", file.filename)
        return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    log.info("LCT local STT server on :%d  engine=mlx-whisper  model=%s", PORT, DEFAULT_MODEL)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")

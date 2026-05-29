"""
LCT local on-device STT server (Apple Silicon, MLX).

Serves an OpenAI-compatible `POST /v1/audio/transcriptions` that LCT's existing
HTTP STT provider seam (`services/stt_http_transcriber.py`,
`services/stt_provider_transports.py`) already POSTs to. So LCT transcribes
fully on-device by pointing a provider URL at this server — **no change to LCT's
STT code, and cloud providers (OpenAI / OpenRouter / remote whisper) stay
selectable.** Local is just one more entry in the provider menu (local-first by
default; flip to cloud anytime — see README.md).

Engine: `mlx-whisper` (Metal/ANE). Default model is the multilingual
large-v3-turbo (~56x realtime on M5) — English now, Malayalam-capable for the
deferred multilingual mode (docs/FEATURE_MULTILINGUAL_TRANSCRIPTION.md).

NETWORK NOTE: binds IPv4 (0.0.0.0). Callers MUST use `http://127.0.0.1:<port>`
NOT `http://localhost:<port>` — on macOS `localhost` can resolve to IPv6 `::1`,
which this server does not listen on (this exact gotcha cost a debugging cycle).

Logging (AGENTS.md §9 — no silent failures): every request is logged on receipt
and on completion/error; set LOCAL_STT_DEBUG=1 for transcript previews + uvicorn
debug. Run:
    cd lct_python_backend/local_stt
    uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r requirements.txt
    LOCAL_STT_PORT=5095 .venv/bin/python server.py
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

DEFAULT_MODEL = os.getenv("LOCAL_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
PORT = int(os.getenv("LOCAL_STT_PORT", "5095"))
DEBUG = os.getenv("LOCAL_STT_DEBUG", "false").strip().lower() in ("1", "true", "yes", "on")

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s [local_stt] %(message)s",
)
log = logging.getLogger("lct_local_stt")

app = FastAPI(title="LCT Local STT (mlx-whisper)")
_state = {"ready": False, "requests": 0, "failures": 0}


@app.middleware("http")
async def _access_log(request: Request, call_next):
    # One line per request so connection/routing problems are never silent.
    rid = uuid.uuid4().hex[:8]
    t0 = time.perf_counter()
    client = request.client.host if request.client else "?"
    log.info("[%s] --> %s %s from %s", rid, request.method, request.url.path, client)
    try:
        response = await call_next(request)
    except Exception:
        log.exception("[%s] !! unhandled error on %s %s", rid, request.method, request.url.path)
        raise
    log.info("[%s] <-- %s %s %d (%.0fms)", rid, request.method, request.url.path,
             response.status_code, (time.perf_counter() - t0) * 1000)
    return response


@app.get("/health")
def health() -> dict:
    return {
        "status": "healthy" if _state["ready"] else "starting",
        "engine": "mlx-whisper",
        "model": DEFAULT_MODEL,
        "backend": "mlx-metal-ane",
        "requests": _state["requests"],
        "failures": _state["failures"],
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
) -> JSONResponse:
    """OpenAI-compatible transcription → {text, segments[], language}.

    Diarization is intentionally NOT done here — it's a separate on-device backend
    (Senko / FluidAudio). This returns words + timestamps; speakers are attached
    separately when diarization is on.
    """
    import mlx_whisper  # lazy import so module import / --help stays cheap

    _state["requests"] += 1
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    payload = await file.read()
    log.info(
        "transcribe request: file=%s bytes=%d model=%s language=%s format=%s",
        file.filename, len(payload), model or DEFAULT_MODEL, language or "auto", response_format,
    )
    if not payload:
        _state["failures"] += 1
        log.warning("empty audio payload for file=%s", file.filename)
        return JSONResponse(status_code=400, content={"error": "empty audio payload"})

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(payload)
        tmp_path = tmp.name

    try:
        kwargs: dict = {"path_or_hf_repo": model or DEFAULT_MODEL}
        if language and language.strip().lower() not in ("", "auto", "none"):
            kwargs["language"] = language.strip()

        t0 = time.perf_counter()
        result = mlx_whisper.transcribe(tmp_path, **kwargs)
        elapsed = time.perf_counter() - t0

        segments = [
            {"id": i, "start": seg.get("start"), "end": seg.get("end"),
             "text": (seg.get("text") or "").strip()}
            for i, seg in enumerate(result.get("segments", []) or [])
        ]
        audio_dur = segments[-1]["end"] if segments and segments[-1]["end"] else None
        _state["ready"] = True
        text = (result.get("text") or "").strip()
        log.info(
            "transcribe ok: file=%s audio=%.1fs in %.2fs (%.1fx realtime) segs=%d lang=%s chars=%d",
            file.filename, audio_dur or 0.0, elapsed,
            (audio_dur / elapsed) if audio_dur else 0.0, len(segments), result.get("language"), len(text),
        )
        if DEBUG:
            log.debug("transcript preview: %s", text[:300])
        return JSONResponse({
            "text": text,
            "segments": segments,
            "language": result.get("language"),
            "_engine": "mlx-whisper",
            "_model": model or DEFAULT_MODEL,
            "_elapsed_seconds": round(elapsed, 3),
        })
    except Exception as exc:  # fail loudly, never silently (AGENTS.md §9)
        _state["failures"] += 1
        log.exception("transcribe FAILED: file=%s", file.filename)
        return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    log.info(
        "LCT local STT starting on 0.0.0.0:%d — reach via http://127.0.0.1:%d (IPv4; "
        "do NOT use 'localhost' if the caller may resolve it to IPv6 ::1). "
        "engine=mlx-whisper model=%s debug=%s",
        PORT, PORT, DEFAULT_MODEL, DEBUG,
    )
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="debug" if DEBUG else "info", access_log=True)

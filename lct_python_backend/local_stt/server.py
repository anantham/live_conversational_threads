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
        "diarization": "available" if _diar.get("ok") else (_diar.get("error") or "not loaded"),
    }


# ---------------------------------------------------------------------------
# Optional speaker diarization (pyannote speaker-diarization-3.1). Loaded lazily
# and cached (the pipeline is expensive to construct). Gated model -> needs an HF
# token (HF_TOKEN env, else the cached ~/.cache/huggingface/token). On Apple
# Silicon, MPS support is partial; default device is configurable and falls back
# to CPU on any device error. Kept optional so non-diarized calls stay fast.
# ---------------------------------------------------------------------------
_diar: dict = {"pipeline": None, "device": None, "error": None, "ok": False}


def _get_diarizer():
    """Lazy-load + cache the pyannote diarization pipeline. Returns the pipeline or None
    (with _diar['error'] set). Device via LOCAL_STT_DIARIZE_DEVICE (auto|mps|cpu)."""
    if _diar["pipeline"] is not None or _diar["error"] is not None:
        return _diar["pipeline"]
    try:
        import torch
        from pyannote.audio import Pipeline
        token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or True  # True -> cached token
        t0 = time.perf_counter()
        try:
            pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=token)
        except TypeError:                            # pyannote.audio < 4 used use_auth_token=
            pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
        want = os.getenv("LOCAL_STT_DIARIZE_DEVICE", "auto").strip().lower()
        dev = ("mps" if torch.backends.mps.is_available() else "cpu") if want == "auto" else want
        try:
            pipe.to(torch.device(dev))
        except Exception as e:  # MPS op gaps etc. -> CPU is always safe
            log.warning("diarizer .to(%s) failed (%s); falling back to cpu", dev, e)
            dev = "cpu"; pipe.to(torch.device("cpu"))
        _diar.update(pipeline=pipe, device=dev, ok=True)
        log.info("diarizer loaded: pyannote/speaker-diarization-3.1 on %s in %.1fs", dev, time.perf_counter() - t0)
    except Exception as e:  # missing dep / gated-model auth / download failure — surface it
        _diar["error"] = f"{type(e).__name__}: {e}"
        log.exception("diarizer load FAILED")
    return _diar["pipeline"]


def _assign_speakers(segments, diarization):
    """Tag each transcript segment with the speaker label of MAX temporal overlap from the
    pyannote turns. -> (segments_with_speaker, sorted_speaker_list).

    pyannote 3.x returns an Annotation (.itertracks); 4.x returns a DiarizeOutput whose
    .speaker_diarization IS that Annotation. Normalize to the Annotation either way."""
    ann = diarization if hasattr(diarization, "itertracks") else getattr(diarization, "speaker_diarization", diarization)
    turns = [(turn.start, turn.end, spk) for turn, _, spk in ann.itertracks(yield_label=True)]
    for seg in segments:
        s, e = float(seg.get("start") or 0.0), float(seg.get("end") or 0.0)
        best, best_ov = None, 0.0
        for ts, te, spk in turns:
            ov = min(e, te) - max(s, ts)
            if ov > best_ov:
                best_ov, best = ov, spk
        seg["speaker"] = best
    return segments, sorted({t[2] for t in turns})


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    diarize: str | None = Form(None),
) -> JSONResponse:
    """OpenAI-compatible transcription → {text, segments[], language}.

    Optional speaker diarization: pass `diarize=true` to also run pyannote
    speaker-diarization-3.1 and tag each segment with a `speaker` (+ a top-level
    `speakers` list and `diarization` timing). Non-diarized calls skip it entirely
    and stay fast. Response stays OpenAI-compatible (top-level `text`).
    """
    want_diarize = (diarize or "").strip().lower() in ("1", "true", "yes", "on")
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
        # OpenAI-compatible clients send a `model` form field (e.g. "whisper-1",
        # "whisper-large-v3-turbo"). This server serves ONE preloaded model, so IGNORE
        # the client value and always use DEFAULT_MODEL — otherwise mlx-whisper tries to
        # resolve the client string as an HF repo and 500s ("Repository Not Found").
        if model and model != DEFAULT_MODEL:
            log.info("ignoring client model=%r; serving preloaded %s", model, DEFAULT_MODEL)
        kwargs: dict = {"path_or_hf_repo": DEFAULT_MODEL}
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

        diar_info = None
        speakers = None
        if want_diarize:
            pipe = _get_diarizer()
            if pipe is None:                          # missing dep / auth / download — report, don't crash
                diar_info = {"error": _diar.get("error") or "diarizer unavailable"}
                log.warning("diarize requested but unavailable: %s", diar_info["error"])
            else:
                d0 = time.perf_counter()
                diarization = pipe(tmp_path)          # tmp file still exists (unlinked in finally)
                segments, speakers = _assign_speakers(segments, diarization)
                d_elapsed = time.perf_counter() - d0
                diar_info = {"device": _diar.get("device"), "speakers": speakers, "n_speakers": len(speakers),
                             "elapsed_seconds": round(d_elapsed, 3),
                             "realtime_x": round(audio_dur / d_elapsed, 2) if (audio_dur and d_elapsed) else None}
                log.info("diarize ok: %d speaker(s) on %s in %.2fs (%.1fx realtime)", len(speakers),
                         _diar.get("device"), d_elapsed, (audio_dur / d_elapsed) if (audio_dur and d_elapsed) else 0.0)

        log.info(
            "transcribe ok: file=%s audio=%.1fs in %.2fs (%.1fx realtime) segs=%d lang=%s chars=%d diarize=%s",
            file.filename, audio_dur or 0.0, elapsed,
            (audio_dur / elapsed) if audio_dur else 0.0, len(segments), result.get("language"), len(text), want_diarize,
        )
        if DEBUG:
            log.debug("transcript preview: %s", text[:300])
        return JSONResponse({
            "text": text,
            "segments": segments,
            "language": result.get("language"),
            "speakers": speakers,
            "diarization": diar_info,
            "_engine": "mlx-whisper",
            "_model": DEFAULT_MODEL,
            "_requested_model": model,
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
    # Loopback by default — the endpoint is unauthenticated, so don't expose it
    # on the LAN unless the operator explicitly opts in via LOCAL_STT_HOST.
    host = os.getenv("LOCAL_STT_HOST", "127.0.0.1").strip() or "127.0.0.1"
    log.info(
        "LCT local STT starting on %s:%d — reach via http://127.0.0.1:%d (IPv4; "
        "do NOT use 'localhost' if the caller may resolve it to IPv6 ::1). "
        "Set LOCAL_STT_HOST=0.0.0.0 to expose on the LAN (UNAUTHENTICATED). "
        "engine=mlx-whisper model=%s debug=%s",
        host, PORT, PORT, DEFAULT_MODEL, DEBUG,
    )
    uvicorn.run(app, host=host, port=PORT, log_level="debug" if DEBUG else "info", access_log=True)

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


# ---------------------------------------------------------------------------
# Optional speaker EMBEDDINGS — speechbrain ECAPA-TDNN (spkrec-ecapa-voxceleb, 192-dim).
# CRITICAL: this is the SAME embedding space Strix/IndrasNet store (ADR-022). pyannote
# computes its own embeddings internally (a DIFFERENT model / space), so cross-recording
# speaker identity requires re-emitting vectors in THIS ECAPA space — never mix spaces.
# ---------------------------------------------------------------------------
_ecapa: dict = {"model": None, "error": None}


def _get_ecapa():
    if _ecapa["model"] is not None or _ecapa["error"] is not None:
        return _ecapa["model"]
    try:
        try:
            from speechbrain.inference.speaker import EncoderClassifier   # speechbrain >= 1.0
        except ImportError:
            from speechbrain.pretrained import EncoderClassifier          # older
        dev = os.getenv("LOCAL_STT_EMBED_DEVICE", "cpu").strip().lower()  # ECAPA is small; CPU safe+fast
        t0 = time.perf_counter()
        m = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=os.path.expanduser("~/.cache/speechbrain/spkrec-ecapa-voxceleb"),
            run_opts={"device": dev},
        )
        _ecapa["model"] = m
        log.info("ECAPA embedder loaded (spkrec-ecapa-voxceleb, 192-dim) on %s in %.1fs", dev, time.perf_counter() - t0)
    except Exception as e:
        _ecapa["error"] = f"{type(e).__name__}: {e}"
        log.exception("ECAPA load FAILED")
    return _ecapa["model"]


def _embed_segments(audio_path, segments):
    """ECAPA 192-dim embedding per segment (`segments[].embedding`) + per-speaker mean
    (`speaker_embeddings`). -> (segments, speaker_embeddings|None, dim|None). Same vector
    space as Strix so cross-recording speaker matching stays valid."""
    m = _get_ecapa()
    if m is None:
        return segments, None, None
    import torch, torchaudio, subprocess
    wpath = str(audio_path) + ".ecapa16k.wav"           # ffmpeg → 16 kHz mono (robust for wav/m4a)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(audio_path),
                    "-ar", "16000", "-ac", "1", wpath], check=True)
    try:
        wav, sr = torchaudio.load(wpath)                # [1, N] @ 16 kHz
        spk_vecs, dim = {}, None
        for seg in segments:
            s = int(max(0.0, float(seg.get("start") or 0.0)) * sr)
            e = int(float(seg.get("end") or 0.0) * sr)
            if e - s < int(0.2 * sr):                   # too short to embed reliably
                seg["embedding"] = None
                continue
            with torch.no_grad():
                vec = m.encode_batch(wav[:, s:e]).reshape(-1).detach().cpu().tolist()
            seg["embedding"] = vec
            dim = dim or len(vec)
            spk = seg.get("speaker")
            if spk is not None:
                spk_vecs.setdefault(spk, []).append(vec)
        speaker_embeddings = ({spk: [sum(c) / len(c) for c in zip(*vs)] for spk, vs in spk_vecs.items()}
                              if spk_vecs else None)
        return segments, speaker_embeddings, dim
    finally:
        try: os.unlink(wpath)
        except OSError: pass


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    diarize: str | None = Form(None),
    include_embeddings: str | None = Form(None),
    word_timestamps: str | None = Form(None),
    timestamp_granularities: str | None = Form(None),
) -> JSONResponse:
    """OpenAI-compatible transcription → {text, segments[], language}.

    Optional, all parity with Strix's WhisperX (gated by request flags so plain
    calls stay fast):
      - `diarize=true`         → pyannote speaker-diarization-3.1; tags
                                 `segments[].speaker` + top-level `speakers[]`.
      - `include_embeddings=true` → speechbrain ECAPA-TDNN (spkrec-ecapa-voxceleb,
                                 192-dim — the SAME space IndrasNet/Strix store, ADR-022)
                                 per segment (`segments[].embedding`) and per speaker
                                 (`speaker_embeddings`). Implies diarization.
      - `word_timestamps=true` (or `timestamp_granularities` containing "word", ADR-034)
                                 → `segments[].words: [{word,start,end}]`.
    Response stays OpenAI-compatible (top-level `text`).
    """
    def _truthy(v):
        return (v or "").strip().lower() in ("1", "true", "yes", "on")
    want_embeddings = _truthy(include_embeddings)
    want_diarize = _truthy(diarize) or want_embeddings          # embeddings need speaker turns
    want_words = _truthy(word_timestamps) or "word" in (timestamp_granularities or "").lower()
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
        if want_words:
            kwargs["word_timestamps"] = True            # mlx-whisper emits per-word start/end

        t0 = time.perf_counter()
        result = mlx_whisper.transcribe(tmp_path, **kwargs)
        elapsed = time.perf_counter() - t0

        segments = []
        for i, seg in enumerate(result.get("segments", []) or []):
            s = {"id": i, "start": seg.get("start"), "end": seg.get("end"),
                 "text": (seg.get("text") or "").strip()}
            if want_words:
                s["words"] = [{"word": (w.get("word") or "").strip(), "start": w.get("start"), "end": w.get("end")}
                              for w in (seg.get("words") or [])]
            segments.append(s)
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

        emb_info = None
        speaker_embeddings = None
        if want_embeddings:
            e0 = time.perf_counter()
            try:
                segments, speaker_embeddings, edim = _embed_segments(tmp_path, segments)
                if edim:
                    emb_info = {"model": "speechbrain/spkrec-ecapa-voxceleb", "dim": edim,
                                "n_speaker_vectors": len(speaker_embeddings or {}),
                                "elapsed_seconds": round(time.perf_counter() - e0, 3)}
                    log.info("embeddings ok: %d-dim ECAPA, %d speaker vec(s) in %.2fs",
                             edim, len(speaker_embeddings or {}), time.perf_counter() - e0)
                else:
                    emb_info = {"error": _ecapa.get("error") or "embedder unavailable"}
                    log.warning("embeddings requested but unavailable: %s", emb_info["error"])
            except Exception as e:  # never fail the whole transcription on embeddings
                emb_info = {"error": f"{type(e).__name__}: {e}"}
                log.exception("embeddings FAILED")

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
            "speaker_embeddings": speaker_embeddings,
            "diarization": diar_info,
            "embeddings": emb_info,
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

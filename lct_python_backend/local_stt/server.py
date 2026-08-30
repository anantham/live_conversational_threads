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

import asyncio
import importlib
import logging
import math
import os
import tempfile
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL = os.getenv("LOCAL_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
PORT = int(os.getenv("LOCAL_STT_PORT", "5095"))
DEBUG = os.getenv("LOCAL_STT_DEBUG", "false").strip().lower() in ("1", "true", "yes", "on")
# No-speech VAD gate (#1): skip transcription when silero-vad finds no voice activity,
# so the model can't hallucinate filler ("thank you" / "¡Suscríbete!") on silence/
# ambient. On by default; tune the min speech-seconds or disable via env.
VAD_GATE = os.getenv("LOCAL_STT_VAD_GATE", "true").strip().lower() in ("1", "true", "yes", "on")
VAD_MIN_SPEECH_S = float(os.getenv("LOCAL_STT_VAD_MIN_SPEECH_S", "0.25"))
# Anti-hallucination decode options (#1). condition_on_previous_text=False breaks the
# repeat-loop attractor (endless "thank you"/"excuse me"); the thresholds route
# low-confidence/gibberish segments through the temperature fallback instead of
# emitting them verbatim. Applied to every mlx_whisper.transcribe call.
ANTI_HALLUCINATION_OPTS = {
    "condition_on_previous_text": False,
    "compression_ratio_threshold": 2.4,
    "logprob_threshold": -1.0,
    "no_speech_threshold": 0.6,
}
# Browser edge STT (ADR-056 Phase 1c) POSTs here directly from the web app's
# origin (e.g. https://threads.adityaarpitha.com over Tailscale Serve HTTPS) — a
# CROSS-ORIGIN request the browser blocks without CORS. Default "*" suits the
# personal/trusted-tailnet posture (this endpoint is tailnet-only anyway); set
# LOCAL_STT_CORS_ORIGINS to a comma-separated allowlist to tighten.
CORS_ORIGINS = os.getenv("LOCAL_STT_CORS_ORIGINS", "*").strip()

# Blocking MLX/PyTorch inference must never run on the ASGI event loop. Bound
# the worker admission as well: an unlimited thread queue makes saturation look
# exactly like a dead server to callers and watchdogs.
MAX_CONCURRENCY = max(1, int(os.getenv("MLX_STT_MAX_CONCURRENCY", "2")))
RETRY_AFTER_S = max(1, int(os.getenv("MLX_STT_RETRY_AFTER_S", "30")))
_slots = asyncio.BoundedSemaphore(MAX_CONCURRENCY)
_inflight = {"n": 0}

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s [local_stt] %(message)s",
)
log = logging.getLogger("lct_local_stt")

app = FastAPI(title="LCT Local STT (mlx-whisper)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)
_state = {"ready": False, "requests": 0, "failures": 0, "saturated_rejections": 0}


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
        "inflight": _inflight["n"],
        "max_concurrency": MAX_CONCURRENCY,
        "busy": _inflight["n"] >= MAX_CONCURRENCY,
        "saturated_rejections": _state["saturated_rejections"],
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


# ---------------------------------------------------------------------------
# No-speech gate — silero-vad. Lazy + cached. The single biggest source of Whisper
# hallucination on the live/relay path is silence/ambient chunks, where the model
# invents filler ("thank you", "¡Suscríbete al canal!"). If VAD finds no voice
# activity we skip transcription entirely.
# ---------------------------------------------------------------------------
_vad: dict = {"model": None, "error": None}


def _get_vad():
    if _vad["model"] is not None or _vad["error"] is not None:
        return _vad["model"]
    try:
        from silero_vad import load_silero_vad
        _vad["model"] = load_silero_vad()
        log.info("silero-vad loaded (no-speech gate)")
    except Exception as e:
        _vad["error"] = f"{type(e).__name__}: {e}"
        log.warning("silero-vad unavailable; no-speech gate DISABLED: %s", _vad["error"])
    return _vad["model"]


def _dbfs(chunk) -> float:
    """Return RMS dBFS for a 1-D torch audio tensor; -inf means silence."""
    import torch

    if chunk is None or chunk.numel() == 0:
        return float("-inf")
    rms = float(torch.sqrt(torch.mean(chunk.float() ** 2)))
    if rms <= 1e-9:
        return float("-inf")
    return 20.0 * math.log10(rms)


def _vad_analyze(path: str):
    """Return speech regions and relative levels, or None when VAD cannot run.

    Silero already tells us *where* speech occurs. Keeping only the summed
    duration made a long recording with a silent head indistinguishable from a
    tightly cropped recording, which prevented evidence-based cropping and
    hallucination diagnosis. Levels remain advisory: a neural VAD miss must not
    silently delete quiet real speech.
    """
    m = _get_vad()
    if m is None:
        return None
    try:
        from silero_vad import read_audio, get_speech_timestamps

        wav = read_audio(path, sampling_rate=16000)
        ts = get_speech_timestamps(wav, m, sampling_rate=16000)
        regions = [
            (float(item["start"]) / 16000.0, float(item["end"]) / 16000.0)
            for item in ts
        ]
        total_s = float(wav.numel()) / 16000.0
        if not regions:
            level = _dbfs(wav)
            return {
                "regions": [],
                "speech_dbfs": float("-inf"),
                "head_dbfs": level,
                "tail_dbfs": level,
                "total_s": total_s,
            }

        import torch

        speech = torch.cat(
            [wav[int(start * 16000):int(end * 16000)] for start, end in regions]
        )
        head = wav[:int(regions[0][0] * 16000)]
        tail = wav[int(regions[-1][1] * 16000):]
        return {
            "regions": regions,
            "speech_dbfs": _dbfs(speech),
            "head_dbfs": _dbfs(head),
            "tail_dbfs": _dbfs(tail),
            "total_s": total_s,
        }
    except Exception as e:
        log.warning("VAD check failed (%s) — not gating", e)
        return None


def _vad_speech_seconds(analysis) -> float:
    if not isinstance(analysis, dict):
        return 0.0
    return sum(
        max(0.0, float(end) - float(start))
        for start, end in (analysis.get("regions") or [])
    )


def _serialize_vad_analysis(analysis):
    """Convert internal tuples/-inf levels into a strict JSON-safe shape."""
    if not isinstance(analysis, dict):
        return None

    def finite_or_none(value):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None

    return {
        "regions": [
            {"start": float(start), "end": float(end)}
            for start, end in (analysis.get("regions") or [])
        ],
        "speech_seconds": round(_vad_speech_seconds(analysis), 3),
        "speech_dbfs": finite_or_none(analysis.get("speech_dbfs")),
        "head_dbfs": finite_or_none(analysis.get("head_dbfs")),
        "tail_dbfs": finite_or_none(analysis.get("tail_dbfs")),
        "total_seconds": finite_or_none(analysis.get("total_s")),
    }


def _has_speech(path: str):
    """True/False after VAD; None means unavailable/error and callers fail open."""
    analysis = _vad_analyze(path)
    if analysis is None:
        return None
    return _vad_speech_seconds(analysis) >= VAD_MIN_SPEECH_S


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

    # Do not create an unbounded wait queue. In the single event loop there is
    # no suspension point between this check and the immediate semaphore
    # acquire, so an available slot cannot be stolen between the two operations.
    if _slots.locked():
        _state["saturated_rejections"] += 1
        log.warning(
            "STT saturated: inflight=%d max=%d; rejecting with retry_after=%ds",
            _inflight["n"],
            MAX_CONCURRENCY,
            RETRY_AFTER_S,
        )
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": str(RETRY_AFTER_S)},
            content={
                "error": "Local STT is at compute capacity; retry later.",
                "code": "local_stt_saturated",
                "inflight": _inflight["n"],
                "max_concurrency": MAX_CONCURRENCY,
                "retry_after_seconds": RETRY_AFTER_S,
            },
        )

    await _slots.acquire()
    _inflight["n"] += 1
    tmp_path = None

    try:
        # Lazy import remains cheap at module import time, but first-load work is
        # itself blocking and therefore belongs in the worker pool.
        mlx_whisper = await run_in_threadpool(importlib.import_module, "mlx_whisper")
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

        def _write_temp_audio() -> str:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(payload)
                return tmp.name

        tmp_path = await run_in_threadpool(_write_temp_audio)

        # No-speech gate (#1): if silero-vad finds no voice activity, skip the model
        # entirely and return empty — otherwise it hallucinates filler on silence/
        # ambient. Fails OPEN (None -> transcribe) so a broken gate never drops audio.
        vad_analysis = (
            await run_in_threadpool(_vad_analyze, tmp_path)
            if VAD_GATE
            else None
        )
        serialized_vad = _serialize_vad_analysis(vad_analysis)
        if vad_analysis is not None and _vad_speech_seconds(vad_analysis) < VAD_MIN_SPEECH_S:
            _state["ready"] = True
            log.info("VAD gate: no speech in file=%s -> empty result (transcription skipped)", file.filename)
            return JSONResponse({
                "text": "", "segments": [], "language": None,
                "speakers": None, "speaker_embeddings": None,
                "diarization": None, "embeddings": None,
                "_engine": "mlx-whisper", "_model": DEFAULT_MODEL,
                "_requested_model": model, "_elapsed_seconds": 0.0, "_vad_gated": True,
                "_vad_analysis": serialized_vad,
            })
        # OpenAI-compatible clients send a `model` form field (e.g. "whisper-1",
        # "whisper-large-v3-turbo"). This server serves ONE preloaded model, so IGNORE
        # the client value and always use DEFAULT_MODEL — otherwise mlx-whisper tries to
        # resolve the client string as an HF repo and 500s ("Repository Not Found").
        if model and model != DEFAULT_MODEL:
            log.info("ignoring client model=%r; serving preloaded %s", model, DEFAULT_MODEL)
        kwargs: dict = {"path_or_hf_repo": DEFAULT_MODEL, **ANTI_HALLUCINATION_OPTS}
        if language and language.strip().lower() not in ("", "auto", "none"):
            kwargs["language"] = language.strip()
        if want_words:
            kwargs["word_timestamps"] = True            # mlx-whisper emits per-word start/end
            kwargs["hallucination_silence_threshold"] = 2.0  # skip silent spans it tries to fill (needs word ts)

        t0 = time.perf_counter()
        result = await run_in_threadpool(
            lambda: mlx_whisper.transcribe(tmp_path, **kwargs)
        )
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
            pipe = await run_in_threadpool(_get_diarizer)
            if pipe is None:                          # missing dep / auth / download — report, don't crash
                diar_info = {"error": _diar.get("error") or "diarizer unavailable"}
                log.warning("diarize requested but unavailable: %s", diar_info["error"])
            else:
                d0 = time.perf_counter()
                diarization = await run_in_threadpool(pipe, tmp_path)
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
                segments, speaker_embeddings, edim = await run_in_threadpool(
                    _embed_segments,
                    tmp_path,
                    segments,
                )
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
            "_vad_gated": False,
            "_vad_analysis": serialized_vad,
        })
    except Exception as exc:  # fail loudly, never silently (AGENTS.md §9)
        _state["failures"] += 1
        log.exception("transcribe FAILED: file=%s", file.filename)
        return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})
    finally:
        try:
            def _cleanup_request() -> None:
                if tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                # Release GPU memory caches after every request. mlx-whisper
                # (Metal) and pyannote-on-MPS retain high-water buffers while
                # model weights remain cached.
                try:
                    import mlx.core as mx
                    mx.clear_cache()
                except Exception:
                    pass
                try:
                    import torch
                    if torch.backends.mps.is_available():
                        torch.mps.empty_cache()
                except Exception:
                    pass

            await run_in_threadpool(_cleanup_request)
        finally:
            _inflight["n"] -= 1
            _slots.release()


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

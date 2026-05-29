# LCT Local On-Device STT Server

A tiny OpenAI-compatible STT server so LCT can transcribe **fully on-device** on
Apple Silicon — **without giving up cloud flexibility.** It's a drop-in for LCT's
existing HTTP STT provider seam: LCT already POSTs audio to
`<provider_url>/v1/audio/transcriptions`, so pointing a provider URL here makes
transcription local. Cloud STT (OpenAI realtime, OpenRouter, remote whisper) stays
fully selectable — **local is just one entry in the provider menu; local-first by
default, switch to cloud anytime.** This is the STT half of the
"provider-pluggable, local *or* cloud, user's choice" principle (see ADR-009).

Engine: [`mlx-whisper`](https://github.com/ml-explore/mlx-examples) (Metal/ANE).
Default model `mlx-community/whisper-large-v3-turbo` (~56× realtime on M5 in the
benchmark; multilingual, so it also future-proofs the deferred Malayalam mode —
see `docs/FEATURE_MULTILINGUAL_TRANSCRIPTION.md`). No external/private dependency;
all deps are public PyPI packages.

## Run

```bash
cd lct_python_backend/local_stt
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt
LOCAL_STT_PORT=5095 .venv/bin/python server.py
# health: curl localhost:5095/health
```

Config via env: `LOCAL_STT_MODEL` (default `mlx-community/whisper-large-v3-turbo`),
`LOCAL_STT_PORT` (default `5095`).

## Point LCT at it

In `lct_python_backend/.env` (gitignored), set the whisper provider URL to local:

```bash
DEFAULT_STT_PROVIDER=whisper
DEFAULT_STT_WHISPER_HTTP_URL=http://localhost:5095/v1/audio/transcriptions
STT_UPLOAD_LOCAL_FIRST=true      # prefer on-device for uploads
# STT_LOCAL_ONLY=true            # optional: fully offline (no cloud fallback)
```

To use **cloud** instead (e.g. on a thin laptop): set `STT_LOCAL_ONLY=false` and
select a cloud provider (OpenAI / OpenRouter) in Settings, or point the URL back
at the remote whisper orchestrator. Same menu, different choice.

## Contract

- `POST /v1/audio/transcriptions` (multipart): `file`, optional `model`,
  `language` (`auto`/empty = detect; a code like `ml` forces it), `response_format`.
  Returns `{ "text", "segments": [{id,start,end,text}], "language" }` —
  exactly what `services/stt_response_parsers.py` expects.
- `GET /health` → `{status, engine, model, backend}`.

## Scope

- **STT only.** Diarization ("who spoke") is a separate on-device backend
  (Senko ~742× / FluidAudio ~28× + speaker embeddings) per the STT/diarization
  split — this server returns words + timestamps; speakers are attached separately.
- macOS / Apple Silicon (MLX). On non-Apple hosts, use a cloud provider or a
  CPU/CUDA STT service instead — that's the flexibility point.

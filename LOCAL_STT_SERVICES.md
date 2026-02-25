# Local STT Services Catalog

This project is now designed for local-first speech-to-text by default.

## Goals
- Keep disk usage low across projects by reusing shared model containers.
- Keep local latency low by running one fast STT service continuously.
- Record telemetry for turnaround speed per provider.

## Canonical Cross-Project Registry

For machine-wide endpoint and venv ownership tracking across multiple projects, use:
- `/Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md`

This file (`LOCAL_STT_SERVICES.md`) remains the project-local companion focused on this repository's settings model.

## Provider IDs

Use these IDs in settings and API payloads:
- `senko`
- `parakeet`
- `whisper`
- `ofc`

## Runtime Pattern (Shared Host Service)

Run one shared local STT service and point every project at it:

```bash
cd ../parakeet-tdt-0.6b-v3-fastapi-openai
docker compose up -d parakeet-cpu
curl http://localhost:5092/health
```

Then set project STT URLs to the shared endpoint in Settings.

## Disk Strategy

- Docker image layers are shared by tag across projects on the same host.
- Model files should be shared with a named volume or bind mount.
- Avoid per-project duplicated model downloads.
- Python virtualenvs still duplicate package installs; this is expected.

## STT Config Keys

- `provider`: active provider ID.
- `provider_urls`: websocket URL map per provider.
- `local_only`: when `true` (default), no external fallback is used.
- `external_fallback_ws_url`: optional fallback URL, used only when `local_only=false`.
- `store_audio`: optional chunk persistence for reprocessing.

### Path A (Parakeet + Pyannote sidecar)

For faster ASR with separate diarization in upload flow:
- `provider=parakeet`
- `STT_PARAKEET_PYANNOTE_ENABLED=true`
- `STT_PYANNOTE_HF_TOKEN=<token>`
- optional speaker hints: `STT_PYANNOTE_MIN_SPEAKERS`, `STT_PYANNOTE_MAX_SPEAKERS`

Telemetry will include stage timings:
- `stt_provider_ms`
- `diarization_ms`
- `alignment_ms`
- `bottleneck_stage` / `bottleneck_ms`

### Optional async diarization queue (upload-first UX)

If you want the graph to start fast and diarization to continue in background:
- `IMPORT_ASYNC_DIARIZATION_ENABLED=true`
- Keep `provider=parakeet`
- Optionally leave `STT_PARAKEET_PYANNOTE_ENABLED=false` for the fast lane and let the background queue force diarization.

Polling endpoints:
- `GET /api/import/diarization-jobs/{job_id}`
- `GET /api/import/diarization-jobs/{job_id}/events?cursor=<last_seq>`

## Local LLM Endpoint (Semantic Clustering)

For topic/tangent clustering and graph generation, point local LLM settings to:
- `http://100.81.65.74:1234/v1/models` (model catalog)

In app settings, keep LLM mode local and configure the local base URL so semantic analysis stays on-device/network-local.

## Telemetry Captured Per Transcript Event

Stored under transcript event metadata:
- `telemetry.event_received_at_ms`
- `telemetry.audio_send_started_at_ms`
- `telemetry.first_partial_at_ms`
- `telemetry.first_final_at_ms`
- `telemetry.partial_turnaround_ms`
- `telemetry.final_turnaround_ms`

These fields let you compare provider responsiveness on real conversations.

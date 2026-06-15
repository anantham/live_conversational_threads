# Live meeting → conversation graph (Attendee bot)

Paste a Google Meet link → a locally‑hosted [Attendee](https://docs.attendee.dev)
bot joins the call → its transcript drives the **existing** live‑graph pipeline in
real time. Everything runs on this machine; with the self‑hosted‑STT path no audio
leaves the box except to Google Meet itself.

## How it fits together

```
Google Meet ─▶ Attendee bot (Docker: Django app + Postgres + Redis + Celery worker
                              running headless Chrome; recordings → local MinIO)
                  │  per-utterance MP3 ──▶ Custom-Async STT shim (host :7878) ──▶ your local STT (:7777)
                  │  transcript.update (project webhook, http) 
                  ▼
   POST /api/attendee/webhook  (LCT backend, host :43181 via host.docker.internal)
                  │  verify HMAC X-Webhook-Signature, route by bot_id
                  ▼
   attendee_bridge  ── loopback WS client ──▶ /ws/transcripts  (REUSED VERBATIM:
     session_meta / transcript_final / final_flush)   persist → processor → consolidation
                  │  receives existing_json / graph_patch
                  ▼  relays the same protocol
   /ws/meeting/{conversation_id}  ◀── browser viewer  (reuses the recording-path graph handlers)
```

The bridge — not the browser — owns the session, so the bot keeps recording and the
graph keeps building even if you close the tab. The loopback producer and the
outbound call to Attendee both target `127.0.0.1`, which the `LCT_LOCAL_ONLY`
egress chokepoint (ADR‑034) already classifies as local.

## Prerequisites

- Docker Desktop with the WSL2 backend (this box: Docker 29.2.1, Compose v5.1, WSL2 Ubuntu ✓), x86‑64.
- ~8 GB RAM free for Docker (each bot is a real Chrome + ffmpeg).
- Your local STT reachable on the host (e.g. whisperx/parakeet at `:7777`) — only for the self‑hosted‑STT path.

---

## Part A — Stand up Attendee + MinIO

```powershell
git clone https://github.com/attendee-labs/attendee.git
cd attendee
# copy the MinIO override from this repo:
copy <lct>\attendee_stack\docker-compose.minio.yml .

docker compose -f dev.docker-compose.yaml -f docker-compose.minio.yml build      # ~5 min first time

# generate .env (PowerShell form avoids UTF-16/BOM), then append our keys:
docker compose -f dev.docker-compose.yaml run --rm attendee-app-local python init_env.py | Out-File -Encoding utf8 .env
Get-Content <lct>\attendee_stack\attendee.env.example | Add-Content -Encoding utf8 .env

docker compose -f dev.docker-compose.yaml -f docker-compose.minio.yml up -d
docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
```

MinIO console: <http://localhost:9001> (user `attendee` / pass `attendeeminio123`). The
`minio-createbucket` container creates `attendee-recordings` on first up.

## Part B — Mint an API key (manual, UI‑only)

Open <http://localhost:8000>, create an account, sign in, and under **API Keys** in the
sidebar generate a key. **Copy the plaintext now — only its hash is stored.**

## Part C — Register the project webhook (manual)

In **Settings → Webhooks → Create Webhook**:

- URL: `http://host.docker.internal:43181/api/attendee/webhook`
  (the LCT backend port — check `.backend-port`; it binds `0.0.0.0`, so the container can reach it).
- Triggers: **`transcript.update`** and **`bot.state_change`**.
- Copy the **signing secret** (base64) → it becomes `ATTENDEE_WEBHOOK_SECRET` in LCT's `.env`.

> Register here, **not** inline in create‑bot: Attendee forces `https://` on inline create‑bot
> webhooks (`serializers.py:1235`) regardless of `REQUIRE_HTTPS_WEBHOOKS`. The project path
> honors `REQUIRE_HTTPS_WEBHOOKS=false` and accepts the `http://` URL.

## Part D — Transcription source

### Option 1 — Self‑hosted STT via the shim (primary, fully local)

1. Run the shim on the host (adapt `_call_local_stt` in `attendee_stack/stt_shim.py` to your STT's real API):
   ```powershell
   uvicorn attendee_stack.stt_shim:app --host 0.0.0.0 --port 7878
   ```
2. `attendee.env.example` already set `CUSTOM_ASYNC_TRANSCRIPTION_URL=http://host.docker.internal:7878/transcribe`.
3. LCT default `ATTENDEE_TRANSCRIPTION_MODE=custom_async` sends `transcription_settings.custom_async_v2`
   and records audio (`recording_settings.format=mp3`) so per‑utterance audio blobs exist to POST.

**Honest caveat (verified‑unconfirmed):** Attendee's code requires per‑utterance audio
blobs (`process_utterance_task.py:535`) for Custom Async; whether `custom_async_v2` alone
populates them on Google Meet without recording on is *unconfirmed from source*. Recording
is enabled as a precaution. If in testing no audio reaches the shim / no `transcript.update`
fires, use Option 2.

### Option 2 — Google Meet closed captions (zero‑STT fallback)

Set `ATTENDEE_TRANSCRIPTION_MODE=closed_captions` in LCT's `.env`. No shim, no recording,
near‑instant. Uses Google's own captions — since it's a Google Meet, Google already has the
audio, so nothing new leaves the machine. Lower fidelity than your whisperx, but proven.

## Part E — Configure LCT and restart

Add to `lct_python_backend/.env`:

```
ATTENDEE_API_KEY=<key from Part B>
ATTENDEE_BASE_URL=http://127.0.0.1:8000
ATTENDEE_WEBHOOK_SECRET=<signing secret from Part C>
ATTENDEE_BOT_NAME=LCT Live Graph
ATTENDEE_TRANSCRIPTION_MODE=custom_async        # or closed_captions
ATTENDEE_STT_LANGUAGE=en
ATTENDEE_RECORDING_FORMAT=mp3                    # custom_async path; ignored for closed_captions
# optional: ATTENDEE_FINALIZE_QUIESCE_S=30  ATTENDEE_FINALIZE_MAX_S=600
```

Restart the LCT backend. Check: `GET /api/attendee/health` → `attendee_configured: true`,
`webhook_secret_set: true`.

## Part F — Use it

Home → **Meet** (or `/meeting`) → paste the Meet link → **Join meeting**. You land on the
live graph view. Admit the bot if the meeting has a waiting room; the status chip tracks
joining → recording → wrapping up. The graph fills in as people speak.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `create_bot` → 400 "CUSTOM_ASYNC_TRANSCRIPTION_URL not set" | Set it in Attendee's `.env` (Part D) and restart the stack. |
| Bot 401 on webhook | LCT `ATTENDEE_WEBHOOK_SECRET` must equal the project webhook secret. |
| Webhook never arrives | `REQUIRE_HTTPS_WEBHOOKS=false`; LCT bound `0.0.0.0`; URL uses `host.docker.internal:43181`; worker has `extra_hosts: host-gateway` (in the override). |
| MinIO `SignatureDoesNotMatch` | Add `"addressing_style": "path"` to the S3 OPTIONS in `attendee/settings/base.py` (~line 280). |
| No transcripts on Meet (custom_async) | Switch to `ATTENDEE_TRANSCRIPTION_MODE=closed_captions` (Option 2). |
| Graph empty but bot recording | Consolidation thresholds: topics need ≥4 ideas, themes ≥3 topics, arcs ≥2 themes. Short meetings stay at chunk/idea tier. |
| No nodes at all / `ACCUMULATE-IDX ... Timeout` in logs | The live graph‑gen LLM is timing out (e.g. local LM Studio at 120 s) — this is local‑mode graph quality (branch `fix/local-mode-graph-quality`), **independent of Attendee**; the mic path fails the same way. Use a faster model or raise the LLM timeout. The bridge/persist/relay still work. |

## Known limitations (v1)

- **Speaker id is session‑constant**: per‑utterance `speaker_name` is mapped correctly, but
  the session‑level `speaker_id` is constant (the live STT path is single‑mic). Speaker *names*
  thread correctly; finer per‑speaker rollup is a follow‑up.
- **Viewer replay log grows** with the meeting (kept in memory for late‑joiner snapshots).
- **No producer reconnect**: if the loopback socket drops mid‑meeting, transcripts stop;
  the bot keeps recording on Attendee (re‑fetchable via the saved conversation).
- **The API key + webhook are one‑time manual UI steps** — they can't be scripted headlessly.

# Local Setup and Daily Startup

## One-Time Setup

Run this once after cloning the repository:

```bash
./setup-once.command
```

What it does:
- Ensures PostgreSQL 15 binaries are available (`Homebrew` install if needed).
- Creates `.venv` and installs Python dependencies.
- Installs frontend npm dependencies.
- Initializes project-local PostgreSQL data in `.postgres_data` on port `5433`.
- Creates `lct_python_backend/.env` from `.env.example` if missing.
- Runs database migrations.

## Daily Startup

Run this for day-to-day development:

```bash
./start.command
```

What it does:
- Loads `lct_python_backend/.env`.
- Cleans up stale backend/frontend processes from this repo.
- Validates required local dependencies are present.
- Starts local PostgreSQL if needed.
- Runs `alembic upgrade head`.
- Starts backend (`uvicorn`) and frontend (`vite`) with prefixed terminal logs.
- Keeps both processes attached until `Ctrl+C`, then shuts both down.
- Prints a quick STT endpoint status summary (legacy WS + known HTTP services).
- Prints local LLM endpoint status (`$LOCAL_LLM_BASE_URL/v1/models`) and active mode.

If migrations are already applied and Alembic history is temporarily inconsistent, skip migration execution for that run:

```bash
SKIP_MIGRATIONS=1 ./start.command
```

## Shared STT Autostart

`./start.command` enables shared Parakeet autostart by default (`STT_AUTOSTART=1`) to support backend-owned STT routing.

Manual equivalent:

```bash
STT_AUTOSTART=1 STT_AUTOSTART_PROVIDER=parakeet ./start.command
```

Notes:
- This reuses the sibling repository at `../parakeet-tdt-0.6b-v3-fastapi-openai`.
- The Parakeet container uses Docker volume `parakeet-models`, so model cache stays shared across projects.
- If Docker/daemon/repo is unavailable, startup continues and logs a clear note.
- To skip STT autostart for one run: `STT_AUTOSTART=0 ./start.command`.

## Legacy Scripts Archive

The old startup/setup scripts were moved to:

```text
scripts/legacy_commands/
```

Archived files:
- `setup-backend.command`
- `setup-postgres-local.command`
- `start-backend-local.command`
- `start-backend.command`
- `stop-postgres-local.command`
- `start_server.sh`

## Local STT Reminder

Live audio transcription now runs through backend-owned STT routing.
You need a reachable provider HTTP transcription URL in Settings (for example Parakeet `http://localhost:5092/v1/audio/transcriptions`).
The legacy WS endpoint (`:43001`) is optional and no longer required for the default path.

## Local LLM Reminder

Default local LLM endpoint is Tailscale LM Studio:

```text
LOCAL_LLM_BASE_URL=http://100.81.65.74:1234
```

If an older config still points to `localhost:1234`, backend config merge rewrites it to the Tailscale base URL.

## Logs and API Trace

- Persistent backend log file: `logs/backend.log`
- Terminal stream from `start.command` already prefixes backend/frontend logs.
- Outbound STT + LLM call trace logging is enabled by default:
  - `TRACE_API_CALLS=true`
  - `API_LOG_PREVIEW_CHARS=280`
- Frontend API calls are logged in browser dev console in dev mode (`VITE_API_TRACE` can override).

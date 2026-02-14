#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$PWD"
RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"

PID_BACKEND="$RUN_DIR/backend.pid"
PID_FRONTEND="$RUN_DIR/frontend.pid"

VENV_PY="$ROOT_DIR/.venv/bin/python3"
ENV_FILE="$ROOT_DIR/lct_python_backend/.env"

PG_DATA="$ROOT_DIR/.postgres_data"
PG_LOG="$ROOT_DIR/.postgres.log"
PG_PORT="${PG_PORT:-5433}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
DB_URL_DEFAULT="postgresql://lct_user:lct_password@localhost:${PG_PORT}/lct_dev"

POSTGRES_BIN_ARM="/opt/homebrew/opt/postgresql@15/bin"
POSTGRES_BIN_INTEL="/usr/local/opt/postgresql@15/bin"

BACKEND_HEALTH_URL="http://localhost:${BACKEND_PORT}/api/import/health"
FRONTEND_HEALTH_URL="http://localhost:${FRONTEND_PORT}"
PARAKEET_HEALTH_URL="${PARAKEET_HEALTH_URL:-http://localhost:5092/health}"
WHISPER_HTTP_HEALTH_URL="${WHISPER_HTTP_HEALTH_URL:-http://172.20.5.123:8000/health}"
WHISPERX_HTTP_HEALTH_URL="${WHISPERX_HTTP_HEALTH_URL:-http://172.20.5.123:8001/health}"

STT_AUTOSTART="${STT_AUTOSTART:-1}"
STT_AUTOSTART_PROVIDER="${STT_AUTOSTART_PROVIDER:-parakeet}"
SHARED_PARAKEET_DIR="${SHARED_PARAKEET_DIR:-$ROOT_DIR/../parakeet-tdt-0.6b-v3-fastapi-openai}"
STT_START_TIMEOUT_S="${STT_START_TIMEOUT_S:-120}"

BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP=0

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

ensure_postgres_path() {
  if [ -d "$POSTGRES_BIN_ARM" ]; then
    export PATH="$POSTGRES_BIN_ARM:$PATH"
  elif [ -d "$POSTGRES_BIN_INTEL" ]; then
    export PATH="$POSTGRES_BIN_INTEL:$PATH"
  fi

  command -v pg_ctl >/dev/null 2>&1 || fail "pg_ctl not found. Run ./setup-once.command first."
}

kill_pid_gracefully() {
  local pid="$1"
  local label="$2"

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return
  fi

  log "Stopping ${label} (pid ${pid})..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return
    fi
    sleep 0.2
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    log "Force stopping ${label} (pid ${pid})..."
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

stop_pidfile_process() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill_pid_gracefully "$pid" "$label"
  fi
  rm -f "$pid_file"
}

cleanup_port() {
  local port="$1"
  local label="$2"

  local pid
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [ -z "$pid" ]; then
    return 0
  fi

  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  if [[ "$cmd" == *"$ROOT_DIR"* ]]; then
    kill_pid_gracefully "$pid" "$label on :$port"
  else
    fail "Port $port is already in use by an external process: ${cmd:-unknown}"
  fi
}

load_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    fail "Missing $ENV_FILE. Run ./setup-once.command first."
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  export DATABASE_URL="${DATABASE_URL:-$DB_URL_DEFAULT}"
  export LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://100.81.65.74:1234}"
  export DEFAULT_LLM_MODE="${DEFAULT_LLM_MODE:-local}"
}

ensure_prereqs() {
  [ -x "$VENV_PY" ] || fail "Missing Python venv at .venv. Run ./setup-once.command first."
  [ -d "$PG_DATA" ] || fail "Missing .postgres_data. Run ./setup-once.command first."
  [ -d "$ROOT_DIR/lct_app/node_modules" ] || fail "Missing frontend dependencies. Run ./setup-once.command first."

  command -v npm >/dev/null 2>&1 || fail "npm is required but not installed."
  command -v curl >/dev/null 2>&1 || fail "curl is required but not installed."
  command -v lsof >/dev/null 2>&1 || fail "lsof is required but not installed."
}

start_postgres() {
  if ! pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then
    log "Starting local PostgreSQL on port ${PG_PORT}..."
    pg_ctl -D "$PG_DATA" -l "$PG_LOG" -o "-p ${PG_PORT}" start >/dev/null
    sleep 2
  fi

  pg_ctl -D "$PG_DATA" status >/dev/null 2>&1 || fail "PostgreSQL failed to start. Check $PG_LOG"
}

run_migrations() {
  if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
    log "Skipping migrations (SKIP_MIGRATIONS=1)."
    return 0
  fi

  log "Running migrations (alembic upgrade head)..."
  if (
    cd "$ROOT_DIR/lct_python_backend"
    DATABASE_URL="$DATABASE_URL" "$VENV_PY" -m alembic upgrade head
  ); then
    return 0
  fi

  fail "Migration failed. If schema is already initialized, run with SKIP_MIGRATIONS=1."
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local timeout_s="$3"

  for _ in $(seq 1 "$timeout_s"); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      log "$name is ready: $url"
      return 0
    fi
    sleep 1
  done

  return 1
}

start_shared_parakeet_if_needed() {
  if curl -fsS --max-time 2 "$PARAKEET_HEALTH_URL" >/dev/null 2>&1; then
    log "Shared Parakeet STT already healthy: $PARAKEET_HEALTH_URL"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    log "NOTE: docker is unavailable; skipping shared Parakeet autostart."
    return 0
  fi

  if ! docker info >/dev/null 2>&1; then
    log "NOTE: Docker daemon is not reachable; skipping shared Parakeet autostart."
    return 0
  fi

  if [ ! -f "$SHARED_PARAKEET_DIR/docker-compose.yml" ]; then
    log "NOTE: Shared Parakeet repo missing at $SHARED_PARAKEET_DIR; skipping autostart."
    return 0
  fi

  log "Starting shared Parakeet STT (parakeet-cpu) from $SHARED_PARAKEET_DIR..."
  if ! (
    cd "$SHARED_PARAKEET_DIR"
    docker compose up -d parakeet-cpu >/dev/null
  ); then
    log "NOTE: Failed to start Parakeet container."
    return 0
  fi

  if wait_for_http "Parakeet STT" "$PARAKEET_HEALTH_URL" "$STT_START_TIMEOUT_S"; then
    log "Parakeet STT is ready and reuses Docker volume 'parakeet-models' (shared cache)."
  else
    log "NOTE: Parakeet container started but health check failed at $PARAKEET_HEALTH_URL"
  fi
}

start_optional_stt_services() {
  if [ "$STT_AUTOSTART" != "1" ]; then
    return 0
  fi

  case "$STT_AUTOSTART_PROVIDER" in
    parakeet)
      start_shared_parakeet_if_needed
      ;;
    none)
      log "STT autostart requested with provider=none; skipping."
      ;;
    *)
      log "NOTE: Unknown STT_AUTOSTART_PROVIDER='$STT_AUTOSTART_PROVIDER'; skipping STT autostart."
      ;;
  esac
}

report_known_stt_endpoints() {
  if lsof -nP -iTCP:43001 -sTCP:LISTEN >/dev/null 2>&1; then
    log "STT WS status (legacy optional): listener detected on ws://localhost:43001/stream"
  else
    log "STT WS status (legacy optional): no listener on ws://localhost:43001/stream"
  fi

  if curl -fsS --max-time 2 "$PARAKEET_HEALTH_URL" >/dev/null 2>&1; then
    log "STT HTTP status: Parakeet healthy at $PARAKEET_HEALTH_URL"
  else
    log "STT HTTP status: Parakeet unreachable at $PARAKEET_HEALTH_URL"
  fi

  if curl -fsS --max-time 2 "$WHISPER_HTTP_HEALTH_URL" >/dev/null 2>&1; then
    log "STT HTTP status: Whisper healthy at $WHISPER_HTTP_HEALTH_URL"
  else
    log "STT HTTP status: Whisper unreachable at $WHISPER_HTTP_HEALTH_URL"
  fi

  if curl -fsS --max-time 2 "$WHISPERX_HTTP_HEALTH_URL" >/dev/null 2>&1; then
    log "STT HTTP status: WhisperX healthy at $WHISPERX_HTTP_HEALTH_URL"
  else
    log "STT HTTP status: WhisperX unreachable at $WHISPERX_HTTP_HEALTH_URL"
  fi
}

report_llm_endpoint() {
  local models_url="${LOCAL_LLM_BASE_URL%/}/v1/models"
  if curl -fsS --max-time 3 "$models_url" >/dev/null 2>&1; then
    log "LLM endpoint status: reachable at $models_url (mode=${DEFAULT_LLM_MODE})"
  else
    log "LLM endpoint status: unreachable at $models_url (mode=${DEFAULT_LLM_MODE})"
  fi
}

start_backend() {
  log "Starting backend on port ${BACKEND_PORT}..."
  (
    export DATABASE_URL="$DATABASE_URL"
    export PYTHONPATH="$ROOT_DIR:${PYTHONPATH:-}"
    exec "$VENV_PY" -m uvicorn lct_python_backend.backend:lct_app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
  ) > >(sed -u 's/^/[backend] /') 2>&1 &

  BACKEND_PID="$!"
  echo "$BACKEND_PID" > "$PID_BACKEND"

  wait_for_http "Backend" "$BACKEND_HEALTH_URL" 60 || fail "Backend failed health check at $BACKEND_HEALTH_URL"
}

start_frontend() {
  log "Starting frontend on port ${FRONTEND_PORT}..."
  (
    cd "$ROOT_DIR/lct_app"
    export VITE_BACKEND_API_URL="http://localhost:${BACKEND_PORT}"
    exec npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort
  ) > >(sed -u 's/^/[frontend] /') 2>&1 &

  FRONTEND_PID="$!"
  echo "$FRONTEND_PID" > "$PID_FRONTEND"

  wait_for_http "Frontend" "$FRONTEND_HEALTH_URL" 60 || fail "Frontend failed health check at $FRONTEND_HEALTH_URL"
}

stt_readiness_hint() {
  if curl -fsS --max-time 2 "$PARAKEET_HEALTH_URL" >/dev/null 2>&1; then
    log "Detected local STT HTTP provider (Parakeet) at $PARAKEET_HEALTH_URL"
    return
  fi

  if curl -fsS --max-time 2 "$WHISPER_HTTP_HEALTH_URL" >/dev/null 2>&1; then
    log "Detected local STT HTTP provider (Whisper) at $WHISPER_HTTP_HEALTH_URL"
    return
  fi

  if curl -fsS --max-time 2 "$WHISPERX_HTTP_HEALTH_URL" >/dev/null 2>&1; then
    log "Detected local STT HTTP provider (WhisperX) at $WHISPERX_HTTP_HEALTH_URL"
    return
  fi

  log "NOTE: No reachable local STT HTTP provider detected."
  log "      Backend-owned transcription expects a reachable provider HTTP URL in Settings."
}

cleanup_on_exit() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1

  local code="$?"
  log "Shutting down local services started by start.command..."

  if [ -n "$FRONTEND_PID" ]; then
    kill_pid_gracefully "$FRONTEND_PID" "frontend"
  fi
  stop_pidfile_process "$PID_FRONTEND" "frontend"

  if [ -n "$BACKEND_PID" ]; then
    kill_pid_gracefully "$BACKEND_PID" "backend"
  fi
  stop_pidfile_process "$PID_BACKEND" "backend"

  log "Shutdown complete."
  exit "$code"
}

trap cleanup_on_exit INT TERM EXIT

log "Preparing clean start for Live Conversational Threads..."
ensure_postgres_path
load_env_file
ensure_prereqs

stop_pidfile_process "$PID_BACKEND" "backend"
stop_pidfile_process "$PID_FRONTEND" "frontend"
cleanup_port "$BACKEND_PORT" "backend"
cleanup_port "$FRONTEND_PORT" "frontend"

start_postgres
run_migrations
start_backend
start_frontend
start_optional_stt_services
report_known_stt_endpoints
report_llm_endpoint
stt_readiness_hint

log "All services are up."
log "Backend:  http://localhost:${BACKEND_PORT}"
log "Frontend: http://localhost:${FRONTEND_PORT}"
log "Press Ctrl+C to stop both services."

wait "$BACKEND_PID" "$FRONTEND_PID"

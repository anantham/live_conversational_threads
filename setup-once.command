#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$PWD"
VENV_PY="$ROOT_DIR/.venv/bin/python3"
ENV_FILE="$ROOT_DIR/lct_python_backend/.env"

PG_DATA="$ROOT_DIR/.postgres_data"
PG_LOG="$ROOT_DIR/.postgres.log"
PG_PORT="${PG_PORT:-5433}"
DB_URL_DEFAULT="postgresql://lct_user:lct_password@localhost:${PG_PORT}/lct_dev"

POSTGRES_BIN_ARM="/opt/homebrew/opt/postgresql@15/bin"
POSTGRES_BIN_INTEL="/usr/local/opt/postgresql@15/bin"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

ensure_postgres_path() {
  if [ -d "$POSTGRES_BIN_ARM" ]; then
    export PATH="$POSTGRES_BIN_ARM:$PATH"
    return
  fi

  if [ -d "$POSTGRES_BIN_INTEL" ]; then
    export PATH="$POSTGRES_BIN_INTEL:$PATH"
    return
  fi

  if ! command -v brew >/dev/null 2>&1; then
    log "Homebrew not found. Installing Homebrew first..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi

  if ! brew list postgresql@15 >/dev/null 2>&1; then
    log "Installing postgresql@15 with Homebrew..."
    brew install postgresql@15
  fi

  if [ -d "$POSTGRES_BIN_ARM" ]; then
    export PATH="$POSTGRES_BIN_ARM:$PATH"
  elif [ -d "$POSTGRES_BIN_INTEL" ]; then
    export PATH="$POSTGRES_BIN_INTEL:$PATH"
  else
    log "postgresql@15 binaries were not found after install."
    exit 1
  fi
}

ensure_python_env() {
  if [ ! -x "$VENV_PY" ]; then
    log "Creating Python virtual environment (.venv)..."
    python3 -m venv "$ROOT_DIR/.venv"
  fi

  log "Installing Python dependencies..."
  "$VENV_PY" -m pip install --upgrade pip setuptools wheel
  "$VENV_PY" -m pip install -r "$ROOT_DIR/requirements.txt"
  "$VENV_PY" -m pip install -r "$ROOT_DIR/lct_python_backend/requirements.txt"
}

ensure_frontend_deps() {
  if ! command -v npm >/dev/null 2>&1; then
    log "npm is required but not installed."
    exit 1
  fi

  log "Installing frontend dependencies..."
  npm --prefix "$ROOT_DIR/lct_app" install
}

ensure_local_stt_env() {
  # On-device STT (mlx-whisper) runs from its own venv so its heavy deps don't
  # bloat the backend venv. start.command autostarts it (LOCAL_STT_AUTOSTART=1)
  # but only if this venv exists — so create it here. Best-effort: a failure
  # (e.g. non-Apple-Silicon host where mlx-whisper has no wheel) is non-fatal;
  # the app falls back to whatever STT provider is configured in Settings.
  local stt_dir="$ROOT_DIR/lct_python_backend/local_stt"
  local stt_py="$stt_dir/.venv/bin/python"

  if [ -x "$stt_py" ]; then
    log "On-device STT venv already present ($stt_dir/.venv)."
    return 0
  fi

  if [ ! -f "$stt_dir/requirements.txt" ]; then
    log "NOTE: $stt_dir/requirements.txt missing; skipping on-device STT venv."
    return 0
  fi

  log "Creating on-device STT venv (mlx-whisper) at $stt_dir/.venv..."
  if command -v uv >/dev/null 2>&1; then
    ( cd "$stt_dir" && uv venv .venv --python 3.12 \
        && uv pip install --python .venv/bin/python -r requirements.txt ) \
      || log "NOTE: on-device STT venv setup failed (uv). The app will use the STT provider configured in Settings."
  else
    ( python3 -m venv "$stt_dir/.venv" \
        && "$stt_py" -m pip install --upgrade pip >/dev/null \
        && "$stt_py" -m pip install -r "$stt_dir/requirements.txt" ) \
      || log "NOTE: on-device STT venv setup failed (pip). The app will use the STT provider configured in Settings."
  fi

  if [ -x "$stt_py" ]; then
    log "On-device STT venv ready."
  fi
}

ensure_postgres_cluster() {
  if [ ! -d "$PG_DATA" ]; then
    log "Initializing local PostgreSQL data directory at .postgres_data..."
    initdb -D "$PG_DATA" --username=lct_user --pwfile=<(printf 'lct_password\n')
  fi

  if ! pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then
    log "Starting local PostgreSQL on port ${PG_PORT}..."
    pg_ctl -D "$PG_DATA" -l "$PG_LOG" -o "-p ${PG_PORT}" start >/dev/null
    sleep 2
  fi

  if ! pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then
    log "PostgreSQL failed to start. Check $PG_LOG"
    exit 1
  fi

  if ! PGPASSWORD=lct_password psql -h localhost -p "$PG_PORT" -U lct_user -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='lct_dev'" | grep -q 1; then
    log "Creating database lct_dev..."
    createdb -h localhost -p "$PG_PORT" -U lct_user lct_dev
  fi
}

ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    log "Existing lct_python_backend/.env found. Leaving it unchanged."
    return
  fi

  if [ -f "$ROOT_DIR/lct_python_backend/.env.example" ]; then
    cp "$ROOT_DIR/lct_python_backend/.env.example" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi

  if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
    sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=${DB_URL_DEFAULT}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '\nDATABASE_URL=%s\n' "$DB_URL_DEFAULT" >> "$ENV_FILE"
  fi

  log "Created lct_python_backend/.env with local database defaults."
}

run_migrations() {
  log "Running Alembic migrations..."
  (
    cd "$ROOT_DIR/lct_python_backend"
    DATABASE_URL="$DB_URL_DEFAULT" "$VENV_PY" -m alembic upgrade head
  )
}

log "Starting one-time setup for Live Conversational Threads..."
ensure_postgres_path
ensure_python_env
ensure_frontend_deps
ensure_local_stt_env
ensure_postgres_cluster
ensure_env_file
run_migrations

log "Setup complete."
log "Next: run ./start.command"

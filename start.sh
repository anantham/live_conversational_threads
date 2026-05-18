#!/usr/bin/env bash
# Start both the Python backend and Vite frontend dev servers.
# Backend auto-selects a free port (8000–8020) and writes it to .backend-port
# so Vite's proxy knows where to forward requests.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT_FILE="$ROOT_DIR/.backend-port"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  rm -f "$PORT_FILE"
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

kill_pid_gracefully() {
  local pid="$1"
  local label="$2"

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  echo "==> Stopping ${label} (pid ${pid})..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "==> Force stopping ${label} (pid ${pid})..."
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup_port() {
  local port="$1"
  local label="$2"

  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid
  for pid in $pids; do
    local cmd
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    local cwd
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"

    if [[ "$cmd" == *"$ROOT_DIR"* ]] || [[ "$cwd" == "$ROOT_DIR"* ]]; then
      kill_pid_gracefully "$pid" "$label on :$port"
      continue
    fi

    echo "ERROR: Port $port is already in use by an external process: ${cmd:-unknown}" >&2
    exit 1
  done
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local timeout_s="${3:-30}"

  echo -n "    Waiting for ${label}"
  for _ in $(seq 1 "$timeout_s"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      echo " ready!"
      return 0
    fi
    echo -n "."
    sleep 1
  done

  echo ""
  echo "ERROR: ${label} failed health check at ${url}" >&2
  exit 1
}

# Find a free port in the range 8000–8020
find_free_port() {
  for port in $(seq 8000 8020); do
    if ! lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$port"
      return
    fi
  done
  echo "ERROR: No free port found in 8000–8020" >&2
  exit 1
}

BACKEND_PORT=$(find_free_port)
echo "$BACKEND_PORT" > "$PORT_FILE"
echo "==> Backend port: $BACKEND_PORT"

# Start Python backend
cd "$ROOT_DIR"
echo "==> Starting Python backend on :$BACKEND_PORT..."
.venv/bin/python3 -m uvicorn lct_python_backend.backend:app \
  --reload --port "$BACKEND_PORT" --host 0.0.0.0 2>&1 &
BACKEND_PID=$!

wait_for_http "backend" "http://localhost:$BACKEND_PORT/api/import/health" 30

# Start Vite frontend
cleanup_port "$FRONTEND_PORT" "frontend"
cd "$ROOT_DIR/lct_app"
echo "==> Starting Vite frontend on :$FRONTEND_PORT (proxy → localhost:$BACKEND_PORT)..."
unset VITE_BACKEND_API_URL VITE_API_URL
npx vite --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort 2>&1 &
FRONTEND_PID=$!
wait_for_http "frontend" "http://localhost:$FRONTEND_PORT" 30

echo ""
echo "==> LCT is running:"
echo "    Frontend: http://localhost:$FRONTEND_PORT"
echo "    Backend:  http://localhost:$BACKEND_PORT"
echo "    Press Ctrl+C to stop both."
echo ""

wait

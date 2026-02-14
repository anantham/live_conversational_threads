#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"

# Add PostgreSQL to PATH
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

echo "🚀 Starting Live Conversational Threads Backend (Local PostgreSQL)"
echo "=============================================="
echo ""

PG_DATA="$PWD/.postgres_data"
PG_LOG="$PWD/.postgres.log"
PG_PORT=5433

# Check if PostgreSQL data directory exists
if [ ! -d "$PG_DATA" ]; then
    echo "❌ PostgreSQL not set up. Run ./setup-postgres-local.command first"
    exit 1
fi

# Check if PostgreSQL is running, start if not
if ! pg_ctl -D "$PG_DATA" status &> /dev/null; then
    echo "🔄 Starting local PostgreSQL server..."
    pg_ctl -D "$PG_DATA" -l "$PG_LOG" -o "-p $PG_PORT" start
    sleep 2
    echo "✅ PostgreSQL started"
else
    echo "✅ PostgreSQL already running"
fi

echo ""

# Start the backend
echo "🔥 Starting FastAPI backend..."
echo "📍 Backend will be available at: http://localhost:8000"
echo "📍 API docs at: http://localhost:8000/docs"
echo "📍 PostgreSQL running on: localhost:$PG_PORT"
echo ""
echo "Press Ctrl+C to stop the server"
echo "=============================================="
echo ""

export DATABASE_URL="postgresql://lct_user:lct_password@localhost:$PG_PORT/lct_dev"
export PYTHONPATH="$PWD/lct_python_backend:$PYTHONPATH"
cd lct_python_backend
../.venv/bin/python3 -m uvicorn backend:lct_app --host 0.0.0.0 --port 8000 --reload

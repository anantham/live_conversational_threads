#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"

echo "🚀 Starting Live Conversational Threads Backend"
echo "=============================================="
echo ""

# Check if PostgreSQL is running
if ! docker-compose ps postgres | grep -q "Up"; then
    echo "⚠️  PostgreSQL is not running. Starting it now..."
    docker-compose up -d postgres
    echo "⏳ Waiting for PostgreSQL to be ready..."
    sleep 5
fi

echo "✅ PostgreSQL is running"
echo ""

# Start the backend
echo "🔥 Starting FastAPI backend..."
echo "📍 Backend will be available at: http://localhost:8000"
echo "📍 API docs at: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop the server"
echo "=============================================="
echo ""

cd lct_python_backend
export DATABASE_URL="postgresql://lct_user:lct_password@localhost:5432/lct_dev"
../.venv/bin/python3 -m uvicorn backend:app --host 0.0.0.0 --port 8000 --reload

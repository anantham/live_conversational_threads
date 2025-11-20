#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"

# Add PostgreSQL to PATH
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

echo "⏹️  Stopping Local PostgreSQL"
echo "=============================================="

PG_DATA="$PWD/.postgres_data"

if [ ! -d "$PG_DATA" ]; then
    echo "❌ PostgreSQL data directory not found"
    exit 1
fi

if pg_ctl -D "$PG_DATA" status &> /dev/null; then
    pg_ctl -D "$PG_DATA" stop
    echo "✅ PostgreSQL stopped"
else
    echo "ℹ️  PostgreSQL was not running"
fi

echo ""
echo "To completely remove PostgreSQL data:"
echo "  rm -rf .postgres_data .postgres.log"
echo "=============================================="

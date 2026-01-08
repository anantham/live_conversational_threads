#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"

echo "🚀 Live Conversational Threads - Local PostgreSQL Setup"
echo "=============================================="
echo ""

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew not found. Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Add PostgreSQL to PATH
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

# Check if PostgreSQL is installed
if [ ! -d "/opt/homebrew/opt/postgresql@15" ]; then
    echo "📦 Installing PostgreSQL via Homebrew..."
    brew install postgresql@15
    echo "✅ PostgreSQL installed"
else
    echo "✅ PostgreSQL already installed"
fi

# Create local PostgreSQL data directory in project
PG_DATA="$PWD/.postgres_data"
PG_LOG="$PWD/.postgres.log"
PG_PORT=5433

if [ -d "$PG_DATA" ]; then
    echo "⚠️  Local PostgreSQL data directory already exists"
    echo "   To start fresh, run: rm -rf .postgres_data .postgres.log"
else
    echo "📁 Creating local PostgreSQL data directory..."
    initdb -D "$PG_DATA" --username=lct_user --pwfile=<(echo "lct_password")
    echo "✅ PostgreSQL cluster initialized"
fi

# Check if PostgreSQL is already running
if pg_ctl -D "$PG_DATA" status &> /dev/null; then
    echo "✅ PostgreSQL is already running"
else
    # Start PostgreSQL on custom port
    echo "🔄 Starting local PostgreSQL server on port $PG_PORT..."
    pg_ctl -D "$PG_DATA" -l "$PG_LOG" -o "-p $PG_PORT" start
    sleep 2
    echo "✅ PostgreSQL started"
fi

# Create database if it doesn't exist
echo "📊 Creating database 'lct_dev'..."
createdb -h localhost -p $PG_PORT -U lct_user lct_dev 2>/dev/null && echo "✅ Database created" || echo "ℹ️  Database already exists"

echo ""

# Update .env file
echo "📝 Updating .env file..."
cat > lct_python_backend/.env << EOF
# Database Configuration (local PostgreSQL on port $PG_PORT)
DATABASE_URL=postgresql://lct_user:lct_password@localhost:$PG_PORT/lct_dev

# API Keys (add your keys here)
ANTHROPIC_API_KEY=your_anthropic_api_key_here
GOOGLEAI_API_KEY=your_google_ai_key_here
PERPLEXITY_API_KEY=your_perplexity_key_here
ASSEMBLYAI_API_KEY=your_assemblyai_key_here
ASSEMBLYAI_WS_URL=wss://api.assemblyai.com/v2/realtime/ws

# Google Cloud Storage (optional for local testing)
GCS_BUCKET_NAME=
GCS_FOLDER=

# Environment
ENVIRONMENT=development
DEBUG=true
LOG_LEVEL=INFO
EOF

echo "✅ .env file updated"
echo ""

# Run database migrations
echo "🔄 Running database migrations..."
cd lct_python_backend
export DATABASE_URL="postgresql://lct_user:lct_password@localhost:$PG_PORT/lct_dev"
../.venv/bin/python3 -m alembic upgrade head

if [ $? -eq 0 ]; then
    echo "✅ Database migrations completed successfully"
else
    echo "❌ Migration failed. Check the error above."
    exit 1
fi

cd ..

echo ""
echo "=============================================="
echo "✅ Local PostgreSQL setup complete!"
echo ""
echo "PostgreSQL is running on: localhost:$PG_PORT"
echo "Database: lct_dev"
echo "User: lct_user"
echo "Password: lct_password"
echo ""
echo "Next steps:"
echo "1. Add your API keys to lct_python_backend/.env"
echo "2. Run: ./start-backend-local.command"
echo ""
echo "To stop PostgreSQL: ./stop-postgres-local.command"
echo "To cleanup everything: rm -rf .postgres_data .postgres.log"
echo "=============================================="

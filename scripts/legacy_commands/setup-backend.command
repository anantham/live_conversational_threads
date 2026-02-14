#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"

echo "🚀 Live Conversational Threads - Backend Setup"
echo "=============================================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running. Please start Docker Desktop and try again."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Start PostgreSQL
echo "📦 Starting PostgreSQL container..."
docker-compose up -d postgres

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

# Check if PostgreSQL is healthy
if docker-compose ps postgres | grep -q "healthy"; then
    echo "✅ PostgreSQL is ready"
else
    echo "⏳ Still waiting for PostgreSQL..."
    sleep 5
fi

echo ""

# Update .env file with PostgreSQL connection
echo "📝 Updating .env file with PostgreSQL connection..."
cat > lct_python_backend/.env << EOF
# Database Configuration
DATABASE_URL=postgresql://lct_user:lct_password@localhost:5432/lct_dev

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
export DATABASE_URL="postgresql://lct_user:lct_password@localhost:5432/lct_dev"
../.venv/bin/python3 -m alembic upgrade head

if [ $? -eq 0 ]; then
    echo "✅ Database migrations completed successfully"
else
    echo "❌ Migration failed. Check the error above."
    exit 1
fi

echo ""
echo "=============================================="
echo "✅ Backend setup complete!"
echo ""
echo "Next steps:"
echo "1. Add your API keys to lct_python_backend/.env"
echo "2. Run: ./start-backend.command"
echo ""
echo "To stop PostgreSQL: docker-compose down"
echo "=============================================="

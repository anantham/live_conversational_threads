#!/bin/bash
cd "/Users/aditya/Documents/Ongoing Local/live_conversational_threads"
export DATABASE_URL="postgresql://lct_user:lct_password@localhost:5433/lct_dev"
export OPENROUTER_API_KEY=$(grep OPENROUTER_API_KEY lct_python_backend/.env | cut -d= -f2-)
.venv/bin/python3 -m uvicorn lct_python_backend.backend:lct_app --reload --port 8000

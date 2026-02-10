"""Shared environment configuration constants for the LCT backend."""
import os

# --- API Keys ---
PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
GOOGLEAI_API_KEY = os.getenv("GOOGLEAI_API_KEY")

# --- Google Cloud Storage ---
GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")
GCS_FOLDER = os.getenv("GCS_FOLDER")

# --- External API URLs ---
PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"

# --- Audio ---
AUDIO_RECORDINGS_DIR = os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings")
AUDIO_DOWNLOAD_TOKEN = os.getenv("AUDIO_DOWNLOAD_TOKEN", None)

os.makedirs(AUDIO_RECORDINGS_DIR, exist_ok=True)

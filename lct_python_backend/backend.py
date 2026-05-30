"""LCT Backend - FastAPI application shell.

All route handlers live in dedicated router modules.
This file handles: logging, app creation, CORS, middleware, and router mounting.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend directory before any other imports. override=True so
# LCT's .env wins when this backend is launched as a child of another
# supervisor (e.g. IndrasNet's start_all.py) whose own .env has already
# populated the parent process env. Without override, conflicting keys like
# DATABASE_URL or AUTH_TOKEN would silently inherit the supervisor's values.
load_dotenv(Path(__file__).parent / ".env", override=True)
import logging
from logging.handlers import RotatingFileHandler
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from lct_python_backend.db import db
from lct_python_backend.middleware import configure_p0_security
from lct_python_backend.services.env_helpers import env_str, env_str_or_none

# ============================================================================
# LOGGING CONFIGURATION - Persistent file-based logging
# ============================================================================
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Create logger
logger = logging.getLogger("lct_backend")
logger.setLevel(getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO))

# File handler - rotates at 10MB, keeps 5 backups
file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, "backend.log"),
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5,
    encoding='utf-8'
)
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(logging.Formatter(
    '%(asctime)s | %(levelname)-8s | %(name)s | %(funcName)s:%(lineno)d | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))

# Console handler for immediate visibility
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter(
    '%(asctime)s | %(levelname)-8s | %(message)s',
    datefmt='%H:%M:%S'
))

logger.addHandler(file_handler)
logger.addHandler(console_handler)

# Capture all lct_python_backend.* module logs (using __name__)
# This ensures import_api, services, etc. all go to the log file
lct_package_logger = logging.getLogger("lct_python_backend")
lct_package_logger.setLevel(logging.DEBUG)
lct_package_logger.addHandler(file_handler)
lct_package_logger.addHandler(console_handler)

# Also capture uvicorn logs
logging.getLogger("uvicorn").addHandler(file_handler)
logging.getLogger("uvicorn.access").addHandler(file_handler)

logger.info("=" * 60)
logger.info("LCT Backend Starting - Logging initialized")
logger.info(f"Log file: {os.path.join(LOG_DIR, 'backend.log')}")
logger.info("=" * 60)


# ============================================================================
# CORS CONFIGURATION
# ============================================================================

DEFAULT_FRONTEND_PORT = "43173"


def _default_local_cors_origins() -> list[str]:
    frontend_port = env_str("FRONTEND_PORT", DEFAULT_FRONTEND_PORT)
    compatibility_ports = ("5173", "5174", "5175", "5176", "5177")
    ports = [frontend_port, *[port for port in compatibility_ports if port != frontend_port]]

    origins: list[str] = []
    for host in ("localhost", "127.0.0.1"):
        for port in ports:
            origins.append(f"http://{host}:{port}")
    return origins


def _parse_csv_env(name: str) -> list[str]:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _resolve_cors_origins() -> tuple:
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    configured_origins = _parse_csv_env("CORS_ALLOW_ORIGINS")
    frontend_url = str(os.getenv("FRONTEND_URL", "")).strip()
    if frontend_url and frontend_url not in configured_origins:
        configured_origins.append(frontend_url)

    if configured_origins:
        origins = configured_origins
    elif environment == "production":
        origins = []
    else:
        origins = _default_local_cors_origins()

    allow_origin_regex = env_str_or_none("CORS_ALLOW_ORIGIN_REGEX")
    return origins, allow_origin_regex


# ============================================================================
# APPLICATION LIFECYCLE
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Connecting to database...")
    try:
        await db.connect()
        logger.info("Connected to database.")
    except Exception as e:
        logger.exception("Failed to connect to database during startup:")
        raise e

    # Provider model-availability audit per ADR-030 §D5 (Q2). Probes each
    # enabled provider's GET /v1/models and logs a warning when the
    # configured chat/embedding model isn't in the served catalogue —
    # makes silent substitution visible at boot rather than first call.
    # Audit failure must NEVER block startup; observability is best-effort.
    #
    # Loads providers from app_settings (with secrets) so DB-registered
    # entries like a runtime-added OpenAI provider are audited too —
    # not just env defaults.
    try:
        from lct_python_backend.db_session import get_async_session_context
        from lct_python_backend.services.llm_config import load_llm_providers
        from lct_python_backend.services.llm_gateway import (
            check_provider_models,
            log_provider_model_audit,
        )
        async with get_async_session_context() as audit_session:
            cfg = await load_llm_providers(audit_session, include_secrets=True)
        providers = cfg.get("providers") if isinstance(cfg, dict) else None
        reports = await check_provider_models(providers)
        log_provider_model_audit(reports)
    except Exception:  # noqa: BLE001
        logger.exception("[PROVIDER AUDIT] startup audit failed (non-fatal)")

    # Warm the IndrasNet contacts cache in the background so the participant
    # picker has data ready on first open. IndrasNet's /api/contacts is slow
    # (15s+, frequent timeouts) — never block startup or the picker on it.
    try:
        from lct_python_backend.consumption_prayer_api import warm_contacts_cache
        warm_contacts_cache()
        logger.info("[STARTUP] contacts-cache warm-up scheduled")
    except Exception:  # noqa: BLE001
        logger.exception("[STARTUP] contacts-cache warm-up failed to schedule (non-fatal)")

    yield
    logger.info("Disconnecting from database...")
    await db.disconnect()


# ============================================================================
# APP CREATION & MIDDLEWARE
# ============================================================================

lct_app = FastAPI(lifespan=lifespan)

cors_origins, cors_origin_regex = _resolve_cors_origins()

lct_app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info(
    "[SECURITY] CORS configured with origins=%s regex=%s",
    cors_origins,
    cors_origin_regex or "-",
)

# P0 Security middleware (auth, rate limits, body size limits, SSRF gate)
configure_p0_security(lct_app)


# ============================================================================
# ROUTER MOUNTING
# ============================================================================

from lct_python_backend.import_api import router as import_router
from lct_python_backend.bookmarks_api import router as bookmarks_router
from lct_python_backend.stt_api import router as stt_router
from lct_python_backend.llm_api import router as llm_router
from lct_python_backend.conversations_api import router as conversations_router
from lct_python_backend.generation_api import router as generation_router
from lct_python_backend.prompts_api import router as prompts_router
from lct_python_backend.edit_history_api import router as edit_history_router
from lct_python_backend.factcheck_api import router as factcheck_router
from lct_python_backend.analysis_api import router as analysis_router
from lct_python_backend.analytics_api import router as analytics_router
from lct_python_backend.graph_api import router as graph_router
from lct_python_backend.canvas_api import router as canvas_router
from lct_python_backend.thematic_api import router as thematic_router
from lct_python_backend.artifact_api import router as artifact_router
from lct_python_backend.speaker_naming_api import (
    router as voice_library_router,
    router_conversations as conversation_speakers_router,
)
from lct_python_backend.consumption_prayer_api import router as consumption_prayer_router
from lct_python_backend.user_identity_api import router as user_identity_router
from lct_python_backend.share_api import router as share_router
from lct_python_backend.backend_catalog_api import router as backend_catalog_router
from lct_python_backend.diarization_api import router as diarization_router

lct_app.include_router(import_router)
lct_app.include_router(bookmarks_router)
lct_app.include_router(stt_router)
lct_app.include_router(llm_router)
lct_app.include_router(conversations_router)
lct_app.include_router(generation_router)
lct_app.include_router(prompts_router)
lct_app.include_router(edit_history_router)
lct_app.include_router(factcheck_router)
lct_app.include_router(analysis_router)
lct_app.include_router(analytics_router)
lct_app.include_router(graph_router)
lct_app.include_router(canvas_router)
lct_app.include_router(thematic_router)
lct_app.include_router(artifact_router)
# voice_library_router has prefix /api (speaker-voice-library endpoints).
# conversation_speakers_router has prefix /api/conversations and exposes
# GET/PATCH /{id}/speakers — the NodeDetail panel's "speaker alias"
# lookup. Before this fix, only `router` was imported twice under two
# aliases and `router_conversations` was never mounted; every node-tap
# rendered a red "Not Found" speaker pill.
lct_app.include_router(voice_library_router)
lct_app.include_router(conversation_speakers_router)
lct_app.include_router(consumption_prayer_router)
lct_app.include_router(user_identity_router)
lct_app.include_router(share_router)
lct_app.include_router(backend_catalog_router)
lct_app.include_router(diarization_router)

# Alias for uvicorn compatibility
app = lct_app

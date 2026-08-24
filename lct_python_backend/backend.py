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

# Resolve LOG_LEVEL once and apply it to BOTH the app logger and the
# lct_python_backend.* package logger below. Previously the package logger was
# pinned to DEBUG unconditionally, which made LOG_LEVEL a no-op for every
# services/* module and forced verbose (potentially content-bearing) diagnostic
# logs into the file log regardless of the configured level. Honoring LOG_LEVEL
# keeps DEBUG diagnostics opt-in (AGENTS.md #9). Default INFO.
LOG_LEVEL = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)

# Create logger
logger = logging.getLogger("lct_backend")
logger.setLevel(LOG_LEVEL)

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
# This ensures import_api, services, etc. all go to the log file, at the
# configured LOG_LEVEL (set LOG_LEVEL=DEBUG to capture verbose diagnostics).
lct_package_logger = logging.getLogger("lct_python_backend")
lct_package_logger.setLevel(LOG_LEVEL)
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
    # Validate the retention/trust deployment boundary before accepting traffic.
    # Unknown profile names fail boot instead of silently choosing a weaker mode.
    from lct_python_backend.services.deployment_privacy_policy import current_deployment_profile
    deployment_profile = current_deployment_profile()
    logger.info("[DEPLOYMENT] privacy profile=%s", deployment_profile)

    # Install the network-layer egress chokepoint FIRST — before the provider
    # audit below (which itself probes cloud /v1/models). When LCT_LOCAL_ONLY
    # is on, every httpx/websocket/urllib call to a non-local host now
    # fail-closes regardless of per-site guards (ADR-034 egress chokepoint).
    try:
        from lct_python_backend.services.egress_chokepoint import (
            install_egress_chokepoint,
        )
        install_egress_chokepoint()
    except Exception:
        # The chokepoint is the only NETWORK-layer privacy guarantee. When
        # LCT_LOCAL_ONLY is on, a failed install is FATAL — refusing startup is
        # safer than running unguarded while believing we're local-only (codex
        # review 2026-06-17). When local-only is off (cloud/public profile), keep
        # the original non-fatal behavior.
        from lct_python_backend.services.egress_guard import local_only_enabled
        logger.exception("[egress-chokepoint] install failed")
        if local_only_enabled():
            raise

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

# Disable interactive API docs + schema in production (defense-in-depth; they are
# already behind the auth middleware unless AUTH_TOKEN is unset).
_ENVIRONMENT = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
_docs_enabled = _ENVIRONMENT != "production"

# Canonical-python guard at IMPORT time — runs when uvicorn imports this module,
# BEFORE the app is constructed and before uvicorn binds the socket. The lifespan
# runs AFTER bind, so an enforced guard there would let a wrong-env process briefly
# become a "healthy" listener and then die (the exact bind-then-die symptom we're
# killing). Here, under LCT_REQUIRE_CANONICAL_PYTHON a wrong-env process fails fast
# before listening. WARN-by-default otherwise. (codex/grok ADR-040 review.)
from lct_python_backend.version_info import check_canonical_python  # noqa: E402
check_canonical_python()

lct_app = FastAPI(
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

cors_origins, cors_origin_regex = _resolve_cors_origins()

# P0 Security middleware (auth, rate limits, body size limits, SSRF gate)
configure_p0_security(lct_app)

# CORS is added LAST so it is the OUTERMOST middleware. add_middleware prepends, so
# the final add wraps everything else — load-bearing: it ensures responses that
# short-circuit INSIDE the security stack (a 401 from AuthMiddleware, a 429 from the
# rate limiter, a 413 from the body-size guard) still carry Access-Control-Allow-Origin.
# Otherwise the browser blocks the header-less reject and reports a misleading
# "CORS / backend unreachable" instead of the real status (ISSUES.md: auth-reject CORS
# masking). See tests/unit/test_cors_on_error.py.
lct_app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info(
    "[SECURITY] CORS configured (outermost) with origins=%s regex=%s",
    cors_origins,
    cors_origin_regex or "-",
)

# Production hardening (previously defined in security_config but never wired —
# surface-tech-debt review 2026-05-30). Safe in development: the benign response
# headers (X-Frame-Options/X-Content-Type-Options/X-XSS-Protection) apply always;
# CSP + HSTS only when ENVIRONMENT=production; TrustedHost is a no-op unless a prod
# host allowlist is configured.
from lct_python_backend.security_config import add_security_headers, configure_trusted_hosts

lct_app.middleware("http")(add_security_headers)
configure_trusted_hosts(lct_app, environment=os.getenv("ENVIRONMENT", "development"))


# ============================================================================
# ROUTER MOUNTING
# ============================================================================

from lct_python_backend.import_api import router as import_router
from lct_python_backend.version_api import router as version_router
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
from lct_python_backend.artifact_api import router as artifact_router
from lct_python_backend.speaker_naming_api import (
    router as voice_library_router,
    router_conversations as conversation_speakers_router,
)
from lct_python_backend.consumption_prayer_api import router as consumption_prayer_router
from lct_python_backend.user_identity_api import router as user_identity_router
from lct_python_backend.share_api import router as share_router
from lct_python_backend.subject_review_api import router as subject_review_router
from lct_python_backend.backend_catalog_api import router as backend_catalog_router
from lct_python_backend.diarization_api import router as diarization_router
from lct_python_backend.attendee_api import (
    router as attendee_router,
    ws_router as attendee_ws_router,
)
from lct_python_backend.reprocess_api import router as reprocess_router
from lct_python_backend.revisions_api import router as revisions_router

lct_app.include_router(import_router)
lct_app.include_router(version_router)
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
lct_app.include_router(subject_review_router)
lct_app.include_router(backend_catalog_router)
lct_app.include_router(diarization_router)
# Attendee meeting-bot integration: join a Meet link, stream transcripts into
# the live-graph pipeline. attendee_ws_router carries /ws/meeting/{id} (viewer).
lct_app.include_router(attendee_router)
lct_app.include_router(attendee_ws_router)
lct_app.include_router(reprocess_router)
lct_app.include_router(revisions_router)

# Alias for uvicorn compatibility
app = lct_app

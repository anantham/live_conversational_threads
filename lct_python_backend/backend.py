"""LCT Backend - FastAPI application shell.

All route handlers live in dedicated router modules.
This file handles: logging, app creation, CORS, middleware, and router mounting.
"""
import os
import logging
from logging.handlers import RotatingFileHandler
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from lct_python_backend.db import db
from lct_python_backend.middleware import configure_p0_security

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

# Also capture uvicorn logs
logging.getLogger("uvicorn").addHandler(file_handler)
logging.getLogger("uvicorn.access").addHandler(file_handler)

logger.info("=" * 60)
logger.info("LCT Backend Starting - Logging initialized")
logger.info(f"Log file: {os.path.join(LOG_DIR, 'backend.log')}")
logger.info("=" * 60)


# ============================================================================
# APPLICATION LIFECYCLE
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[INFO] Connecting to database...")
    try:
        await db.connect()
        print("[INFO] Connected to database.")
    except Exception as e:
        print("[ERROR] Failed to connect to database during startup:")
        import traceback
        traceback.print_exc()
        raise e
    yield
    print("[INFO] Disconnecting from database...")
    await db.disconnect()


# ============================================================================
# APP CREATION & MIDDLEWARE
# ============================================================================

lct_app = FastAPI(lifespan=lifespan)

lct_app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:5176",
        "http://localhost:5177",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
        "http://127.0.0.1:5176",
        "http://127.0.0.1:5177",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

"""
SQLAlchemy async session setup for Live Conversational Threads.

The engine and session factory are created LAZILY (on first use), not at
import time. Importing this module must never require DATABASE_URL: the
previous import-time `create_async_engine(...)` crashed any import in an
environment without the env var, which pushed unit tests into replacing this
module with `sys.modules` stubs — and those stubs leaked across the whole
pytest collection, killing unrelated test files (see tests/unit history
around 2026-06-30).
"""

import os
import threading

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_engine = None
_sessionmaker = None
# First DB use can happen from threads (TestClient portals, background
# workers), not just the event loop — a bare check-then-set could create two
# engines and leak a pool (dual-review finding, PR #147).
_init_lock = threading.Lock()


def _database_url():
    """Read DATABASE_URL at call time (not import time).

    NOTE: the engine pins whatever URL this returns at FIRST use; mutating the
    env var afterwards changes this function's return but not the live engine.
    """
    url = os.getenv("DATABASE_URL")

    # Convert postgres:// to postgresql+asyncpg:// for SQLAlchemy async
    if url and url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

    return url


def get_engine():
    """Create (once) and return the async engine."""
    global _engine
    if _engine is None:
        with _init_lock:
            if _engine is None:
                _engine = create_async_engine(
                    _database_url(),
                    echo=False,
                    future=True,
                    # Native Windows postgres on localhost:5432 (migrated from WSL on 5433
                    # which had constant networking-bridge failures). SSL not needed for
                    # loopback; setting ssl=False keeps asyncpg from trying the broken
                    # negotiation path on Windows proactor loop.
                    connect_args={"ssl": False},
                )
                from lct_python_backend.telemetry import (
                    instrument_sqlalchemy_engine,
                )

                instrument_sqlalchemy_engine(_engine)
    return _engine


def get_sessionmaker():
    """Create (once) and return the async session factory."""
    global _sessionmaker
    if _sessionmaker is None:
        # Build OUTSIDE the lock: get_engine() takes the same non-reentrant
        # lock, so hoisting this inside would deadlock. A losing racer just
        # discards its (pool-less, cheap) maker.
        maker = async_sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
        with _init_lock:
            if _sessionmaker is None:
                _sessionmaker = maker
    return _sessionmaker


def __getattr__(name):
    """Back-compat module attributes (PEP 562), resolved lazily.

    `async_engine` and `AsyncSessionLocal` were module-level globals before the
    lazy refactor; keep them importable without re-triggering eager creation.
    """
    if name == "async_engine":
        return get_engine()
    if name == "AsyncSessionLocal":
        return get_sessionmaker()
    if name == "DATABASE_URL":
        return _database_url()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    """Include the PEP 562 back-compat names in introspection."""
    return sorted(list(globals().keys()) + ["async_engine", "AsyncSessionLocal", "DATABASE_URL"])


async def get_async_session():
    """
    Dependency function to get database session.

    Usage in FastAPI endpoints:
        @router.post("/endpoint")
        async def my_endpoint(db: AsyncSession = Depends(get_async_session)):
            ...
    """
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def get_async_session_context():
    """
    Context manager for getting database session in background tasks.

    Usage in background tasks:
        async with get_async_session_context() as db:
            # Use db session
            ...
    """
    return get_sessionmaker()()

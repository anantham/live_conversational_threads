"""Relational persistence adapter for ADR-064 LLM call facts."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from lct_python_backend.services.llm_call_facts import (
    LLMCallFactEvent,
    LLMCallFactStore,
)

logger = logging.getLogger("lct_backend")

_engine = None
_engine_url = None
_engine_lock = threading.Lock()


def _sync_database_url() -> str:
    url = str(os.getenv("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    if url.startswith("postgresql+asyncpg://"):
        return url.replace("postgresql+asyncpg://", "postgresql+psycopg2://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg2://", 1)
    return url


def _get_engine():
    global _engine, _engine_url
    url = _sync_database_url()
    if _engine is None or _engine_url != url:
        with _engine_lock:
            if _engine is None or _engine_url != url:
                kwargs = {"pool_pre_ping": True, "future": True}
                if url.startswith("postgresql+"):
                    kwargs["connect_args"] = {
                        "connect_timeout": 2,
                        "options": "-c statement_timeout=2000",
                    }
                _engine = create_engine(url, **kwargs)
                _engine_url = url
    return _engine


class DatabaseLLMCallFactStore:
    """Append facts to the application database without retaining content."""

    def record_sync(self, event: LLMCallFactEvent) -> bool:
        try:
            from lct_python_backend.models import LLMCallFact

            with Session(_get_engine()) as session:
                session.add(LLMCallFact(**event.model_values()))
                session.commit()
            return True
        except Exception as exc:  # noqa: BLE001 - telemetry cannot break inference
            logger.warning(
                "[LLM FACTS] persistence unavailable code=fact_store_write_failed type=%s",
                type(exc).__name__,
            )
            return False

    async def record_async(self, event: LLMCallFactEvent) -> bool:
        return await asyncio.to_thread(self.record_sync, event)


_DEFAULT_STORE: Optional[DatabaseLLMCallFactStore] = None


def default_llm_call_fact_store() -> LLMCallFactStore:
    global _DEFAULT_STORE
    if _DEFAULT_STORE is None:
        _DEFAULT_STORE = DatabaseLLMCallFactStore()
    return _DEFAULT_STORE


__all__ = ["DatabaseLLMCallFactStore", "default_llm_call_fact_store"]

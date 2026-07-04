"""Gated request-stage timing helpers for falsifying backend latency hypotheses."""

from __future__ import annotations

import os
import time
from typing import Awaitable, Callable, Optional, TypeVar

from fastapi import Request

T = TypeVar("T")


DEFAULT_DIAGNOSTIC_PATHS = (
    "/api/import/health",
    "/api/backend-catalog",
    "/api/backend-catalog/probe",
    "/api/settings/llm",
    "/api/settings/llm/providers",
    "/api/settings/llm/providers/health",
    "/api/settings/stt",
    "/api/settings/stt/health-check",
)


def _env_flag(name: str) -> bool:
    value = (os.getenv(name) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def route_diagnostics_enabled() -> bool:
    return _env_flag("LCT_ROUTE_DIAGNOSTICS")


def diagnostic_paths() -> set[str]:
    raw = os.getenv("LCT_ROUTE_DIAGNOSTIC_PATHS", "")
    if not raw.strip():
        return set(DEFAULT_DIAGNOSTIC_PATHS)
    return {part.strip() for part in raw.split(",") if part.strip()}


def should_diagnose_path(path: str) -> bool:
    return route_diagnostics_enabled() and path in diagnostic_paths()


def record_stage(request: Optional[Request], name: str, elapsed_ms: float) -> None:
    """Append a sanitized stage duration to request.state.server_timings."""
    if request is None or not route_diagnostics_enabled():
        return
    stages = getattr(request.state, "server_timings", None)
    if stages is None:
        request.state.server_timings = []
        stages = request.state.server_timings
    stages.append((name, elapsed_ms))


async def timed_async_stage(
    request: Optional[Request],
    name: str,
    func: Callable[[], Awaitable[T]],
) -> T:
    start = time.perf_counter()
    try:
        return await func()
    finally:
        record_stage(request, name, (time.perf_counter() - start) * 1000.0)


def timed_sync_stage(
    request: Optional[Request],
    name: str,
    func: Callable[[], T],
) -> T:
    start = time.perf_counter()
    try:
        return func()
    finally:
        record_stage(request, name, (time.perf_counter() - start) * 1000.0)

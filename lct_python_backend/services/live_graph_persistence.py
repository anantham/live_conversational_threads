"""Backend-owned persistence helpers for live semantic graph state."""

import copy
import logging
import time
from typing import Any, Dict, List, Optional

from lct_python_backend.db_session import get_async_session_context
from lct_python_backend.services.import_persistence import persist_import_graph

logger = logging.getLogger("lct_backend")


def extract_conversation_name(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    """Best-effort conversation name from session metadata."""
    if not isinstance(metadata, dict):
        return None

    candidate = str(
        metadata.get("conversation_name")
        or metadata.get("file_name")
        or metadata.get("title")
        or ""
    ).strip()
    return candidate or None


async def persist_live_graph_snapshot(
    *,
    conversation_id: str,
    existing_json: List[Dict[str, Any]],
    metadata: Optional[Dict[str, Any]] = None,
    source_type: str = "live_audio",
) -> int:
    """Persist the current best semantic graph for a live conversation.

    This is intentionally backend-owned so headless replays and live websocket
    sessions produce durable graph state even when no browser autosave fires.
    """
    normalized_nodes = [
        copy.deepcopy(node)
        for node in (existing_json or [])
        if isinstance(node, dict)
    ]
    if not conversation_id or not normalized_nodes:
        return 0

    started_at = time.perf_counter()
    async with get_async_session_context() as db:
        persisted = await persist_import_graph(
            db=db,
            conversation_id=conversation_id,
            existing_json=normalized_nodes,
            conversation_name=extract_conversation_name(metadata),
            source_type=source_type,
            source_metadata=metadata or {},
        )
    logger.info(
        "[GRAPH PERSIST] conversation=%s nodes=%s source_type=%s latency_ms=%.2f",
        conversation_id,
        persisted,
        source_type,
        max(0.0, (time.perf_counter() - started_at) * 1000.0),
    )
    return persisted

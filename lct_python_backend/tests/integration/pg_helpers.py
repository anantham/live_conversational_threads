"""Shared helpers for real-Postgres integration tests.

These tests do NOT use pytest-asyncio (none is installed). Each test is a plain
sync function that drives a coroutine via ``asyncio.run``; the helpers here
remove the per-file engine/cleanup boilerplate that was copy-pasted across the
existing ``*_pg.py`` files.

ISOLATION NOTE: ``persist_graph`` / ``persist_turns`` call ``db.commit()``
internally, so the textbook "wrap each test in a transaction and roll back"
pattern is impossible — the function under test commits before the test could
roll back. The model here is the proven one: commit real rows, then
cascade-delete them by conversation_id in a ``finally`` (FK ``ON DELETE
CASCADE`` cleans Node/Relationship/Utterance children). Conversations are tagged
with an ``ITEST-<uuid>`` owner so a stray row is identifiable.

Skip-gating: import ``REQUIRES_DB`` and set it as the module ``pytestmark`` so the
whole file is skipped when ``DATABASE_URL`` is unset (e.g. on a machine without a
dev DB). In CI the DB is present, so the tests actually run.
"""

import os
import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

DATABASE_URL = os.getenv("DATABASE_URL")

# Set this as `pytestmark` at module level in each _pg test file.
REQUIRES_DB = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def async_url(url: str) -> str:
    """Rewrite a sync Postgres URL to the asyncpg driver (idempotent)."""
    if url.startswith("postgresql+asyncpg://"):
        return url
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


def unique_owner(prefix: str = "ITEST") -> str:
    """A per-test owner id that the cleanup pass can target unambiguously."""
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


@asynccontextmanager
async def pg_session():
    """Yield an AsyncSession against DATABASE_URL, disposing the engine on exit.

    ``connect_args={"ssl": False}`` mirrors db_session.py — required for the
    Windows proactor event loop. ``expire_on_commit=False`` so rows stay readable
    after the function-under-test commits.
    """
    engine = create_async_engine(async_url(DATABASE_URL), connect_args={"ssl": False})
    session = AsyncSession(engine, expire_on_commit=False)
    try:
        yield session
    finally:
        await session.close()
        await engine.dispose()


async def cleanup_conversations(session: AsyncSession, conv_ids) -> None:
    """Cascade-delete the given conversation ids (children drop via FK CASCADE).

    Rolls back first: a function-under-test that raised may have left the session
    in a failed-transaction state, which would make the cleanup deletes error.
    The tests' real writes are already committed by persist_graph/persist_turns,
    so a rollback here only discards a failed/pending state, never real data.
    """
    from lct_python_backend.models import Conversation

    await session.rollback()
    for cid in conv_ids:
        cuid = cid if isinstance(cid, uuid.UUID) else uuid.UUID(str(cid))
        await session.execute(delete(Conversation).where(Conversation.id == cuid))
    await session.commit()


async def read_graph(session: AsyncSession, conv_id):
    """Return (nodes, rels, utts) for a conversation via the canonical reader."""
    from lct_python_backend.services.conversation_reader import fetch_conversation_bundle

    cuid = conv_id if isinstance(conv_id, uuid.UUID) else uuid.UUID(str(conv_id))
    _, nodes, rels, utts = await fetch_conversation_bundle(session, cuid)
    return nodes, rels, utts


def node(name, *, node_id=None, summary=None, chunk_id=None, edges_out=None, **extra):
    """Build one existing_json node dict.

    ``edges_out`` is the faithful (lossless) relationship form persist_graph
    prefers: a list of ``{"to": <node_id_str>, "relationship_type": ..., ...}``.
    """
    row = {
        "id": node_id or str(uuid.uuid4()),
        "node_name": name,
        "summary": summary if summary is not None else name.lower(),
    }
    if chunk_id is not None:
        row["chunk_id"] = chunk_id
    if edges_out is not None:
        row["edges_out"] = edges_out
    row.update(extra)
    return row


def edge_out(to_node_id, *, relationship_type="contextual", strength=0.8,
             confidence=0.9, subtype=None, explanation="rel", bidirectional=False,
             rel_id=None):
    """Build one edges_out entry (the faithful relationship form)."""
    e = {
        "to": str(to_node_id),
        "relationship_type": relationship_type,
        "strength": strength,
        "confidence": confidence,
        "explanation": explanation,
        "is_bidirectional": bidirectional,
    }
    if subtype is not None:
        e["relationship_subtype"] = subtype
    if rel_id is not None:
        e["id"] = str(rel_id)
    return e

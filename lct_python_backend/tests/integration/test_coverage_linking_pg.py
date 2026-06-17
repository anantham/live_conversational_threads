"""P1.5 integration test: import-style graph persistence links leaf nodes to
their utterances so build_coverage_summary is REAL (non-null), against Postgres.

Reproduces the import situation: persist_graph is called with utterances that
carry a `chunk_id` (the import stitch) + a stable `id`, and NO explicit
`utterance_chunk_map` (only the live processor passes one). The fix derives the
chunk→utterance map from the utterances themselves, so leaf nodes get
utterance_ids and coverage is auditable. Skipped unless DATABASE_URL is set;
creates + cascade-cleans its own conversation.
"""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def _async_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg://"):
        return url
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


async def _engine_session():
    engine = create_async_engine(_async_url(DATABASE_URL), connect_args={"ssl": False})
    return engine, AsyncSession(engine, expire_on_commit=False)


def test_import_style_persist_makes_coverage_real():
    from lct_python_backend.models import Conversation
    from lct_python_backend.services.conversation_reader import (
        build_coverage_summary,
        build_graph_data_from_nodes,
        fetch_conversation_bundle,
    )
    from lct_python_backend.services.graph_persistence import (
        ensure_conversation_row,
        persist_graph,
    )

    conv_id = str(uuid.uuid4())
    chunk_a, chunk_b = str(uuid.uuid4()), str(uuid.uuid4())

    def _utt(seq, chunk):
        return {
            "id": str(uuid.uuid4()),
            "text": f"utterance number {seq}",
            "speaker_id": f"S{seq % 2}",
            "sequence_number": seq,
            "chunk_id": chunk,
        }

    # 4 utterances, 2 per chunk; each carries id + chunk_id (the import stitch).
    utterances = [_utt(1, chunk_a), _utt(2, chunk_a), _utt(3, chunk_b), _utt(4, chunk_b)]
    # 2 leaf nodes, one per chunk, NO authored utterance_ids (the LLM doesn't emit them).
    existing_json = [
        {"id": str(uuid.uuid4()), "node_name": "Node A", "summary": "a", "chunk_id": chunk_a},
        {"id": str(uuid.uuid4()), "node_name": "Node B", "summary": "b", "chunk_id": chunk_b},
    ]

    async def scenario():
        engine, session = await _engine_session()
        try:
            await ensure_conversation_row(
                db=session, conversation_id=conv_id, conversation_name="P1.5 coverage test",
                source_type="text", owner_id="usr_aditya",
            )
            # Pass NO utterance_chunk_map — exactly the import path's situation.
            await persist_graph(
                db=session, conversation_id=conv_id, existing_json=existing_json,
                utterances=utterances, conversation_name="P1.5 coverage test",
                source_type="text", owner_id="usr_aditya",
            )

            _, nodes, rels, utts = await fetch_conversation_bundle(session, uuid.UUID(conv_id))
            # Each leaf node now carries its 2 utterance_ids (was empty before the fix).
            assert all(len(n.utterance_ids or []) == 2 for n in nodes), [
                (n.node_name, n.utterance_ids) for n in nodes
            ]
            graph_data = build_graph_data_from_nodes(nodes, rels, utts)
            summary = build_coverage_summary(graph_data, utts)
            assert summary["auditable"] is True
            assert summary["total_turns"] == 4
            assert summary["covered_turns"] == 4
            assert summary["pct"] == 100.0
        finally:
            await session.execute(delete(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
            await session.commit()
            await session.close()
            await engine.dispose()

    asyncio.run(scenario())

"""ADR-059 PR-1 — end-to-end integration: the import persist helper routes the graph
write through the ConversationPipeline spine (PersistStage) to the REAL persist_graph
against Postgres. Proves the first production pipeline call site actually materializes
nodes, not just that the mocked contract holds.
"""

import asyncio
import uuid

from .pg_helpers import (
    REQUIRES_DB,
    cleanup_conversations,
    node,
    pg_session,
    read_graph,
    unique_owner,
)

pytestmark = REQUIRES_DB


def test_persist_via_pipeline_materializes_graph_to_db():
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        from lct_python_backend.services.graph_persistence import ensure_conversation_row
        from lct_python_backend.services.import_pipeline.import_bulk_persistence import (
            _persist_graph_via_pipeline,
        )

        async with pg_session() as session:
            try:
                await ensure_conversation_row(
                    db=session,
                    conversation_id=conv_id,
                    conversation_name="ITEST pipeline persist",
                    source_type="text",
                    owner_id=owner,
                )
                nodes = [node("A"), node("B")]
                count = await _persist_graph_via_pipeline(
                    db=session,
                    conversation_id=conv_id,
                    existing_json=nodes,
                    utterances=[],
                    conversation_name="ITEST pipeline persist",
                    source_type="text",
                    source_metadata={},
                )
                names = {n.node_name for n in (await read_graph(session, conv_id))[0]}
                return count, names
            finally:
                await cleanup_conversations(session, [conv_id])

    count, names = asyncio.run(scenario())
    assert count == 2          # PersistStage → adapter → persist_graph returned the node count
    assert names == {"A", "B"}  # the graph really landed in Postgres

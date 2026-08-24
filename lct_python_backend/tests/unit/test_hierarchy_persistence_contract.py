"""Cross-boundary regression for hierarchy sync followed by graph persistence.

Test Intent:
- A legacy-authored graph remains in the legacy persistence representation.
- Canonical many-to-many membership, temporal flow, and argument semantics all
  survive the same synchronize-then-persist operation.
- The test observes emitted Relationship rows through the public persistence
  function rather than asserting private helper calls.
"""

import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault(
    "DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev"
)

from lct_python_backend.models import Relationship
from lct_python_backend.services.graph_persistence import persist_import_graph
from lct_python_backend.services.import_pipeline.hierarchy_integrity import (
    synchronize_hierarchy,
)


@pytest.mark.asyncio
async def test_legacy_hierarchy_persists_membership_temporal_and_semantic_edges():
    chunk_a = str(uuid.uuid4())
    chunk_b = str(uuid.uuid4())
    idea = str(uuid.uuid4())
    nodes = [
        {
            "id": chunk_a,
            "node_name": "Evidence A",
            "summary": "First chunk",
            "semantic_level": 1,
            "chunk_id": "batch-a",
            "successor": "Evidence B",
        },
        {
            "id": chunk_b,
            "node_name": "Evidence B",
            "summary": "Second chunk",
            "semantic_level": 1,
            "chunk_id": "batch-a",
            "predecessor": "Evidence A",
            "edge_relations": [
                {
                    "related_node": "Evidence A",
                    "relation_type": "supports",
                    "relation_text": "The first chunk supports the second.",
                }
            ],
        },
        {
            "id": idea,
            "node_name": "Shared idea",
            "summary": "Both chunks form one idea.",
            "semantic_level": 2,
            "chunk_id": "batch-a",
            "children_ids": [chunk_a, chunk_b],
        },
    ]
    synchronize_hierarchy(nodes, through_parent_level=2)

    conversation = MagicMock()
    conversation.source_metadata = {}
    db = MagicMock()
    db.add = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = conversation
    db.execute.return_value = result

    await persist_import_graph(
        db=db,
        conversation_id=str(uuid.uuid4()),
        existing_json=nodes,
    )

    relationships = [
        call.args[0]
        for call in db.add.call_args_list
        if isinstance(call.args[0], Relationship)
    ]
    relationship_types = [row.relationship_type for row in relationships]
    assert relationship_types.count("member_of") == 2
    assert relationship_types.count("temporal") == 1
    assert relationship_types.count("supports") == 1

"""Unit tests for persist_import_graph in import_persistence.py."""

import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev")

from lct_python_backend.services.import_persistence import persist_import_graph


CONVERSATION_ID = str(uuid.uuid4())

SAMPLE_NODES = [
    {
        "node_name": "Alpha",
        "summary": "First topic",
        "successor": "Beta",
        "predecessor": None,
        "contextual_relation": {"Gamma": "Alpha introduces Gamma's context"},
        "is_bookmark": False,
        "is_contextual_progress": False,
        "chunk_id": "chunk_001",
    },
    {
        "node_name": "Beta",
        "summary": "Second topic",
        "successor": None,
        "predecessor": "Alpha",
        "contextual_relation": {},
        "is_bookmark": True,
        "is_contextual_progress": False,
        "chunk_id": "chunk_002",
    },
    {
        "node_name": "Gamma",
        "summary": "Third topic",
        "successor": None,
        "predecessor": None,
        "contextual_relation": {},
        "is_bookmark": False,
        "is_contextual_progress": True,
        "chunk_id": "chunk_003",
    },
]


def _make_db_mock(conv=None):
    """Build an AsyncMock db session."""
    db = MagicMock()
    db.add = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()

    # Simulate scalar_one_or_none returning the provided conv object
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = conv
    db.execute.return_value = result_mock
    return db


@pytest.mark.asyncio
async def test_persist_import_graph_returns_node_count():
    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    count = await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    assert count == 3


@pytest.mark.asyncio
async def test_persist_import_graph_adds_correct_node_types():
    from lct_python_backend.models import Node

    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    nodes = [o for o in added_objects if isinstance(o, Node)]

    assert len(nodes) == 3
    node_types = {n.node_name: n.node_type for n in nodes}
    assert node_types["Alpha"] == "conversational_thread"
    assert node_types["Beta"] == "bookmark"
    assert node_types["Gamma"] == "contextual_progress"
    bookmark_flags = {n.node_name: bool(n.is_bookmark) for n in nodes}
    contextual_flags = {n.node_name: bool(n.is_contextual_progress) for n in nodes}
    assert bookmark_flags["Alpha"] is False
    assert bookmark_flags["Beta"] is True
    assert bookmark_flags["Gamma"] is False
    assert contextual_flags["Alpha"] is False
    assert contextual_flags["Beta"] is False
    assert contextual_flags["Gamma"] is True
    # All imported nodes are level 1 (individual conversation nodes, per ADR-002)
    assert all(n.level == 1 for n in nodes)
    assert all(n.zoom_level_visible == [1, 2, 3] for n in nodes)


@pytest.mark.asyncio
async def test_persist_import_graph_creates_temporal_relationship():
    from lct_python_backend.models import Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    rels = [o for o in added_objects if isinstance(o, Relationship)]
    temporal_rels = [r for r in rels if r.relationship_type == "temporal"]

    # Alpha → Beta (successor link)
    assert len(temporal_rels) == 1
    assert temporal_rels[0].explanation == "Sequential conversation flow"


@pytest.mark.asyncio
async def test_persist_import_graph_creates_contextual_relationship():
    from lct_python_backend.models import Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    rels = [o for o in added_objects if isinstance(o, Relationship)]
    contextual_rels = [r for r in rels if r.relationship_type == "contextual"]

    # Alpha → Gamma (contextual_relation entry)
    assert len(contextual_rels) == 1
    assert contextual_rels[0].explanation == "Alpha introduces Gamma's context"


@pytest.mark.asyncio
async def test_persist_import_graph_handles_non_dict_contextual_relation_variants():
    from lct_python_backend.models import Node, Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)
    nodes_with_variants = [
        {
            "node_name": "Alpha",
            "summary": "First topic",
            "successor": None,
            "predecessor": None,
            "contextual_relation": [
                {
                    "related_node_name": "Gamma",
                    "relation_text": "Alpha references Gamma from list object",
                }
            ],
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": "chunk_001",
        },
        {
            "node_name": "Beta",
            "summary": "Second topic",
            "successor": None,
            "predecessor": None,
            "contextual_relation": {
                "related_node_name": "Gamma",
                "relation_text": "Beta references Gamma from single object",
            },
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": "chunk_002",
        },
        {
            "node_name": "Gamma",
            "summary": "Third topic",
            "successor": None,
            "predecessor": None,
            "contextual_relation": "not-a-dict",
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": "chunk_003",
        },
    ]

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=nodes_with_variants,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    nodes = [o for o in added_objects if isinstance(o, Node)]
    rels = [o for o in added_objects if isinstance(o, Relationship)]
    contextual_rels = [r for r in rels if r.relationship_type == "contextual"]

    node_name_by_id = {node.id: node.node_name for node in nodes}
    contextual_edges = {
        (
            node_name_by_id.get(rel.from_node_id),
            node_name_by_id.get(rel.to_node_id),
            rel.explanation,
        )
        for rel in contextual_rels
    }

    assert len(contextual_rels) == 2
    assert contextual_edges == {
        ("Alpha", "Gamma", "Alpha references Gamma from list object"),
        ("Beta", "Gamma", "Beta references Gamma from single object"),
    }


@pytest.mark.asyncio
async def test_persist_import_graph_updates_conversation_total_nodes():
    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    assert conv.total_nodes == 3


@pytest.mark.asyncio
async def test_persist_import_graph_creates_missing_conversation_row():
    from lct_python_backend.models import Conversation

    db = _make_db_mock(conv=None)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
        conversation_name="Uploaded notes",
        source_type="audio",
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    conversations = [o for o in added_objects if isinstance(o, Conversation)]
    assert len(conversations) == 1
    assert conversations[0].conversation_name == "Uploaded notes"
    assert conversations[0].source_type == "audio"
    db.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_persist_import_graph_returns_zero_for_empty_input():
    db = _make_db_mock()

    count = await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=[],
    )

    assert count == 0
    db.add.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_persist_import_graph_idempotent_deletes_stale_rows():
    """Calling twice deletes rows both times before inserting."""
    from lct_python_backend.models import Node, Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    # First call
    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    # Reset and call again (simulates re-run)
    db.execute.reset_mock()
    db.add.reset_mock()
    db.commit.reset_mock()
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = conv
    db.execute.return_value = result_mock

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
    )

    # execute called at least twice for the two deletes + once for conv select
    assert db.execute.call_count >= 3
    db.commit.assert_awaited_once()

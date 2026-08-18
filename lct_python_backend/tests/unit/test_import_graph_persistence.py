"""Unit tests for persist_import_graph in import_persistence.py."""

import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev")

from lct_python_backend.models import Utterance as DBUtterance
from lct_python_backend.services.graph_persistence import persist_import_graph


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

SAMPLE_UTTERANCES = [
    {
        "text": "I should go to the monastery.",
        "speaker_id": "SPEAKER_00",
        "sequence_number": 1,
        "timestamp_start": 0.0,
        "timestamp_end": 2.0,
    },
    {
        "text": "What about the visa timeline?",
        "speaker_id": "SPEAKER_01",
        "sequence_number": 2,
        "timestamp_start": 2.1,
        "timestamp_end": 4.0,
        "speaker_source": "diarization",
        "speaker_confidence": 0.95,
    },
]

STABLE_ID_ALPHA = str(uuid.uuid4())
STABLE_ID_BETA = str(uuid.uuid4())


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
async def test_graph_enrichment_preserves_existing_privacy_metadata():
    conv = MagicMock()
    conv.source_metadata = {
        "privacy": {"external_llm_ok": False, "local_llm_ok": True},
        "contract_version": "1",
    }
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
        source_metadata={"executive_summary": "A graph summary"},
    )

    assert conv.source_metadata == {
        "privacy": {"external_llm_ok": False, "local_llm_ok": True},
        "contract_version": "1",
        "executive_summary": "A graph summary",
    }


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
    # ADR-030 §P5: persistence honours LLM-authored semantic_level. The
    # SAMPLE_NODES fixture doesn't set semantic_level, so all default to 1
    # (chunk). zoom_level_visible mirrors the assigned level (one entry per
    # node, not the legacy [1, 2, 3] multi-level visibility).
    assert all(n.level == 1 for n in nodes)
    assert all(n.zoom_level_visible == [1] for n in nodes)


@pytest.mark.asyncio
async def test_persist_import_graph_honours_authored_semantic_level():
    """Regression test for the 'authored hierarchy lost on persistence'
    bug: nodes with semantic_level set should land in the DB with that
    level instead of the previous hardcoded 1."""
    from lct_python_backend.models import Node

    authored = [
        {"id": "a1", "node_name": "Chunk", "summary": "s", "semantic_level": 1},
        {"id": "a2", "node_name": "Idea", "summary": "s", "semantic_level": 2},
        {"id": "a3", "node_name": "Topic", "summary": "s", "semantic_level": 3},
        {"id": "a4", "node_name": "Theme", "summary": "s", "semantic_level": 4},
        {"id": "a5", "node_name": "Arc", "summary": "s", "semantic_level": 5},
    ]
    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=authored,
    )

    nodes = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Node)]
    by_name = {n.node_name: n for n in nodes}
    assert by_name["Chunk"].level == 1
    assert by_name["Idea"].level == 2
    assert by_name["Topic"].level == 3
    assert by_name["Theme"].level == 4
    assert by_name["Arc"].level == 5
    # zoom_level_visible matches the authored level per ADR-021/030.
    assert by_name["Idea"].zoom_level_visible == [2]
    assert by_name["Arc"].zoom_level_visible == [5]


@pytest.mark.asyncio
async def test_persist_import_graph_clamps_authored_level_to_valid_range():
    """Authored levels outside [1, 5] are clamped, not propagated."""
    from lct_python_backend.models import Node

    out_of_range = [
        {"id": "lo", "node_name": "Below", "summary": "s", "semantic_level": 0},
        {"id": "hi", "node_name": "Above", "summary": "s", "semantic_level": 99},
        {"id": "neg", "node_name": "Neg", "summary": "s", "semantic_level": -3},
    ]
    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=out_of_range,
    )

    nodes = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Node)]
    by_name = {n.node_name: n for n in nodes}
    assert by_name["Below"].level == 1   # clamped to min
    assert by_name["Above"].level == 5   # clamped to max
    assert by_name["Neg"].level == 1     # clamped to min


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
async def test_persist_import_graph_persists_import_utterances_and_updates_conversation_stats():
    conv = MagicMock()
    db = _make_db_mock(conv=conv)

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=SAMPLE_NODES,
        utterances=SAMPLE_UTTERANCES,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    utterances = [o for o in added_objects if isinstance(o, DBUtterance)]

    assert len(utterances) == 2
    assert [utt.sequence_number for utt in utterances] == [1, 2]
    assert utterances[1].speaker_source == "diarization"
    assert utterances[1].speaker_confidence == 0.95
    assert conv.total_utterances == 2
    assert conv.participant_count == 2
    assert conv.total_words == 11


@pytest.mark.asyncio
async def test_persist_import_graph_creates_temporal_relationship_from_predecessor_only():
    from lct_python_backend.models import Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)
    predecessor_only_nodes = [
        {
            "node_name": "Alpha",
            "summary": "Start",
            "successor": None,
            "predecessor": None,
            "contextual_relation": {},
        },
        {
            "node_name": "Beta",
            "summary": "Follow up",
            "successor": None,
            "predecessor": "Alpha",
            "contextual_relation": {},
        },
    ]

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=predecessor_only_nodes,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    temporal_rels = [
        obj for obj in added_objects
        if isinstance(obj, Relationship) and obj.relationship_type == "temporal"
    ]

    assert len(temporal_rels) == 1
    assert temporal_rels[0].explanation == "Sequential conversation flow"


@pytest.mark.asyncio
async def test_persist_import_graph_preserves_edge_relation_semantics():
    from lct_python_backend.models import Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)
    nodes_with_edge_relations = [
        {
            "node_name": "Monastery Plans",
            "summary": "Monastery thread",
            "edge_relations": [],
        },
        {
            "node_name": "Visa Timeline",
            "summary": "Visa thread",
            "edge_relations": [
                {
                    "related_node": "Monastery Plans",
                    "relation_type": "supports",
                    "relation_text": "The visa choice supports the monastery decision",
                }
            ],
        },
    ]

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=nodes_with_edge_relations,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    support_edges = [
        obj for obj in added_objects
        if isinstance(obj, Relationship) and obj.relationship_type == "supports"
    ]

    assert len(support_edges) == 1
    assert support_edges[0].explanation == "The visa choice supports the monastery decision"


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


@pytest.mark.asyncio
async def test_persist_import_graph_preserves_provided_uuid_ids_and_id_refs():
    from lct_python_backend.models import Node, Relationship

    conv = MagicMock()
    db = _make_db_mock(conv=conv)
    nodes_with_ids = [
        {
            "id": STABLE_ID_ALPHA,
            "node_name": "Alpha",
            "summary": "First topic",
            "successor": STABLE_ID_BETA,
            "predecessor": None,
            "contextual_relation": {},
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": "chunk_001",
        },
        {
            "id": STABLE_ID_BETA,
            "node_name": "Beta",
            "summary": "Second topic",
            "successor": None,
            "predecessor": STABLE_ID_ALPHA,
            "contextual_relation": {STABLE_ID_ALPHA: "Beta builds on Alpha"},
            "is_bookmark": False,
            "is_contextual_progress": False,
            "chunk_id": "chunk_002",
        },
    ]

    await persist_import_graph(
        db=db,
        conversation_id=CONVERSATION_ID,
        existing_json=nodes_with_ids,
    )

    added_objects = [c.args[0] for c in db.add.call_args_list]
    nodes = [o for o in added_objects if isinstance(o, Node)]
    rels = [o for o in added_objects if isinstance(o, Relationship)]

    node_ids = {str(node.id) for node in nodes}
    assert node_ids == {STABLE_ID_ALPHA, STABLE_ID_BETA}

    temporal = [rel for rel in rels if rel.relationship_type == "temporal"]
    contextual = [rel for rel in rels if rel.relationship_type == "contextual"]

    assert len(temporal) == 1
    assert str(temporal[0].from_node_id) == STABLE_ID_ALPHA
    assert str(temporal[0].to_node_id) == STABLE_ID_BETA

    assert len(contextual) == 1
    assert str(contextual[0].from_node_id) == STABLE_ID_BETA
    assert str(contextual[0].to_node_id) == STABLE_ID_ALPHA

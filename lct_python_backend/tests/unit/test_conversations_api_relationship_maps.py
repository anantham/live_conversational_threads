import importlib
import sys
import types
from types import SimpleNamespace
import uuid


def _load_conversations_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.conversations_api", None)
    return importlib.import_module("lct_python_backend.conversations_api")


def test_build_relationship_maps_populates_temporal_and_contextual_links(monkeypatch):
    conversations_api = _load_conversations_api_with_stubs(monkeypatch)
    node_a = SimpleNamespace(id=uuid.uuid4(), node_name="Node A")
    node_b = SimpleNamespace(id=uuid.uuid4(), node_name="Node B")
    node_c = SimpleNamespace(id=uuid.uuid4(), node_name="Node C")

    relationships = [
        SimpleNamespace(
            from_node_id=node_a.id,
            to_node_id=node_b.id,
            relationship_type="leads_to",
            explanation=None,
            is_bidirectional=False,
        ),
        SimpleNamespace(
            from_node_id=node_a.id,
            to_node_id=node_c.id,
            relationship_type="supports",
            explanation="Builds on earlier claim",
            is_bidirectional=False,
        ),
    ]

    predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id = conversations_api._build_relationship_maps(
        [node_a, node_b, node_c], relationships
    )

    assert successor_by_id[node_a.id] == str(node_b.id)
    assert predecessor_by_id[node_b.id] == str(node_a.id)

    assert contextual_by_id[node_a.id] == {"Node C": "Builds on earlier claim"}
    assert linked_by_id[node_a.id] == ["Node C"]


def test_build_relationship_maps_adds_reverse_context_for_bidirectional_edges(monkeypatch):
    conversations_api = _load_conversations_api_with_stubs(monkeypatch)
    node_a = SimpleNamespace(id=uuid.uuid4(), node_name="Source")
    node_b = SimpleNamespace(id=uuid.uuid4(), node_name="Target")

    relationships = [
        SimpleNamespace(
            from_node_id=node_a.id,
            to_node_id=node_b.id,
            relationship_type="related",
            explanation=None,
            is_bidirectional=True,
        ),
    ]

    predecessor_by_id, successor_by_id, contextual_by_id, linked_by_id = conversations_api._build_relationship_maps(
        [node_a, node_b], relationships
    )

    assert predecessor_by_id == {}
    assert successor_by_id == {}
    assert contextual_by_id[node_a.id] == {"Target": "related"}
    assert contextual_by_id[node_b.id] == {"Source": "related"}
    assert linked_by_id[node_a.id] == ["Target"]
    assert linked_by_id[node_b.id] == ["Source"]

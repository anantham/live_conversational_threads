import importlib
import sys
import types
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_graph_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.graph_api", None)
    return importlib.import_module("lct_python_backend.graph_api")


def test_temporal_relationship_classifier(monkeypatch):
    graph_api = _load_graph_api_with_stubs(monkeypatch)

    assert graph_api._is_temporal_relationship("temporal") is True
    assert graph_api._is_temporal_relationship("leads_to") is True
    assert graph_api._is_temporal_relationship("supports") is False
    assert graph_api._is_temporal_relationship(None) is False


def test_turn_builder_groups_consecutive_speakers(monkeypatch):
    graph_api = _load_graph_api_with_stubs(monkeypatch)

    utterances = [
        SimpleNamespace(
            id=uuid.uuid4(),
            speaker_id="Alice",
            speaker_name="Alice",
            text="Hello there",
            timestamp_start=0.0,
            timestamp_end=1.0,
        ),
        SimpleNamespace(
            id=uuid.uuid4(),
            speaker_id="Alice",
            speaker_name="Alice",
            text="Continuing point",
            timestamp_start=1.0,
            timestamp_end=2.0,
        ),
        SimpleNamespace(
            id=uuid.uuid4(),
            speaker_id="Bob",
            speaker_name="Bob",
            text="New speaker turn",
            timestamp_start=2.0,
            timestamp_end=3.0,
        ),
    ]

    node_specs = graph_api._build_turn_based_nodes(utterances)
    edge_payload = graph_api._build_temporal_edge_payload(node_specs)

    assert len(node_specs) == 2
    assert len(node_specs[0].utterance_ids) == 2
    assert len(node_specs[1].utterance_ids) == 1
    assert len(edge_payload) == 1


def test_get_graph_returns_empty_payload_when_no_nodes(monkeypatch):
    graph_api = _load_graph_api_with_stubs(monkeypatch)

    class DummyScalarResult:
        def __init__(self, values):
            self._values = values

        def all(self):
            return self._values

    class DummyExecuteResult:
        def __init__(self, values):
            self._values = values

        def scalars(self):
            return DummyScalarResult(self._values)

    class DummySession:
        async def execute(self, _statement):
            return DummyExecuteResult([])

    async def override_session():
        yield DummySession()

    app = FastAPI()
    app.include_router(graph_api.router)
    app.dependency_overrides[graph_api.get_async_session] = override_session

    client = TestClient(app)
    conversation_id = str(uuid.uuid4())
    response = client.get(f"/api/graph/{conversation_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["conversation_id"] == conversation_id
    assert payload["node_count"] == 0
    assert payload["edge_count"] == 0
    assert payload["nodes"] == []
    assert payload["edges"] == []

import importlib
import sys
import types
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_module(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.artifact_api", None)
    module = importlib.import_module("lct_python_backend.artifact_api")
    return module


def _build_client(module):
    app = FastAPI()
    app.include_router(module.router)
    return TestClient(app)


def test_post_reroute_conversation_artifacts(monkeypatch):
    module = _load_module(monkeypatch)
    client = _build_client(module)

    load_settings_mock = AsyncMock(
        return_value={
            "enabled": True,
            "root_path": "/tmp/conversations",
            "self_name": "Aditya",
            "write_canvas": True,
            "write_transcript": True,
            "include_chunks": False,
            "trigger_on_import_complete": True,
            "trigger_on_live_finalize": False,
        }
    )
    reroute_mock = AsyncMock(
        return_value={
            "ok": True,
            "rerouted": True,
            "resolved_root_path": "/tmp/conversations/Anand",
            "written_files": [
                "/tmp/conversations/Anand/example.canvas",
                "/tmp/conversations/Anand/example.txt",
            ],
        }
    )

    monkeypatch.setattr(module, "load_artifact_export_settings", load_settings_mock)
    monkeypatch.setattr(module, "reroute_conversation_artifacts", reroute_mock)

    response = client.post(
        "/api/conversations/123e4567-e89b-12d3-a456-426614174000/artifacts/reroute"
    )

    assert response.status_code == 200
    assert response.json()["rerouted"] is True
    assert reroute_mock.await_args.kwargs["conversation_id"] == "123e4567-e89b-12d3-a456-426614174000"


def test_post_reroute_conversation_artifacts_returns_400_on_bad_settings(monkeypatch):
    module = _load_module(monkeypatch)
    client = _build_client(module)

    monkeypatch.setattr(module, "load_artifact_export_settings", AsyncMock(return_value={}))
    monkeypatch.setattr(
        module,
        "reroute_conversation_artifacts",
        AsyncMock(side_effect=ValueError("Artifact export folder is required.")),
    )

    response = client.post(
        "/api/conversations/123e4567-e89b-12d3-a456-426614174000/artifacts/reroute"
    )

    assert response.status_code == 400
    assert "required" in response.json()["detail"].lower()

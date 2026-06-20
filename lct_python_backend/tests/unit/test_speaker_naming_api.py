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
    sys.modules.pop("lct_python_backend.speaker_naming_api", None)
    module = importlib.import_module("lct_python_backend.speaker_naming_api")
    return module


def _build_client(module):
    app = FastAPI()
    app.include_router(module.router)
    app.include_router(module.router_conversations)
    return TestClient(app)


def test_get_conversation_speakers(monkeypatch):
    module = _load_module(monkeypatch)
    client = _build_client(module)

    list_mock = AsyncMock(
        return_value=[
            {
                "speaker_id": "SPEAKER_00",
                "speaker_name": "Aditya",
                "display_name": "Aditya",
                "utterance_count": 12,
                "confirmed": True,
            }
        ]
    )
    monkeypatch.setattr(module, "list_conversation_speakers", list_mock)

    response = client.get("/api/conversations/123e4567-e89b-12d3-a456-426614174000/speakers")

    assert response.status_code == 200
    assert response.json()[0]["display_name"] == "Aditya"


def test_patch_conversation_speaker_name(monkeypatch):
    module = _load_module(monkeypatch)
    client = _build_client(module)

    rename_mock = AsyncMock(
        return_value=[
            {
                "speaker_id": "SPEAKER_01",
                "speaker_name": "Anand",
                "display_name": "Anand",
                "utterance_count": 8,
                "confirmed": True,
            }
        ]
    )
    monkeypatch.setattr(module, "rename_conversation_speaker", rename_mock)

    response = client.patch(
        "/api/conversations/123e4567-e89b-12d3-a456-426614174000/speakers/SPEAKER_01",
        json={"speaker_name": "Anand"},
    )

    assert response.status_code == 200
    assert response.json()[0]["speaker_name"] == "Anand"
    assert rename_mock.await_args.kwargs["speaker_name"] == "Anand"

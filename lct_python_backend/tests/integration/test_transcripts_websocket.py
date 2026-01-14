from contextlib import asynccontextmanager
import importlib
import sys
import types
import uuid
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_transcripts_ws_persists_partial_and_final(monkeypatch):
    class DummySession:
        async def commit(self):
            return None

    class PlaceholderProcessor:
        def __init__(self, *args, **kwargs):
            return None

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            return None

    @asynccontextmanager
    async def dummy_session_context():
        yield DummySession()

    async def dummy_get_async_session():
        yield DummySession()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session
    dummy_db_session.get_async_session_context = dummy_session_context

    dummy_transcript_processing = types.ModuleType("lct_python_backend.services.transcript_processing")
    dummy_transcript_processing.TranscriptProcessor = PlaceholderProcessor

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    monkeypatch.setitem(
        sys.modules,
        "lct_python_backend.services.transcript_processing",
        dummy_transcript_processing,
    )
    sys.modules.pop("lct_python_backend.stt_api", None)
    stt_api = importlib.import_module("lct_python_backend.stt_api")

    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    class DummyProcessor:
        def __init__(self, send_update, llm_config):
            self._send_update = send_update
            self._llm_config = llm_config

        async def handle_final_text(self, text):
            processor_calls["final"].append(text)

        async def flush(self):
            processor_calls["flush"] += 1

    monkeypatch.setattr(stt_api, "persist_transcript_event", AsyncMock(side_effect=fake_persist))
    monkeypatch.setattr(stt_api, "TranscriptProcessor", DummyProcessor)
    monkeypatch.setattr(stt_api, "load_llm_config", AsyncMock(return_value={}))
    monkeypatch.setattr(stt_api, "get_async_session_context", dummy_session_context)

    app = FastAPI()
    app.include_router(stt_api.router)
    client = TestClient(app)

    conversation_id = str(uuid.uuid4())

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conversation_id,
                "session_id": "session-1",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["conversation_id"] == conversation_id
        assert ack["session_id"] == "session-1"

        ws.send_json({"type": "transcript_partial", "text": "hello"})
        ws.send_json(
            {
                "type": "transcript_final",
                "text": "hello world",
                "timestamps": {"start": 0.0, "end": 1.0},
            }
        )
        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"

    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == ["hello world"]
    assert processor_calls["flush"] == 1

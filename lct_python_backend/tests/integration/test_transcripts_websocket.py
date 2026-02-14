from contextlib import asynccontextmanager
import asyncio
import base64
import importlib
import sys
import time
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
        def __init__(self, send_update, llm_config, send_status=None):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status

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

    time.sleep(0.05)
    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == ["hello world"]
    assert processor_calls["flush"] == 1


def test_transcripts_ws_accepts_audio_chunk_backend_owned_stt(monkeypatch):
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
        def __init__(self, send_update, llm_config, send_status=None):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status

        async def handle_final_text(self, text):
            processor_calls["final"].append(text)

        async def flush(self):
            processor_calls["flush"] += 1

    class DummyHttpSttSession:
        def __init__(self, **_kwargs):
            pass

        def is_ready(self):
            return True

        async def push_audio_chunk(self, _chunk):
            return {
                "text": "quick transcript.",
                "is_final": False,
                "metadata": {"provider": "parakeet"},
            }

        async def flush(self):
            return None

    monkeypatch.setattr(stt_api, "persist_transcript_event", AsyncMock(side_effect=fake_persist))
    monkeypatch.setattr(stt_api, "TranscriptProcessor", DummyProcessor)
    monkeypatch.setattr(stt_api, "RealtimeHttpSttSession", DummyHttpSttSession)
    monkeypatch.setattr(stt_api, "load_llm_config", AsyncMock(return_value={}))
    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(
            return_value={
                "provider": "parakeet",
                "provider_http_urls": {"parakeet": "http://localhost:5092/v1/audio/transcriptions"},
                "http_url": "http://localhost:5092/v1/audio/transcriptions",
            }
        ),
    )
    monkeypatch.setattr(stt_api, "get_async_session_context", dummy_session_context)

    app = FastAPI()
    app.include_router(stt_api.router)
    client = TestClient(app)

    conversation_id = str(uuid.uuid4())
    audio_base64 = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conversation_id,
                "session_id": "session-2",
                "provider": "parakeet",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["stt_mode"] == "backend_http"
        assert ack["stt_ready"] is True

        ws.send_json({"type": "audio_chunk", "audio_base64": audio_base64})

        first_msg = ws.receive_json()
        second_msg = ws.receive_json()
        assert first_msg["type"] == "transcript_partial"
        assert second_msg["type"] == "transcript_final"
        assert "quick transcript" in second_msg["text"]

        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"

    time.sleep(0.05)
    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == ["quick transcript."]
    assert processor_calls["flush"] == 1


def test_transcripts_ws_flush_ack_not_blocked_by_processor_flush(monkeypatch):
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

    async def fake_persist(_session, _state, _payload, _event_type, _text):
        return None

    class SlowFlushProcessor:
        def __init__(self, send_update, llm_config, send_status=None):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            await asyncio.sleep(0.35)

    monkeypatch.setattr(stt_api, "persist_transcript_event", AsyncMock(side_effect=fake_persist))
    monkeypatch.setattr(stt_api, "TranscriptProcessor", SlowFlushProcessor)
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
                "session_id": "session-slow-flush",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "transcript_final", "text": "quick final segment"})
        start = time.perf_counter()
        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        assert flush_ack["type"] == "flush_ack"
        assert elapsed_ms < 250.0

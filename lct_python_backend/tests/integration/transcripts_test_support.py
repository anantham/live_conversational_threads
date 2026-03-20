import asyncio
import base64
import importlib
import struct
import sys
import types
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient


class DummySession:
    async def commit(self):
        return None


@asynccontextmanager
async def dummy_session_context():
    yield DummySession()


async def noop_persist(_session, _state, _payload, _event_type, _text):
    return None


def build_processor_class(call_store, *, flush_delay=0.0):
    class Processor:
        def __init__(self, send_update, llm_config, send_status=None):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status

        async def handle_final_text(self, text, speaker_segments=None):
            call_store["final"].append((text, speaker_segments))

        async def flush(self):
            if flush_delay:
                await asyncio.sleep(flush_delay)
            call_store["flush"] += 1

    return Processor


def build_test_client(
    monkeypatch,
    *,
    stt_settings=None,
    processor_cls=None,
    stt_session_cls=None,
    persist_side_effect=None,
):
    async def dummy_get_async_session():
        yield DummySession()

    class PlaceholderProcessor:
        def __init__(self, *args, **kwargs):
            return None

        async def handle_final_text(self, _text):
            return None

        async def flush(self):
            return None

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session
    dummy_db_session.get_async_session_context = dummy_session_context
    dummy_transcript_processing = types.ModuleType(
        "lct_python_backend.services.transcript_processing"
    )
    dummy_transcript_processing.TranscriptProcessor = PlaceholderProcessor

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    monkeypatch.setitem(
        sys.modules,
        "lct_python_backend.services.transcript_processing",
        dummy_transcript_processing,
    )
    sys.modules.pop("lct_python_backend.stt_api", None)
    sys.modules.pop("lct_python_backend.services.stt_ws_session", None)

    stt_api = importlib.import_module("lct_python_backend.stt_api")
    ws_mod = importlib.import_module("lct_python_backend.services.stt_ws_session")

    effective_stt_settings = stt_settings or {
        "provider": "whisper",
        "provider_http_urls": {},
        "http_url": "",
    }

    async def _always_authed(_websocket):
        return True

    monkeypatch.setattr(stt_api, "check_ws_auth_message", _always_authed)
    monkeypatch.setattr(stt_api, "get_async_session_context", dummy_session_context)
    monkeypatch.setattr(stt_api, "load_llm_config", AsyncMock(return_value={}))
    monkeypatch.setattr(
        stt_api,
        "_load_stt_settings",
        AsyncMock(return_value=effective_stt_settings),
    )
    monkeypatch.setattr(
        ws_mod,
        "persist_transcript_event",
        AsyncMock(side_effect=persist_side_effect or noop_persist),
    )

    if processor_cls is not None:
        monkeypatch.setattr(ws_mod, "TranscriptProcessor", processor_cls)
    if stt_session_cls is not None:
        monkeypatch.setattr(ws_mod, "RealtimeHttpSttSession", stt_session_cls)

    app = FastAPI()
    app.include_router(stt_api.router)
    return TestClient(app)


def pcm_audio_base64(seconds: float, *, sample_rate_hz: int = 16000, amplitude: int = 512) -> str:
    sample_count = max(1, int(sample_rate_hz * seconds))
    pcm_bytes = struct.pack("<" + ("h" * sample_count), *([amplitude] * sample_count))
    return base64.b64encode(pcm_bytes).decode("ascii")

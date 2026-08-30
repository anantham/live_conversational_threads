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
        def __init__(self, send_update, llm_config, send_status=None, providers=None, **_kwargs):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status
            self._providers = providers or []

        async def handle_final_text(self, text, speaker_segments=None):
            call_store["final"].append((text, speaker_segments))

        async def flush(self):
            if flush_delay:
                await asyncio.sleep(flush_delay)
            call_store["flush"] += 1

    return Processor


def receive_session_ack(websocket):
    """Receive and validate the public two-frame session startup contract."""
    started = websocket.receive_json()
    assert started["type"] == "session_started"
    ack = websocket.receive_json()
    assert ack["type"] == "session_ack"
    assert ack["conversation_id"] == started["conversation_id"]
    assert ack["session_id"] == started["session_id"]
    return ack


def receive_until_type(websocket, expected_type, *, max_messages=20):
    """Read an asynchronous protocol stream until the requested public frame."""
    observed = []
    for _ in range(max_messages):
        message = websocket.receive_json()
        observed.append(message.get("type"))
        if message.get("type") == expected_type:
            return message
    raise AssertionError(
        f"Did not receive {expected_type!r} within {max_messages} frames; "
        f"observed={observed}"
    )


def build_test_client(
    monkeypatch,
    *,
    stt_settings=None,
    processor_cls=None,
    stt_session_cls=None,
    runtime_factory=None,
    persist_side_effect=None,
    quota_result=None,
):
    async def dummy_get_async_session():
        yield DummySession()

    async def noop_async(*_args, **_kwargs):
        return None

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
        "lct_python_backend.services.transcript.transcript_processing"
    )
    dummy_transcript_processing.TranscriptProcessor = PlaceholderProcessor

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    monkeypatch.setitem(
        sys.modules,
        "lct_python_backend.services.transcript.transcript_processing",
        dummy_transcript_processing,
    )
    sys.modules.pop("lct_python_backend.stt_api", None)
    sys.modules.pop("lct_python_backend.services.stt.stt_ws_session", None)

    stt_api = importlib.import_module("lct_python_backend.stt_api")
    ws_mod = importlib.import_module("lct_python_backend.services.stt.stt_ws_session")

    effective_quota_result = quota_result or types.SimpleNamespace(
        allowed=True,
        remaining_minutes=10.0,
        limit_minutes=10.0,
        percent_used=0.0,
        warning=False,
        message="",
    )

    class StubQuotaService:
        def __init__(self, _session):
            pass

        async def check_quota(self, **_kwargs):
            return effective_quota_result

        async def record_usage(self, **_kwargs):
            return None

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
    monkeypatch.setattr(stt_api, "_load_llm_providers", AsyncMock(return_value=[]))
    monkeypatch.setattr(ws_mod, "QuotaService", StubQuotaService)
    monkeypatch.setattr(ws_mod, "ensure_conversation", noop_async)
    monkeypatch.setattr(ws_mod, "start_thread_session", noop_async)
    monkeypatch.setattr(ws_mod, "finish_thread_session", noop_async)
    monkeypatch.setattr(ws_mod, "record_thread_event", noop_async)
    monkeypatch.setattr(ws_mod.WsSessionContext, "_detect_resume", noop_async)
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
    if runtime_factory is not None:
        monkeypatch.setattr(ws_mod, "build_live_stt_runtime", runtime_factory)
    elif stt_session_cls is not None:
        class DummyHttpRuntime:
            stt_mode = "backend_http"
            provider = "parakeet"
            transport = "backend_http"
            supports_diarization = False

            def __init__(self, **kwargs):
                self._session = stt_session_cls(**kwargs)
                self.provider = getattr(self._session, "provider", kwargs.get("provider", "parakeet"))
                self.transport = "backend_http"
                self.supports_diarization = bool(kwargs.get("provider") == "whisper")
                self.sample_rate_hz = getattr(self._session, "sample_rate_hz", kwargs.get("sample_rate_hz", 16000))
                self.timeout_seconds = getattr(self._session, "timeout_seconds", kwargs.get("timeout_seconds", 30.0))
                self.model = getattr(self._session, "model", kwargs.get("model", ""))

            def is_ready(self):
                return self._session.is_ready()

            def get_last_runtime_metadata(self):
                return self._session.get_last_runtime_metadata()

            async def start(self):
                return None

            async def push_audio_chunk(self, chunk):
                result = await self._session.push_audio_chunk(chunk)
                if not result:
                    return []
                return [{
                    "event_type": "partial",
                    "text": result.get("text") or "",
                    "metadata": result.get("metadata") or {},
                    "timestamps": result.get("timestamps") or {},
                    "segments": result.get("segments"),
                    "_wav_payload": result.get("_wav_payload"),
                }]

            async def flush(self):
                result = await self._session.flush()
                if not result:
                    return []
                return [{
                    "event_type": "final",
                    "text": result.get("text") or "",
                    "metadata": result.get("metadata") or {},
                    "timestamps": result.get("timestamps") or {},
                    "segments": result.get("segments"),
                    "_wav_payload": result.get("_wav_payload"),
                }]

            async def close(self):
                await self._session.close()

        monkeypatch.setattr(ws_mod, "build_live_stt_runtime", lambda **kwargs: DummyHttpRuntime(**kwargs))

    app = FastAPI()
    app.include_router(stt_api.router)
    return TestClient(app)


def pcm_audio_base64(seconds: float, *, sample_rate_hz: int = 16000, amplitude: int = 512) -> str:
    sample_count = max(1, int(sample_rate_hz * seconds))
    pcm_bytes = struct.pack("<" + ("h" * sample_count), *([amplitude] * sample_count))
    return base64.b64encode(pcm_bytes).decode("ascii")

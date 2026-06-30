import asyncio
import sys
import time
import types
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

try:
    from google import genai as _google_genai  # noqa: F401
except ImportError:
    google_module = sys.modules.get("google")
    if google_module is None:
        google_module = types.ModuleType("google")
        sys.modules["google"] = google_module

    genai_module = types.ModuleType("google.genai")

    class _UnavailableGenaiClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("google-genai test stub should not be used at runtime")

    genai_module.Client = _UnavailableGenaiClient
    types_module = types.ModuleType("google.genai.types")
    genai_module.types = types_module
    setattr(google_module, "genai", genai_module)
    sys.modules["google.genai"] = genai_module
    sys.modules["google.genai.types"] = types_module

from lct_python_backend.services.stt.stt_http_transcriber import pcm16le_to_wav
from lct_python_backend.services import transcript_processing as transcript_mod
from lct_python_backend.services.transcript_processing import TranscriptProcessor
from lct_python_backend.tests.integration.transcripts_test_support import (
    build_processor_class,
    build_test_client,
    pcm_audio_base64,
)


# DEFAULT_LLM_MODE defaults to "local", so _process_batch uses the boundary-index
# accumulate path. These plumbing tests mock that path to complete-all so the
# graph emits deterministically regardless of how llm mode resolves.
def _acc_idx_complete_all(numbered_input, **kwargs):
    return (
        {"decision": "stop_accumulating", "completed_through_index": 10**9, "detected_threads": []},
        "local_test",
    )


def test_transcripts_ws_persists_partial_and_final(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls),
        persist_side_effect=fake_persist,
    )

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
        assert ack["transport"] == "backend_http"
        assert ack["model"] is None
        assert ack["model_source"] == "server_default"
        assert ack["supports_diarization"] is True
        assert ack["degraded"] is False
        assert ack["stt_ready"] is False

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
        flush_complete = None
        for _ in range(8):
            message = ws.receive_json()
            if message["type"] == "flush_complete":
                flush_complete = message
                break
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.05)
    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == [("hello world", None)]
    assert processor_calls["flush"] == 1


def test_transcripts_ws_accepts_audio_chunk_backend_owned_stt(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

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
                "segments": [
                    {
                        "speaker": "SPEAKER_00",
                        "start": 0.0,
                        "end": 0.8,
                        "text": "quick transcript.",
                    }
                ],
            }

        async def flush(self):
            return None

        async def close(self):
            return None

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
            },
            "http_url": "http://localhost:5092/v1/audio/transcriptions",
        },
        processor_cls=build_processor_class(processor_calls),
        stt_session_cls=DummyHttpSttSession,
        persist_side_effect=fake_persist,
    )

    conversation_id = str(uuid.uuid4())

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
        assert ack["transport"] == "backend_http"
        assert ack["model"] is None
        assert ack["model_source"] == "server_default"
        assert ack["stt_ready"] is True

        ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})

        first_msg = ws.receive_json()
        second_msg = ws.receive_json()
        third_msg = ws.receive_json()
        assert first_msg["type"] == "graph_patch"
        assert first_msg["data"]["kind"] == "draft"
        assert second_msg["type"] == "transcript_partial"
        assert third_msg["type"] == "transcript_final"
        assert "quick transcript" in third_msg["text"]

        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"
        flush_complete = None
        for _ in range(8):
            message = ws.receive_json()
            if message["type"] == "flush_complete":
                flush_complete = message
                break
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.05)
    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == [
        (
            "quick transcript.",
            [
                {
                    "speaker": "SPEAKER_00",
                    "start": 0.0,
                    "end": 0.8,
                    "text": "quick transcript.",
                }
            ],
        )
    ]
    assert processor_calls["flush"] == 1


def test_transcripts_ws_accepts_streaming_runtime_events(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    class DummyRealtimeRuntime:
        stt_mode = "openai_realtime"
        provider = "openai_audio"
        transport = "openai_realtime"
        supports_diarization = False
        model = "gpt-4o-mini-transcribe"

        def __init__(self, **kwargs):
            self.sample_rate_hz = kwargs.get("sample_rate_hz", 16000)
            self.timeout_seconds = kwargs.get("timeout_seconds", 30.0)
            self._started = False

        def is_ready(self):
            return self._started

        def get_last_runtime_metadata(self):
            return {"provider": self.provider, "transport": self.transport}

        async def start(self):
            self._started = True

        async def push_audio_chunk(self, _chunk):
            return [
                {
                    "event_type": "partial",
                    "text": "hello from realtime",
                    "metadata": {"provider": self.provider, "transport": self.transport},
                },
                {
                    "event_type": "final",
                    "text": "hello from realtime",
                    "metadata": {
                        "provider": self.provider,
                        "transport": self.transport,
                        "sample_rate_hz": 24000,
                    },
                },
            ]

        async def flush(self):
            return []

        async def close(self):
            self._started = False

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "sk-test",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                }
            },
            "live_fallback_priority": ["openai_audio", "remote_whisper"],
        },
        processor_cls=build_processor_class(processor_calls),
        runtime_factory=lambda **kwargs: DummyRealtimeRuntime(**kwargs),
        persist_side_effect=fake_persist,
    )

    conversation_id = str(uuid.uuid4())

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conversation_id,
                "session_id": "session-realtime",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["stt_mode"] == "openai_realtime"
        assert ack["transport"] == "openai_realtime"
        assert ack["provider"] == "openai_audio"
        assert ack["stt_ready"] is True
        assert ack["background_refinement"]["enabled"] is True
        assert ack["background_refinement"]["provider"] in {"whisper", "openai_audio"}

        ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})
        first_msg = ws.receive_json()
        second_msg = ws.receive_json()
        third_msg = ws.receive_json()
        assert first_msg["type"] == "graph_patch"
        assert first_msg["data"]["kind"] == "draft"
        assert second_msg["type"] == "transcript_partial"
        assert third_msg["type"] == "transcript_final"
        assert third_msg["metadata"]["transport"] == "openai_realtime"

        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"
        flush_complete = None
        for _ in range(8):
            message = ws.receive_json()
            if message["type"] == "flush_complete":
                flush_complete = message
                break
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.05)
    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == [("hello from realtime", None)]


def test_transcripts_ws_backend_realtime_forces_audio_storage_and_schedules_file_refinement(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}
    file_refinement_calls = []

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    class DummyBackendRealtimeRuntime:
        stt_mode = "backend_ws"
        provider = "whisper"
        transport = "backend_ws"
        supports_diarization = False
        model = "turbo"

        def __init__(self, **kwargs):
            self.sample_rate_hz = kwargs.get("sample_rate_hz", 16000)
            self.timeout_seconds = kwargs.get("timeout_seconds", 30.0)
            self._started = False

        def is_ready(self):
            return self._started

        def get_last_runtime_metadata(self):
            return {"provider": self.provider, "transport": self.transport}

        async def start(self):
            self._started = True

        async def push_audio_chunk(self, _chunk):
            return [
                {
                    "event_type": "final",
                    "text": "hello from backend ws",
                    "metadata": {
                        "provider": self.provider,
                        "transport": self.transport,
                        "sample_rate_hz": 16000,
                    },
                }
            ]

        async def flush(self):
            return []

        async def close(self):
            self._started = False

    class DummyAudioStorage:
        def __init__(self):
            self.appended = []
            self.finalized = []

        async def append_chunk(self, conversation_id, chunk_bytes):
            self.appended.append((conversation_id, bytes(chunk_bytes)))

        async def finalize(self, conversation_id):
            self.finalized.append(conversation_id)
            return {
                "wav_path": "/tmp/backend-live.wav",
                "flac_path": None,
                "bytes_written": sum(len(chunk) for _, chunk in self.appended),
            }

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": False,
            "live_require_diarization": True,
            "live_allow_text_only_fallback": False,
        },
        processor_cls=build_processor_class(processor_calls),
        runtime_factory=lambda **kwargs: DummyBackendRealtimeRuntime(**kwargs),
        persist_side_effect=fake_persist,
    )

    import lct_python_backend.services.stt.stt_ws_session as ws_mod
    import lct_python_backend.stt_api as stt_api

    dummy_audio_storage = DummyAudioStorage()
    monkeypatch.setattr(stt_api, "audio_storage", dummy_audio_storage)

    async def fake_run_file_backed_refinement(self, wav_path, source_text):
        file_refinement_calls.append((wav_path, source_text, self.state.conversation_id))

    monkeypatch.setattr(ws_mod.WsSessionContext, "_run_file_backed_refinement", fake_run_file_backed_refinement)

    conversation_id = str(uuid.uuid4())

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conversation_id,
                "session_id": "session-backend-ws",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["stt_mode"] == "backend_ws"
        assert ack["transport"] == "backend_ws"
        assert ack["store_audio"] is True
        assert ack["background_refinement"]["enabled"] is True
        assert ack["background_refinement"]["provider"] == "whisper"

        ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})
        transcript_final = None
        for _ in range(4):
            next_message = ws.receive_json()
            if next_message["type"] == "transcript_final":
                transcript_final = next_message
                break
        assert transcript_final is not None
        assert transcript_final["text"] == "hello from backend ws"

        ws.send_json({"type": "final_flush"})
        flush_ack = None
        flush_complete = None
        audio_ready = None
        for _ in range(16):
            next_message = ws.receive_json()
            if next_message["type"] == "audio_ready":
                audio_ready = next_message
            if next_message["type"] == "flush_ack":
                flush_ack = next_message
            if next_message["type"] == "flush_complete":
                flush_complete = next_message
            if audio_ready is not None and flush_ack is not None and flush_complete is not None:
                break
        assert audio_ready is not None
        assert audio_ready["audio_paths"]["wav_path"] == "/tmp/backend-live.wav"
        assert flush_ack is not None
        assert flush_ack["type"] == "flush_ack"
        assert flush_complete is not None
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.05)
    assert dummy_audio_storage.finalized == [conversation_id]
    assert file_refinement_calls == [
        ("/tmp/backend-live.wav", "hello from backend ws", conversation_id)
    ]
    assert [event for event, *_rest in persisted] == ["final"]
    assert processor_calls["final"] == [("hello from backend ws", None)]


def test_transcripts_ws_session_meta_uses_byok_openai_candidate(monkeypatch):
    import lct_python_backend.services.byok_session_store as byok

    byok._BYOK_SESSIONS.clear()
    monkeypatch.setattr(byok, "validate_byok_api_key", AsyncMock(return_value=None))
    session_payload = asyncio.run(
        byok.create_byok_session(
            provider="openai_audio",
            api_key="sk-test-secret",
            scopes=[byok.BYOK_SCOPE_STT_LIVE, byok.BYOK_SCOPE_LLM_LIVE],
        )
    )

    captured = {"processor_inits": []}

    def runtime_factory(**kwargs):
        captured["kwargs"] = kwargs

        class DummyRuntime:
            stt_mode = "openai_realtime"

            def __init__(self):
                primary_candidate = kwargs["candidates"][0]
                self.provider = kwargs["provider"]
                self.transport = primary_candidate.get("transport")
                self.supports_diarization = bool(primary_candidate.get("supports_diarization"))
                self.model = primary_candidate.get("model")
                self.sample_rate_hz = kwargs.get("sample_rate_hz", 16000)
                self.timeout_seconds = kwargs.get("timeout_seconds", 30.0)

            def is_ready(self):
                return True

            def get_last_runtime_metadata(self):
                return {}

            async def start(self):
                return None

            async def push_audio_chunk(self, _chunk):
                return []

            async def flush(self):
                return []

            async def close(self):
                return None

        return DummyRuntime()

    class CapturingProcessor:
        def __init__(self, send_update, llm_config, send_status=None, providers=None, **kwargs):
            self._send_update = send_update
            self._llm_config = llm_config
            self._send_status = send_status
            self._providers = list(providers or [])
            captured["processor_inits"].append(
                {
                    "llm_config": dict(llm_config or {}),
                    "providers": list(providers or []),
                    "kwargs": kwargs,
                }
            )

        async def handle_final_text(self, _text, speaker_segments=None):
            return None

        async def flush(self):
            return None

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://localhost:5092/v1/audio/transcriptions",
            "local_only": True,
        },
        processor_cls=CapturingProcessor,
        runtime_factory=runtime_factory,
    )

    conversation_id = str(uuid.uuid4())
    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conversation_id,
                "session_id": "session-byok",
                "provider": "openai_audio",
                "byok_session_token": session_payload["byok_session_token"],
                "store_audio": False,
            }
        )
        ack = ws.receive_json()

    assert ack["type"] == "session_ack"
    assert ack["provider"] == "openai_audio"
    assert ack["transport"] == "openai_audio"
    assert ack["model"] == "gpt-4o-mini-transcribe"
    assert captured["kwargs"]["candidates"][0]["api_key"] == "sk-test-secret"
    assert captured["kwargs"]["candidates"][0]["transport"] == "openai_audio"
    runtime_processor = captured["processor_inits"][-1]
    assert runtime_processor["llm_config"]["mode"] == "local"
    assert runtime_processor["llm_config"]["backend"] == f"openai_{byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL}"
    assert runtime_processor["providers"] == [
        {
            "id": byok.BYOK_LLM_PROVIDER_ID,
            "name": "BYOK OpenAI",
            "type": "openai",
            "base_url": byok.DEFAULT_OPENAI_BASE_URL,
            "model": byok.DEFAULT_BYOK_OPENAI_CHAT_MODEL,
            "api_key": "sk-test-secret",
            "enabled": True,
            "timeout_seconds": byok.DEFAULT_BYOK_OPENAI_TIMEOUT_SECONDS,
            "session_scoped": True,
        }
    ]


def test_transcripts_ws_byok_token_does_not_override_whisper_primary(monkeypatch):
    import lct_python_backend.services.byok_session_store as byok

    byok._BYOK_SESSIONS.clear()
    monkeypatch.setattr(byok, "validate_byok_api_key", AsyncMock(return_value=None))
    session_payload = asyncio.run(
        byok.create_byok_session(
            provider="openai_audio",
            api_key="sk-test-secret",
            scopes=[byok.BYOK_SCOPE_STT_LIVE, byok.BYOK_SCOPE_LLM_LIVE],
        )
    )

    captured = {}

    def runtime_factory(**kwargs):
        captured["kwargs"] = kwargs

        class DummyRuntime:
            stt_mode = "backend_ws"

            def __init__(self):
                primary_candidate = kwargs["candidates"][0]
                self.provider = primary_candidate.get("provider")
                self.transport = primary_candidate.get("transport")
                self.supports_diarization = bool(primary_candidate.get("supports_diarization"))
                self.model = primary_candidate.get("model")
                self.sample_rate_hz = kwargs.get("sample_rate_hz", 16000)
                self.timeout_seconds = kwargs.get("timeout_seconds", 30.0)

            def is_ready(self):
                return True

            def get_last_runtime_metadata(self):
                return {}

            async def start(self):
                return None

            async def push_audio_chunk(self, _chunk):
                return []

            async def flush(self):
                return []

            async def close(self):
                return None

        return DummyRuntime()

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "live_fallback_priority": ["remote_whisper", "openai_audio"],
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "has_api_key": True,
                }
            },
        },
        runtime_factory=runtime_factory,
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-byok-whisper-primary",
                "provider": "whisper",
                "byok_session_token": session_payload["byok_session_token"],
                "store_audio": False,
            }
        )
        ack = ws.receive_json()

    assert ack["type"] == "session_ack"
    assert ack["provider"] == "whisper"
    assert ack["transport"] == "backend_http"
    assert captured["kwargs"]["candidates"][0]["provider"] == "whisper"
    assert captured["kwargs"]["candidates"][0]["route_id"] == "configured_provider"
    assert captured["kwargs"]["candidates"][1]["provider"] == "openai_audio"


def test_transcripts_ws_background_refinement_persists_speaker_segments_with_window_timestamps(monkeypatch):
    persisted_events = []
    materialized = []
    processor_calls = {"final": [], "flush": 0}
    source_utterance_id = uuid.uuid4()

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted_events.append((event_type, text, payload))
        if event_type == "final":
            return SimpleNamespace(utterance_id=source_utterance_id)
        return None

    class DummyRealtimeRuntime:
        stt_mode = "openai_realtime"
        provider = "openai_audio"
        transport = "openai_realtime"
        supports_diarization = False
        model = "gpt-4o-mini-transcribe"

        def __init__(self, **kwargs):
            self.sample_rate_hz = kwargs.get("sample_rate_hz", 16000)
            self.timeout_seconds = kwargs.get("timeout_seconds", 30.0)
            self._started = False

        def is_ready(self):
            return self._started

        def get_last_runtime_metadata(self):
            return {"provider": self.provider, "transport": self.transport}

        async def start(self):
            self._started = True

        async def push_audio_chunk(self, _chunk):
            return [
                {
                    "event_type": "final",
                    "text": "hello from realtime refinement",
                        "metadata": {
                            "provider": self.provider,
                            "transport": self.transport,
                            "sample_rate_hz": 24000,
                        },
                        "timestamps": {"start": 1.0, "end": 2.0},
                        "_wav_payload": pcm16le_to_wav(b"\x00\x00" * 240, sample_rate_hz=24000),
                    },
                ]

        async def flush(self):
            return []

        async def close(self):
            self._started = False

    async def fake_refine(*args, **kwargs):
        return {
            "ok": True,
            "provider": "openai_audio",
            "transport": "openai_audio",
            "model": "gpt-4o-transcribe-diarize",
            "latency_ms": 120.0,
            "segments_count": 1,
            "segments": [
                {
                    "speaker": "SPEAKER_00",
                    "text": "hello from realtime refinement",
                    "start": 0.0,
                    "end": 1.0,
                }
            ],
        }

    async def fake_materialize(**kwargs):
        materialized.append(kwargs)
        return {
            "persisted_segments": 1,
            "updated_utterances": 1,
            "ambiguous_utterances": 0,
            "window_start": kwargs.get("window_timestamps", {}).get("start"),
            "window_end": kwargs.get("window_timestamps", {}).get("end"),
        }

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "sk-test",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                }
            },
            "live_fallback_priority": ["openai_audio", "remote_whisper"],
        },
        processor_cls=build_processor_class(processor_calls),
        runtime_factory=lambda **kwargs: DummyRealtimeRuntime(**kwargs),
        persist_side_effect=fake_persist,
    )
    import lct_python_backend.services.stt.stt_ws_session as ws_mod

    monkeypatch.setattr(ws_mod, "transcribe_wav_stt_candidate", fake_refine)
    monkeypatch.setattr(ws_mod, "persist_speaker_refinement", fake_materialize)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-realtime-refinement-materialize",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["stt_mode"] == "openai_realtime"

        ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})
        message = ws.receive_json()
        assert message["type"] == "transcript_final"

        ws.send_json({"type": "final_flush"})
        flush_ack = None
        flush_complete = None
        for _ in range(8):
            next_message = ws.receive_json()
            if next_message["type"] == "flush_ack":
                flush_ack = next_message
            if next_message["type"] == "flush_complete":
                flush_complete = next_message
            if flush_ack is not None and flush_complete is not None:
                break
        assert flush_ack["type"] == "flush_ack"
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.1)
    assert materialized
    assert materialized[-1]["window_timestamps"] == {"start": 1.0, "end": 2.0}
    assert materialized[-1]["source_utterance_id"] == str(source_utterance_id)
    assert materialized[-1]["segments"][0]["speaker"] == "SPEAKER_00"


def test_transcripts_ws_graph_status_includes_queue_and_generation_metrics(monkeypatch):
    monkeypatch.setattr(transcript_mod, "accumulate_text_json_local_indexed", _acc_idx_complete_all)
    monkeypatch.setattr(
        transcript_mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": input_text,
                "Incomplete_segment": "",
                "decision": "stop_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )
    monkeypatch.setattr(
        transcript_mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: (
            [{"node_name": "node-1", "summary": mod_input[:20]}],
            "online_gemini-3-flash-preview",
        ),
    )

    client = build_test_client(monkeypatch, processor_cls=TranscriptProcessor)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-graph-metrics",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "transcript_final", "text": "graph me now"})

        graph_statuses = []
        snapshot_seen = False
        for _ in range(6):
            message = ws.receive_json()
            if message["type"] == "processing_status" and message.get("context", {}).get("stage") == "graph":
                graph_statuses.append(message)
            if message["type"] == "existing_json":
                snapshot_seen = True

        assert snapshot_seen is True
        completed_status = next(
            status
            for status in graph_statuses
            if status.get("context", {}).get("phase") == "completed"
        )
        assert completed_status["context"]["queue_wait_ms"] is not None
        assert completed_status["context"]["generation_ms"] is not None
        assert completed_status["context"]["total_update_ms"] is not None
        assert completed_status["context"]["trigger"] == "count_threshold"


def test_transcripts_ws_emits_draft_then_finalized_graph_patch(monkeypatch):
    monkeypatch.setattr(transcript_mod, "accumulate_text_json_local_indexed", _acc_idx_complete_all)
    monkeypatch.setattr(
        transcript_mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": input_text,
                "Incomplete_segment": "",
                "decision": "stop_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )
    monkeypatch.setattr(
        transcript_mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: (
            [{"id": "final-node-1", "node_name": "final node", "summary": mod_input[:20]}],
            "online_gemini-3-flash-preview",
        ),
    )

    client = build_test_client(monkeypatch, processor_cls=TranscriptProcessor)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-draft-graph-patch",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "transcript_partial", "text": "this is a live draft node"})
        draft_patch = ws.receive_json()
        assert draft_patch["type"] == "graph_patch"
        assert draft_patch["data"]["kind"] == "draft"
        draft_node_id = draft_patch["data"]["nodes"][0]["id"]

        ws.send_json({"type": "transcript_final", "text": "this is a live draft node"})

        finalized_patch = None
        snapshot_seen = False
        for _ in range(6):
            message = ws.receive_json()
            if message["type"] == "graph_patch" and message["data"].get("kind") == "finalized":
                finalized_patch = message
            if message["type"] == "existing_json":
                snapshot_seen = True

    assert finalized_patch is not None
    assert draft_node_id in finalized_patch["data"]["remove_node_ids"]
    assert snapshot_seen is True


def test_transcripts_ws_persists_canonical_graph_on_finalized_patch(monkeypatch):
    monkeypatch.setattr(transcript_mod, "accumulate_text_json_local_indexed", _acc_idx_complete_all)
    persisted = []

    async def fake_graph_persist(**kwargs):
        persisted.append(kwargs)
        return len(kwargs.get("existing_json") or [])

    monkeypatch.setattr(
        transcript_mod,
        "accumulate_text_json",
        lambda input_text, **kwargs: (
            {
                "Completed_segment": input_text,
                "Incomplete_segment": "",
                "decision": "stop_accumulating",
            },
            "online_gemini-3-flash-preview",
        ),
    )
    monkeypatch.setattr(
        transcript_mod,
        "generate_lct_json",
        lambda mod_input, **kwargs: (
            [{"id": str(uuid.uuid4()), "node_name": "stable node", "summary": mod_input[:20]}],
            "online_gemini-3-flash-preview",
        ),
    )
    client = build_test_client(monkeypatch, processor_cls=TranscriptProcessor)
    import lct_python_backend.services.stt.stt_ws_session as ws_mod
    monkeypatch.setattr(ws_mod, "persist_live_graph_snapshot", fake_graph_persist)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-canonical-graph-persist",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "transcript_final", "text": "persist me canonically"})

        for _ in range(6):
            message = ws.receive_json()
            if message["type"] == "existing_json":
                break

        ws.send_json({"type": "final_flush"})
        flush_ack = None
        flush_complete = None
        for _ in range(8):
            message = ws.receive_json()
            if message["type"] == "flush_ack":
                flush_ack = message
            if message["type"] == "flush_complete":
                flush_complete = message
            if flush_ack is not None and flush_complete is not None:
                break
        assert flush_ack["type"] == "flush_ack"
        assert flush_complete["type"] == "flush_complete"

    time.sleep(0.1)
    assert persisted
    latest = persisted[-1]
    assert latest["source_type"] == "live_audio"
    assert len(latest["existing_json"]) == 1


def test_transcripts_ws_flush_complete_is_not_blocked_by_slow_processor_flush(monkeypatch):
    processor_calls = {"final": [], "flush": 0}

    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls, flush_delay=0.35),
    )

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
        started_at = time.perf_counter()
        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        flush_complete = ws.receive_json()
        complete_elapsed_ms = (time.perf_counter() - started_at) * 1000.0

        assert flush_ack["type"] == "flush_ack"
        assert flush_complete["type"] == "flush_complete"
        assert complete_elapsed_ms < 250.0

    time.sleep(0.4)
    assert processor_calls["final"] == [("quick final segment", None)]


def test_transcripts_ws_pong_echoes_client_timestamp(monkeypatch):
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-ping",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "ping", "client_ts_ms": 123456789})
        pong = ws.receive_json()

    assert pong["type"] == "pong"
    assert pong["client_ts_ms"] == 123456789
    assert isinstance(pong["server_ts_ms"], int)
    assert pong["server_ts_ms"] > 0


def test_transcripts_ws_session_ack_includes_live_fallback_candidates(monkeypatch):
    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://localhost:5092/v1/audio/transcriptions",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "live_allow_text_only_fallback": False,
            "live_fallback_priority": [
                "openai_audio",
                "remote_whisper",
                "external_http",
                "openrouter_audio",
            ],
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                },
                "openrouter_audio": {
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api",
                    "model": "google/gemini-2.5-flash",
                    "api_key": "or-secret",
                },
            },
        },
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-fallback-candidates",
                "provider": "parakeet",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()

    assert ack["type"] == "session_ack"
    assert ack["transport"] == "backend_http"
    assert ack["model"] is None
    assert ack["model_source"] == "server_default"
    assert ack["supports_diarization"] is False
    assert ack["degraded"] is False
    assert ack["stt_ready"] is True
    assert ack["provider_http_url"] == "http://localhost:5092/v1/audio/transcriptions"
    assert ack["fallback_candidates"] == [
        {
            "route_id": "openai_audio",
            "provider": "openai_audio",
            "transport": "openai_audio",
            "reason": "fallback_openai_audio",
            "degraded": False,
        },
        {
            "route_id": "remote_whisper",
            "provider": "whisper",
            "transport": "backend_http",
            "reason": "fallback_remote_whisper",
            "degraded": False,
        },
    ]


def test_transcripts_ws_requires_session_meta_before_audio(monkeypatch):
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.2)})
        error = ws.receive_json()

        assert error["type"] == "error"
        assert error["code"] == "protocol_missing_session_meta"
        assert error["detail"] == "session_meta must be sent first"
        assert error["fatal"] is False
        assert error["context"]["stage"] == "audio_chunk"
        assert error["context"]["expected_message_type"] == "session_meta"

        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-after-audio-error",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()

    assert ack["type"] == "session_ack"


def test_transcripts_ws_rejects_malformed_json_with_structured_error(monkeypatch):
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_text("{not valid json")
        error = ws.receive_json()

        assert error["type"] == "error"
        assert error["code"] == "invalid_json"
        assert error["detail"].startswith("Malformed JSON websocket payload:")
        assert error["fatal"] is False
        assert error["context"]["stage"] == "websocket_message"
        assert error["context"]["payload_preview"] == "{not valid json"

        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-after-json-error",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()

    assert ack["type"] == "session_ack"


def test_transcripts_ws_rejects_unsupported_message_type(monkeypatch):
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-unsupported-message",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "mystery_event", "payload": "???"})
        error = ws.receive_json()

    assert error["type"] == "error"
    assert error["code"] == "unsupported_message_type"
    assert error["detail"] == "Unsupported websocket message type: mystery_event"
    assert error["fatal"] is False
    assert error["context"]["stage"] == "websocket_message"
    assert error["context"]["received_message_type"] == "mystery_event"


def test_transcripts_ws_surfaces_runtime_start_failure_after_ack(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    class FailingRealtimeRuntime:
        stt_mode = "openai_realtime"
        provider = "openai_audio"
        transport = "openai_realtime"
        supports_diarization = False
        model = "gpt-4o-mini-transcribe"

        def is_ready(self):
            return False

        async def start(self):
            raise RuntimeError("Missing required parameter: 'session.type'.")

        async def push_audio_chunk(self, _chunk):
            return []

        async def flush(self):
            return []

        async def close(self):
            return None

    class FallbackHttpRuntime:
        stt_mode = "backend_http"
        provider = "openai_audio"
        transport = "backend_http"
        supports_diarization = False
        model = "gpt-4o-mini-transcribe"

        def __init__(self):
            self._ready = False

        def is_ready(self):
            return self._ready

        async def start(self):
            self._ready = True

        async def push_audio_chunk(self, _chunk):
            return []

        async def flush(self):
            return []

        async def close(self):
            self._ready = False

    def runtime_factory(**kwargs):
        if kwargs.get("prefer_streaming"):
            return FailingRealtimeRuntime()
        return FallbackHttpRuntime()

    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "sk-test",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                }
            },
            "live_fallback_priority": ["openai_audio", "remote_whisper"],
        },
        processor_cls=build_processor_class(processor_calls),
        runtime_factory=runtime_factory,
        persist_side_effect=fake_persist,
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "session-runtime-start-failure",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = ws.receive_json()
        error = ws.receive_json()

    assert ack["type"] == "session_ack"
    assert ack["stt_mode"] == "backend_http"
    assert ack["transport"] == "backend_http"
    assert ack["stt_ready"] is True
    assert ack["runtime_error"] == "Missing required parameter: 'session.type'."
    assert error["type"] == "stt_provider_error"
    assert error["code"] == "stt_runtime_start_failed"
    assert error["detail"] == "Missing required parameter: 'session.type'."
    assert error["level"] == "warning"
    assert error["fatal"] is False
    assert error["context"]["stage"] == "stt_setup"
    assert error["context"]["stt_mode"] == "backend_http"
    assert error["context"]["fallback_ready"] is True

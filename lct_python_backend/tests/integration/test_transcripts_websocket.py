import time
import uuid

from lct_python_backend.tests.integration.transcripts_test_support import (
    build_processor_class,
    build_test_client,
    pcm_audio_base64,
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
        assert first_msg["type"] == "transcript_partial"
        assert second_msg["type"] == "transcript_final"
        assert "quick transcript" in second_msg["text"]

        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"

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


def test_transcripts_ws_flush_ack_not_blocked_by_processor_flush(monkeypatch):
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
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0

        assert flush_ack["type"] == "flush_ack"
        assert elapsed_ms < 250.0

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
                    "model": "gpt-4o-transcribe-diarize",
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

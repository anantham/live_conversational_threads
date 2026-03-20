import json

import pytest

from lct_python_backend.services.stt_live_runtime import (
    HttpLiveSttRuntime,
    build_live_stt_runtime,
)
from lct_python_backend.services.stt_openai_realtime import (
    DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
    OpenAIRealtimeTranscriptionRuntime,
    resample_pcm16_mono,
)


class _DummyRealtimeSocket:
    def __init__(self):
        self.sent_payloads = []
        self.closed = False

    async def send(self, payload):
        self.sent_payloads.append(payload)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


def test_build_live_stt_runtime_prefers_openai_realtime_for_streaming_candidate():
    runtime = build_live_stt_runtime(
        provider="openai_audio",
        http_url="https://api.openai.com/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=1.2,
        timeout_seconds=30.0,
        model="gpt-4o-mini-transcribe",
        language="en",
        candidates=[
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "base_url": "https://api.openai.com",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "api_key": "sk-test",
                "model": "gpt-4o-mini-transcribe",
                "supports_diarization": True,
                "supports_realtime_streaming": True,
                "request_diarization": False,
            }
        ],
        session_id="session-1",
        conversation_id="conversation-1",
        prefer_streaming=True,
    )

    assert isinstance(runtime, OpenAIRealtimeTranscriptionRuntime)
    assert runtime.transport == "openai_realtime"


def test_build_live_stt_runtime_uses_http_runtime_when_streaming_disabled():
    runtime = build_live_stt_runtime(
        provider="openai_audio",
        http_url="https://api.openai.com/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=1.2,
        timeout_seconds=30.0,
        model="gpt-4o-mini-transcribe",
        language="en",
        candidates=[
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "base_url": "https://api.openai.com",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "api_key": "sk-test",
                "model": "gpt-4o-mini-transcribe",
                "supports_diarization": True,
                "supports_realtime_streaming": True,
                "request_diarization": False,
            }
        ],
        session_id="session-1",
        conversation_id="conversation-1",
        prefer_streaming=False,
    )

    assert isinstance(runtime, HttpLiveSttRuntime)
    assert runtime.transport == "openai_audio"


def test_resample_pcm16_mono_upsamples_to_24khz():
    pcm_16k = b"\x00\x00" * 1600
    pcm_24k = resample_pcm16_mono(pcm_16k, input_rate_hz=16000, output_rate_hz=24000)

    assert len(pcm_24k) == len(pcm_16k) * 3 // 2


@pytest.mark.asyncio
async def test_openai_realtime_runtime_start_sends_transcription_session_type(monkeypatch):
    runtime = OpenAIRealtimeTranscriptionRuntime(
        provider="openai_audio",
        api_key="sk-test",
        model="gpt-4o-mini-transcribe",
        base_url="https://api.openai.com",
        sample_rate_hz=16000,
        session_id="session-1",
        conversation_id="conversation-1",
    )
    dummy_socket = _DummyRealtimeSocket()

    async def fake_connect(*args, **kwargs):
        return dummy_socket

    async def fake_receiver_loop():
        await runtime._handle_server_event(
            {
                "type": "session.updated",
                "session": {"type": "transcription"},
            }
        )

    monkeypatch.setattr("lct_python_backend.services.stt_openai_realtime.websockets.connect", fake_connect)
    monkeypatch.setattr(runtime, "_receiver_loop", fake_receiver_loop)

    await runtime.start()

    assert dummy_socket.sent_payloads
    payload = json.loads(dummy_socket.sent_payloads[0])
    assert payload["type"] == "session.update"
    assert payload["session"]["type"] == "transcription"

    await runtime.close()


@pytest.mark.asyncio
async def test_openai_realtime_runtime_start_fails_fast_on_startup_error(monkeypatch):
    runtime = OpenAIRealtimeTranscriptionRuntime(
        provider="openai_audio",
        api_key="sk-test",
        model="gpt-4o-mini-transcribe",
        base_url="https://api.openai.com",
        sample_rate_hz=16000,
        session_id="session-1",
        conversation_id="conversation-1",
    )
    dummy_socket = _DummyRealtimeSocket()

    async def fake_connect(*args, **kwargs):
        return dummy_socket

    async def fake_receiver_loop():
        await runtime._handle_server_event(
            {
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "Missing required parameter: 'session.type'.",
                },
            }
        )

    monkeypatch.setattr("lct_python_backend.services.stt_openai_realtime.websockets.connect", fake_connect)
    monkeypatch.setattr(runtime, "_receiver_loop", fake_receiver_loop)

    with pytest.raises(RuntimeError, match="Missing required parameter: 'session.type'\\."):
        await runtime.start()

    await runtime.close()


@pytest.mark.asyncio
async def test_openai_realtime_runtime_emits_partial_and_final_events_from_server_messages():
    runtime = OpenAIRealtimeTranscriptionRuntime(
        provider="openai_audio",
        api_key="sk-test",
        model="gpt-4o-mini-transcribe",
        base_url="https://api.openai.com",
        sample_rate_hz=16000,
        session_id="session-1",
        conversation_id="conversation-1",
    )

    runtime._pending_commit_start_sample = 0
    runtime._provider_samples_sent = 240
    runtime._pending_commit_pcm.extend(b"\x00\x00" * 240)
    await runtime._handle_server_event({"type": "input_audio_buffer.committed", "item_id": "item-1"})
    await runtime._handle_server_event(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item-1",
            "delta": "Hello",
        }
    )
    await runtime._handle_server_event(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-1",
            "transcript": "Hello world",
        }
    )

    events = runtime._drain_events_nowait()
    assert events[0]["event_type"] == "partial"
    assert events[0]["text"] == "Hello"
    assert events[1]["event_type"] == "final"
    assert events[1]["text"] == "Hello world"
    assert events[1]["metadata"]["sample_rate_hz"] == DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ
    assert events[1]["timestamps"] == {"start": 0.0, "end": 0.01}
    assert isinstance(events[1]["_wav_payload"], (bytes, bytearray))

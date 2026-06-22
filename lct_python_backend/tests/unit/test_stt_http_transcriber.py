import base64
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import numpy as np
import pytest

from lct_python_backend.services import stt_http_transcriber as mod
from lct_python_backend.services.stt_http_transcriber import (
    RealtimeHttpSttSession,
    decode_audio_base64,
    extract_diarized_segments,
    extract_transcript_text,
    pcm16le_to_wav,
    smoke_test_stt_candidate,
    transcribe_wav_stt_candidate,
)


# ---------------------------------------------------------------------------
# Mock torch module for tests (silero_vad needs torch but we don't install it)
# ---------------------------------------------------------------------------
_mock_torch = MagicMock()
_mock_torch.from_numpy = lambda x: x  # Pass numpy arrays through


@pytest.fixture(autouse=True)
def _allow_egress(monkeypatch):
    """Several tests here exercise the CLOUD STT fallback paths (openai_audio /
    openrouter_audio) on purpose; the local-only egress guard (default ON)
    would block them. Egress policy itself is covered by test_egress_guard.py."""
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")


# ---------------------------------------------------------------------------
# Existing tests (pure functions)
# ---------------------------------------------------------------------------
def test_decode_audio_base64_valid_and_invalid():
    encoded = base64.b64encode(b"\x00\x01\x02").decode("ascii")
    assert decode_audio_base64(encoded) == b"\x00\x01\x02"

    with pytest.raises(ValueError):
        decode_audio_base64("not base64 @@@")


def test_extract_transcript_text_handles_common_shapes():
    assert extract_transcript_text({"text": "hello"}) == "hello"
    assert extract_transcript_text({"data": {"transcript": "nested"}}) == "nested"
    assert (
        extract_transcript_text({"choices": [{"message": {"content": "ignored"}, "text": "choice"}]})
        == "choice"
    )


def test_pcm16le_to_wav_generates_valid_header():
    wav_bytes = pcm16le_to_wav(b"\x00\x00" * 64, sample_rate_hz=16000)
    assert wav_bytes.startswith(b"RIFF")
    assert b"WAVE" in wav_bytes[:24]


# ---------------------------------------------------------------------------
# extract_diarized_segments
# ---------------------------------------------------------------------------
def test_extract_diarized_segments_returns_none_for_non_dict():
    assert extract_diarized_segments("not a dict") is None
    assert extract_diarized_segments(None) is None
    assert extract_diarized_segments(42) is None


def test_extract_diarized_segments_returns_none_for_missing_or_empty_speakers():
    assert extract_diarized_segments({"text": "hello", "speakers": None}) is None
    assert extract_diarized_segments({"text": "hello", "speakers": []}) is None


def test_extract_diarized_segments_returns_none_for_error_response():
    payload = {
        "text": "hello",
        "speakers": [{"error": "module 'whisperx' has no attribute 'DiarizationPipeline'"}],
    }
    assert extract_diarized_segments(payload) is None


def test_extract_diarized_segments_returns_segments_for_valid_response():
    payload = {
        "text": "Hello there. Hi, how are you.",
        "speakers": [
            {"speaker": "SPEAKER_00", "start": 0.031, "end": 1.5, "text": "Hello there."},
            {"speaker": "SPEAKER_01", "start": 2.0, "end": 4.0, "text": "Hi, how are you."},
        ],
    }
    result = extract_diarized_segments(payload)
    assert result is not None
    assert len(result) == 2
    assert result[0]["speaker"] == "SPEAKER_00"
    assert result[0]["text"] == "Hello there."
    assert result[0]["start"] == 0.031
    assert result[1]["speaker"] == "SPEAKER_01"
    assert result[1]["text"] == "Hi, how are you."


def test_extract_diarized_segments_skips_invalid_entries():
    payload = {
        "text": "hello",
        "speakers": [
            {"speaker": "SPEAKER_00", "text": "valid"},
            {"speaker": "", "text": "no speaker"},
            {"speaker": "SPEAKER_01"},
            {"not_a_segment": True},
        ],
    }
    result = extract_diarized_segments(payload)
    assert result is not None
    assert len(result) == 1
    assert result[0]["speaker"] == "SPEAKER_00"


# ---------------------------------------------------------------------------
# Helper: create session with pooling/VAD flags overridden
# ---------------------------------------------------------------------------
def _make_session(*, pool_enabled=False, vad_enabled=False, vad_model=None, **kwargs):
    """Create a RealtimeHttpSttSession with feature flags overridden.

    When vad_model is provided, also mocks the torch module so _feed_vad can run.
    """
    defaults = dict(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )
    defaults.update(kwargs)

    with patch.object(mod, "STT_HTTP_POOL_ENABLED", pool_enabled), \
         patch.object(mod, "STT_VAD_ENABLED", vad_enabled), \
         patch.object(mod, "_check_silero_vad", return_value=vad_model is not None), \
         patch.object(mod, "_create_vad_model", return_value=vad_model), \
         patch.dict(sys.modules, {"torch": _mock_torch} if vad_model is not None else {}):
        session = RealtimeHttpSttSession(**defaults)

    return session


def _pcm_bytes(seconds: float, sample_rate: int = 16000) -> bytes:
    """Generate silent PCM16LE bytes for the given duration."""
    num_samples = int(sample_rate * seconds)
    return b"\x00\x00" * num_samples


# ---------------------------------------------------------------------------
# Fixed-interval chunking (existing behavior, VAD disabled)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_realtime_http_session_pushes_and_flushes_chunks():
    session = _make_session()
    session._transcribe_pcm = AsyncMock(return_value=("chunk text", None))

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "chunk text"
    assert result["is_final"] is False
    assert result["timestamps"] == {"start": 0.0, "end": 0.25}

    session._transcribe_pcm = AsyncMock(return_value=("final text", None))
    await session.push_audio_chunk(b"\x00\x01" * 2000)
    flush_result = await session.flush()
    assert flush_result is not None
    assert flush_result["text"] == "final text"
    assert flush_result["is_final"] is True
    assert flush_result["timestamps"] == {"start": 0.25, "end": 0.375}


@pytest.mark.asyncio
async def test_fixed_interval_does_not_flush_below_threshold():
    session = _make_session(chunk_seconds=1.0, initial_chunk_seconds=1.0)
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    # Push 0.5s of audio (below 1.0s threshold)
    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is None
    session._transcribe_pcm.assert_not_called()


@pytest.mark.asyncio
async def test_metadata_includes_vad_and_diarize_flags():
    session = _make_session()
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is not None
    assert result["metadata"]["vad_enabled"] is False
    assert "diarize_enabled" in result["metadata"]


@pytest.mark.asyncio
async def test_initial_chunk_seconds_only_applies_before_first_success():
    session = _make_session(chunk_seconds=1.2, initial_chunk_seconds=0.5)
    session._transcribe_pcm = AsyncMock(side_effect=[("first", None), ("second", None)])

    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is not None
    assert result["text"] == "first"

    second_result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert second_result is None

    third_result = await session.push_audio_chunk(_pcm_bytes(0.7))
    assert third_result is not None
    assert third_result["text"] == "second"


# ---------------------------------------------------------------------------
# Diarization wiring
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_transcribe_buffer_includes_segments_when_present():
    session = _make_session()
    segments = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0, "text": "Hello"},
        {"speaker": "SPEAKER_01", "start": 1.0, "end": 2.0, "text": "Hi"},
    ]
    session._transcribe_pcm = AsyncMock(return_value=("Hello Hi", segments))

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "Hello Hi"
    assert result["segments"] == segments


@pytest.mark.asyncio
async def test_diarize_form_field_sent_when_enabled():
    session = _make_session(pool_enabled=False)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {
        "text": "hello",
        "speakers": [{"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0, "text": "hello"}],
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_DIARIZE_ENABLED", True), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text, segments = await session._transcribe_pcm(_pcm_bytes(0.1))

    assert text == "hello"
    assert segments is not None
    assert len(segments) == 1

    form_data = mock_client.post.call_args.kwargs.get("data", {})
    assert form_data.get("diarize") == "true"


@pytest.mark.asyncio
async def test_diarize_false_sent_when_disabled():
    session = _make_session(pool_enabled=False)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {"text": "hello", "speakers": None}
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_DIARIZE_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text, segments = await session._transcribe_pcm(_pcm_bytes(0.1))

    assert text == "hello"
    assert segments is None

    form_data = mock_client.post.call_args.kwargs.get("data", {})
    assert form_data.get("diarize") == "false"


@pytest.mark.asyncio
async def test_primary_backend_candidate_can_fall_back_to_openai_audio():
    session = _make_session(
        pool_enabled=False,
        provider="whisper",
        http_url="http://primary.example/api/transcribe",
        candidates=[
            {
                "provider": "whisper",
                "transport": "backend_http",
                "http_url": "http://primary.example/api/transcribe",
                "supports_diarization": True,
                "degraded": False,
            },
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "api_key": "sk-openai-secret",
                "model": "gpt-4o-mini-transcribe",
                "supports_diarization": True,
                "degraded": False,
                "reason": "fallback_openai_audio",
                "request_diarization": False,
            },
        ],
    )

    primary_response = MagicMock()
    primary_response.status_code = 503
    primary_response.text = "gpu busy"
    primary_response.headers = {"content-type": "application/json"}
    primary_response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "gpu busy",
        request=MagicMock(),
        response=primary_response,
    )

    openai_response = MagicMock()
    openai_response.status_code = 200
    openai_response.headers = {"content-type": "application/json"}
    openai_response.json.return_value = {
        "text": "speaker one speaker two",
        "segments": [
            {"speaker": "speaker_0", "start": 0.0, "end": 0.2, "text": "speaker one"},
            {"speaker": "speaker_1", "start": 0.2, "end": 0.5, "text": "speaker two"},
        ],
    }
    openai_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=[primary_response, openai_response])
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_DIARIZE_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is not None
    assert result["text"] == "speaker one speaker two"
    assert "segments" not in result
    assert result["metadata"]["fallback_used"] is True
    assert result["metadata"]["fallback_from"] == "whisper"
    assert result["metadata"]["fallback_to"] == "openai_audio"
    assert result["metadata"]["provider"] == "openai_audio"
    assert result["metadata"]["supports_diarization"] is True

    primary_form = mock_client.post.call_args_list[0].kwargs["data"]
    openai_form = mock_client.post.call_args_list[1].kwargs["data"]
    assert primary_form["diarize"] == "false"
    assert openai_form["response_format"] == "json"
    assert "chunking_strategy" not in openai_form
    assert mock_client.post.call_args_list[1].kwargs["headers"]["Authorization"] == "Bearer sk-openai-secret"
    assert result["metadata"]["candidate_count"] == 2
    assert result["metadata"]["attempt_count"] == 2
    assert result["metadata"]["stt_flow_started_at"].endswith("Z")
    assert result["metadata"]["stt_flow_completed_at"].endswith("Z")
    assert result["metadata"]["stt_flow_ms"] >= 0


@pytest.mark.asyncio
async def test_empty_openai_transcript_does_not_fall_through_to_whisper():
    session = _make_session(
        pool_enabled=False,
        provider="whisper",
        http_url="http://primary.example/api/transcribe",
        candidates=[
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "api_key": "sk-openai-secret",
                "model": "gpt-4o-mini-transcribe",
                "supports_diarization": True,
                "degraded": False,
                "reason": "fallback_openai_audio",
                "request_diarization": False,
            },
            {
                "provider": "whisper",
                "transport": "backend_http",
                "http_url": "http://primary.example/api/transcribe",
                "supports_diarization": True,
                "degraded": False,
                "reason": "configured_provider",
            },
        ],
    )

    openai_response = MagicMock()
    openai_response.status_code = 200
    openai_response.headers = {"content-type": "application/json"}
    openai_response.json.return_value = {"text": ""}
    openai_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=openai_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_DIARIZE_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is None
    assert mock_client.post.call_count == 1
    assert session.get_last_runtime_metadata()["empty_transcript"] is True


@pytest.mark.asyncio
async def test_timeout_opens_circuit_and_skips_repeat_attempts():
    session = _make_session(
        pool_enabled=False,
        provider="whisper",
        http_url="http://primary.example/api/transcribe",
        candidates=[
            {
                "provider": "whisper",
                "transport": "backend_http",
                "http_url": "http://primary.example/api/transcribe",
                "supports_diarization": True,
                "degraded": False,
                "reason": "configured_provider",
            }
        ],
    )

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("Timed out waiting for STT provider response."))
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_CIRCUIT_TIMEOUT_TTL_SECONDS", 30.0), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(RuntimeError, match="All live STT candidates failed"):
            await session.push_audio_chunk(_pcm_bytes(0.5))

        with pytest.raises(RuntimeError, match="circuit_open"):
            await session.push_audio_chunk(_pcm_bytes(0.5))

    assert mock_client.post.call_count == 1


@pytest.mark.asyncio
async def test_openrouter_candidate_posts_chat_completion_payload():
    session = _make_session(
        pool_enabled=False,
        provider="whisper",
        http_url="http://unused.example/api/transcribe",
        language="en",
        candidates=[
            {
                "provider": "openrouter_audio",
                "transport": "openrouter_audio",
                "http_url": "https://openrouter.ai/api/v1/chat/completions",
                "api_key": "or-secret",
                "model": "google/gemini-2.5-flash",
                "supports_diarization": False,
                "degraded": True,
            }
        ],
    )

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "openrouter transcript"}}]
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is not None
    assert result["text"] == "openrouter transcript"
    assert result["metadata"]["provider"] == "openrouter_audio"
    assert result["metadata"]["degraded"] is True
    assert result["metadata"]["supports_diarization"] is False

    request_kwargs = mock_client.post.call_args.kwargs
    request_payload = request_kwargs["json"]
    assert request_kwargs["headers"]["Authorization"] == "Bearer or-secret"
    assert request_payload["model"] == "google/gemini-2.5-flash"
    assert request_payload["stream"] is False
    assert request_payload["messages"][0]["content"][0]["text"].endswith("The audio language is en.")
    assert request_payload["messages"][0]["content"][1]["type"] == "input_audio"
    assert request_payload["messages"][0]["content"][1]["input_audio"]["format"] == "wav"


@pytest.mark.asyncio
async def test_smoke_test_stt_candidate_returns_ready_result():
    candidate = {
        "provider": "openai_audio",
        "transport": "openai_audio",
        "route_id": "openai_audio_manual_test",
        "http_url": "https://api.openai.com/v1/audio/transcriptions",
        "base_url": "https://api.openai.com",
        "api_key": "sk-test",
        "model": "gpt-4o-mini-transcribe",
        "supports_diarization": True,
        "degraded": False,
        "request_diarization": False,
    }

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {
        "text": "hello from smoke test",
        "segments": [{"speaker": "speaker_0", "start": 0.0, "end": 0.4, "text": "hello"}],
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_HTTP_POOL_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await smoke_test_stt_candidate(candidate, sample_rate_hz=16000, timeout_seconds=12.0)

    assert result["ok"] is True
    assert result["status"] == "ready"
    assert result["provider"] == "openai_audio"
    assert result["latency_ms"] >= 0
    assert result["segments_count"] == 0
    assert result["transcript_preview"] == "hello from smoke test"
    assert result["warning"] is None


@pytest.mark.asyncio
async def test_transcribe_wav_stt_candidate_supports_background_openai_diarization():
    candidate = {
        "provider": "openai_audio",
        "transport": "openai_audio",
        "route_id": "openai_audio_diarize_background",
        "http_url": "https://api.openai.com/v1/audio/transcriptions",
        "base_url": "https://api.openai.com",
        "api_key": "sk-test",
        "model": "gpt-4o-transcribe-diarize",
        "supports_diarization": True,
        "degraded": False,
        "request_diarization": True,
    }

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {
        "text": "hello from refinement",
        "segments": [{"speaker": "speaker_0", "start": 0.0, "end": 0.4, "text": "hello"}],
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_HTTP_POOL_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await transcribe_wav_stt_candidate(
            candidate,
            wav_payload=pcm16le_to_wav(_pcm_bytes(0.5)),
            sample_rate_hz=16000,
            timeout_seconds=12.0,
        )

    assert result["ok"] is True
    assert result["segments_count"] == 1
    assert result["diarization_requested"] is True
    request_form = mock_client.post.call_args.kwargs["data"]
    assert request_form["response_format"] == "diarized_json"
    assert request_form["chunking_strategy"] == "auto"


@pytest.mark.asyncio
async def test_openai_audio_local_server_sends_diarize_form_field():
    """A LOCAL OpenAI-compatible STT server (the M5) keys diarization off a plain
    `diarize` form field, not OpenAI's response_format/model gate. The openai_audio
    transport must send diarize=true, and must parse a whisperx-style diarized
    response (segments+speaker) via the generic-extractor fallback. (Local URL so
    the LCT_LOCAL_ONLY egress guard permits it.)"""
    candidate = {
        "provider": "openai_audio",
        "transport": "openai_audio",
        "route_id": "m5_local_diarize",
        "http_url": "http://127.0.0.1:1234/v1/audio/transcriptions",
        "base_url": "http://127.0.0.1:1234",
        "api_key": "local",
        "model": "whisper-1",
        "supports_diarization": True,
        "degraded": False,
        "request_diarization": True,
    }

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    # whisperx-style shape (segments with speaker), NOT OpenAI's — exercises the fallback.
    mock_response.json.return_value = {
        "text": "hi there",
        "segments": [{"speaker": "speaker_0", "start": 0.0, "end": 0.4, "text": "hi there"}],
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch.object(mod, "STT_HTTP_POOL_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        result = await transcribe_wav_stt_candidate(
            candidate,
            wav_payload=pcm16le_to_wav(_pcm_bytes(0.5)),
            sample_rate_hz=16000,
            timeout_seconds=12.0,
        )

    assert result["ok"] is True
    request_form = mock_client.post.call_args.kwargs["data"]
    assert request_form["diarize"] == "true"  # the fix: M5 keys off this field
    assert result["segments_count"] == 1       # whisperx-style segments parsed via fallback


# ---------------------------------------------------------------------------
# Connection pooling
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_pooling_creates_persistent_client():
    session = _make_session(pool_enabled=True)
    assert session._client is not None
    assert isinstance(session._client, object)  # httpx.AsyncClient


@pytest.mark.asyncio
async def test_pooling_disabled_no_persistent_client():
    session = _make_session(pool_enabled=False)
    assert session._client is None


@pytest.mark.asyncio
async def test_close_cleans_up_client():
    session = _make_session(pool_enabled=True)
    assert session._client is not None
    await session.close()
    assert session._client is None


@pytest.mark.asyncio
async def test_close_without_client_is_safe():
    session = _make_session(pool_enabled=False)
    await session.close()  # Should not raise


@pytest.mark.asyncio
async def test_pooled_client_reused_across_transcriptions():
    session = _make_session(pool_enabled=True)
    original_client = session._client

    # Mock the client's post method
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {"text": "hello"}
    mock_response.raise_for_status = MagicMock()
    original_client.post = AsyncMock(return_value=mock_response)

    # First transcription
    text1, segments1 = await session._transcribe_pcm(_pcm_bytes(0.1))
    assert text1 == "hello"
    assert segments1 is None

    # Second transcription
    text2, segments2 = await session._transcribe_pcm(_pcm_bytes(0.1))
    assert text2 == "hello"
    assert segments2 is None

    # Both calls used the same client
    assert original_client.post.call_count == 2
    assert session._client is original_client

    await session.close()


@pytest.mark.asyncio
async def test_unpooled_creates_per_request_client():
    session = _make_session(pool_enabled=False)
    assert session._client is None

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {"text": "hello"}
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text, segments = await session._transcribe_pcm(_pcm_bytes(0.1))
        assert text == "hello"
        assert segments is None
        mock_client.aclose.assert_called_once()


# ---------------------------------------------------------------------------
# VAD-based chunking
# ---------------------------------------------------------------------------
def _make_vad_model(*, speech_prob=0.9):
    """Create a mock VAD model that returns a fixed speech probability."""
    model = MagicMock()

    def model_call(chunk, sr):
        result = MagicMock()
        result.item.return_value = speech_prob
        return result

    model.side_effect = model_call
    model.reset_states = MagicMock()
    return model


@pytest.mark.asyncio
async def test_vad_does_not_flush_before_min_seconds():
    model = _make_vad_model(speech_prob=0.0)  # All silence
    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    # Push 0.3s of audio (below min 0.5s)
    with patch.object(mod, "STT_VAD_MIN_SECONDS", 0.5), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        result = await session.push_audio_chunk(_pcm_bytes(0.3))
    assert result is None
    session._transcribe_pcm.assert_not_called()


@pytest.mark.asyncio
async def test_vad_force_flush_at_max_seconds():
    model = _make_vad_model(speech_prob=0.9)  # Always speech
    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("forced text", None))

    # Push enough audio to exceed max_seconds
    with patch.object(mod, "STT_VAD_MAX_SECONDS", 1.0), \
         patch.object(mod, "STT_VAD_MIN_SECONDS", 0.5), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        # Push 1.5s at once (exceeds 1.0s max)
        result = await session.push_audio_chunk(_pcm_bytes(1.5))

    assert result is not None
    assert result["text"] == "forced text"
    model.reset_states.assert_called()


@pytest.mark.asyncio
async def test_vad_flushes_on_silence_after_speech():
    """With all-silence audio, VAD never updates _last_speech_sample.

    After min_seconds, the accumulated silence exceeds the threshold and triggers flush.
    Uses audio-sample-based timing so no wall-clock dependency.
    """
    model = _make_vad_model(speech_prob=0.0)  # All silence
    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("silence text", None))

    # silence_ms threshold = 50ms → 0.05s * 16000 = 800 samples of silence needed
    # Push 0.5s = 8000 samples → silence_samples will be ~8000 (all frames are silence)
    with patch.object(mod, "STT_VAD_MIN_SECONDS", 0.1), \
         patch.object(mod, "STT_VAD_MAX_SECONDS", 10.0), \
         patch.object(mod, "STT_VAD_SILENCE_MS", 50), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is not None
    assert result["text"] == "silence text"


@pytest.mark.asyncio
async def test_vad_does_not_flush_during_speech():
    model = _make_vad_model(speech_prob=0.9)  # Active speech
    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    with patch.object(mod, "STT_VAD_MIN_SECONDS", 0.1), \
         patch.object(mod, "STT_VAD_MAX_SECONDS", 10.0), \
         patch.object(mod, "STT_VAD_SILENCE_MS", 300), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        # Push 0.5s of "speech" — should not flush (silence not detected)
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is None
    session._transcribe_pcm.assert_not_called()


@pytest.mark.asyncio
async def test_vad_metadata_includes_vad_enabled_true():
    model = _make_vad_model(speech_prob=0.0)  # Silence triggers flush
    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    with patch.object(mod, "STT_VAD_MIN_SECONDS", 0.1), \
         patch.object(mod, "STT_VAD_MAX_SECONDS", 10.0), \
         patch.object(mod, "STT_VAD_SILENCE_MS", 50), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    assert result is not None
    assert result["metadata"]["vad_enabled"] is True


@pytest.mark.asyncio
async def test_vad_fallback_when_silero_unavailable():
    """When STT_VAD_ENABLED=true but silero-vad not installed, falls back to fixed-interval."""
    session = _make_session(vad_enabled=True, vad_model=None)  # Model unavailable
    assert session._vad_available is False

    session._transcribe_pcm = AsyncMock(return_value=("fallback text", None))

    # Should use fixed-interval chunking (chunk_seconds=0.25 default)
    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is not None
    assert result["text"] == "fallback text"
    assert result["metadata"]["vad_enabled"] is False


@pytest.mark.asyncio
async def test_close_cleans_up_vad_model():
    model = _make_vad_model()
    session = _make_session(vad_enabled=True, vad_model=model)
    assert session._vad_available is True
    assert session._vad_model is not None

    await session.close()
    assert session._vad_available is False
    assert session._vad_model is None


@pytest.mark.asyncio
async def test_vad_feed_error_assumes_speech():
    """If _feed_vad model call raises, it should assume speech (not flush prematurely)."""
    model = MagicMock()
    model.side_effect = RuntimeError("VAD crash")
    model.reset_states = MagicMock()

    session = _make_session(vad_enabled=True, vad_model=model)
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    with patch.object(mod, "STT_VAD_MIN_SECONDS", 0.1), \
         patch.object(mod, "STT_VAD_MAX_SECONDS", 10.0), \
         patch.object(mod, "STT_VAD_SILENCE_MS", 300), \
         patch.dict(sys.modules, {"torch": _mock_torch}):
        # _feed_vad will catch the RuntimeError and set _last_speech_sample
        # to end of chunk (assumes speech), so silence_ms will be ~0
        result = await session.push_audio_chunk(_pcm_bytes(0.5))

    # Should not flush because error handling assumes speech
    assert result is None


# ---------------------------------------------------------------------------
# buffer_duration_seconds
# ---------------------------------------------------------------------------
def test_buffer_duration_empty():
    session = _make_session()
    assert session._buffer_duration_seconds() == 0.0


def test_buffer_duration_calculates_correctly():
    session = _make_session(sample_rate_hz=16000)
    # 16000 samples/s * 2 bytes/sample * 1 second = 32000 bytes
    session._buffer = bytearray(32000)
    assert session._buffer_duration_seconds() == pytest.approx(1.0, abs=0.01)

import base64
import sys
import time
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from lct_python_backend.services import stt_http_transcriber as mod
from lct_python_backend.services.stt_http_transcriber import (
    RealtimeHttpSttSession,
    decode_audio_base64,
    extract_transcript_text,
    pcm16le_to_wav,
)


# ---------------------------------------------------------------------------
# Mock torch module for tests (silero_vad needs torch but we don't install it)
# ---------------------------------------------------------------------------
_mock_torch = MagicMock()
_mock_torch.from_numpy = lambda x: x  # Pass numpy arrays through


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
    session._transcribe_pcm = AsyncMock(return_value="chunk text")

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "chunk text"
    assert result["is_final"] is False

    session._transcribe_pcm = AsyncMock(return_value="final text")
    await session.push_audio_chunk(b"\x00\x01" * 2000)
    flush_result = await session.flush()
    assert flush_result is not None
    assert flush_result["text"] == "final text"
    assert flush_result["is_final"] is True


@pytest.mark.asyncio
async def test_fixed_interval_does_not_flush_below_threshold():
    session = _make_session(chunk_seconds=1.0)
    session._transcribe_pcm = AsyncMock(return_value="text")

    # Push 0.5s of audio (below 1.0s threshold)
    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is None
    session._transcribe_pcm.assert_not_called()


@pytest.mark.asyncio
async def test_metadata_includes_vad_enabled_false():
    session = _make_session()
    session._transcribe_pcm = AsyncMock(return_value="text")

    result = await session.push_audio_chunk(_pcm_bytes(0.5))
    assert result is not None
    assert result["metadata"]["vad_enabled"] is False


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
    text1 = await session._transcribe_pcm(_pcm_bytes(0.1))
    assert text1 == "hello"

    # Second transcription
    text2 = await session._transcribe_pcm(_pcm_bytes(0.1))
    assert text2 == "hello"

    # Both calls used the same client
    assert original_client.post.call_count == 2
    assert session._client is original_client

    await session.close()


@pytest.mark.asyncio
async def test_unpooled_creates_per_request_client():
    session = _make_session(pool_enabled=False)
    assert session._client is None

    # _transcribe_pcm should create and close a client per request
    # We'll mock httpx.AsyncClient to verify
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {"text": "hello"}
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.aclose = AsyncMock()

    with patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text = await session._transcribe_pcm(_pcm_bytes(0.1))
        assert text == "hello"
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
    session._transcribe_pcm = AsyncMock(return_value="text")

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
    session._transcribe_pcm = AsyncMock(return_value="forced text")

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
    session._transcribe_pcm = AsyncMock(return_value="silence text")

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
    session._transcribe_pcm = AsyncMock(return_value="text")

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
    session._transcribe_pcm = AsyncMock(return_value="text")

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

    session._transcribe_pcm = AsyncMock(return_value="fallback text")

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
    session._transcribe_pcm = AsyncMock(return_value="text")

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

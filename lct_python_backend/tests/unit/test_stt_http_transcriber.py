import base64
from unittest.mock import AsyncMock, patch

import pytest

from lct_python_backend.services import stt_http_transcriber as mod
from lct_python_backend.services.stt_http_transcriber import (
    RealtimeHttpSttSession,
    decode_audio_base64,
    extract_diarized_segments,
    extract_transcript_text,
    pcm16le_to_wav,
)


# ---------------------------------------------------------------------------
# Pure function tests
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
# extract_diarized_segments tests
# ---------------------------------------------------------------------------
def test_extract_diarized_segments_returns_none_for_non_dict():
    assert extract_diarized_segments("not a dict") is None
    assert extract_diarized_segments(None) is None
    assert extract_diarized_segments(42) is None


def test_extract_diarized_segments_returns_none_when_speakers_null():
    assert extract_diarized_segments({"text": "hello", "speakers": None}) is None


def test_extract_diarized_segments_returns_none_for_empty_speakers():
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


def test_extract_diarized_segments_skips_entries_without_speaker_or_text():
    payload = {
        "text": "hello",
        "speakers": [
            {"speaker": "SPEAKER_00", "text": "valid"},
            {"speaker": "", "text": "no speaker"},  # empty speaker
            {"speaker": "SPEAKER_01"},  # no text
            {"not_a_segment": True},  # no speaker/text keys
        ],
    }
    result = extract_diarized_segments(payload)
    assert result is not None
    assert len(result) == 1
    assert result[0]["speaker"] == "SPEAKER_00"


def test_extract_diarized_segments_multi_speaker_conversation():
    """Test with real WhisperX response shape from verified endpoint."""
    payload = {
        "text": "You called me yesterday, I'm sorry. No, it's fine.",
        "language": "en",
        "duration": 30.0,
        "model": "large-v3",
        "timestamps": [
            {"start": 0.031, "end": 1.453, "text": "You called me yesterday, I'm sorry.", "speaker": "SPEAKER_02"},
            {"start": 4.035, "end": 4.636, "text": "No, it's fine.", "speaker": "SPEAKER_00"},
        ],
        "speakers": [
            {"speaker": "SPEAKER_02", "start": 0.031, "end": 1.453, "text": "You called me yesterday, I'm sorry."},
            {"speaker": "SPEAKER_00", "start": 4.035, "end": 4.636, "text": "No, it's fine."},
        ],
    }
    result = extract_diarized_segments(payload)
    assert result is not None
    assert len(result) == 2
    assert result[0]["speaker"] == "SPEAKER_02"
    assert result[1]["speaker"] == "SPEAKER_00"


# ---------------------------------------------------------------------------
# Session tests (updated for (text, segments) return type)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_realtime_http_session_pushes_and_flushes_chunks():
    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )
    session._transcribe_pcm = AsyncMock(return_value=("chunk text", None))

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "chunk text"
    assert result["is_final"] is False
    assert "segments" not in result  # No segments when None

    session._transcribe_pcm = AsyncMock(return_value=("final text", None))
    await session.push_audio_chunk(b"\x00\x01" * 2000)
    flush_result = await session.flush()
    assert flush_result is not None
    assert flush_result["text"] == "final text"
    assert flush_result["is_final"] is True


@pytest.mark.asyncio
async def test_transcribe_buffer_includes_segments_when_present():
    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )
    segments = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0, "text": "Hello"},
        {"speaker": "SPEAKER_01", "start": 1.0, "end": 2.0, "text": "Hi"},
    ]
    session._transcribe_pcm = AsyncMock(return_value=("Hello Hi", segments))

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "Hello Hi"
    assert result["segments"] == segments
    assert len(result["segments"]) == 2


@pytest.mark.asyncio
async def test_transcribe_buffer_metadata_includes_diarize_flag():
    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )
    session._transcribe_pcm = AsyncMock(return_value=("text", None))

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert "diarize_enabled" in result["metadata"]


@pytest.mark.asyncio
async def test_diarize_form_field_sent_when_enabled():
    """When STT_DIARIZE_ENABLED is true, diarize=true should be in form data."""
    from unittest.mock import MagicMock

    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )

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
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(mod, "STT_DIARIZE_ENABLED", True), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text, segments = await session._transcribe_pcm(b"\x00\x00" * 100)

    assert text == "hello"
    assert segments is not None
    assert len(segments) == 1

    # Verify diarize=true was in form data
    call_kwargs = mock_client.post.call_args
    form_data = call_kwargs.kwargs.get("data") or call_kwargs[1].get("data", {})
    assert form_data.get("diarize") == "true"


@pytest.mark.asyncio
async def test_diarize_not_sent_when_disabled():
    """When STT_DIARIZE_ENABLED is false, diarize should not be in form data."""
    from unittest.mock import MagicMock

    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "application/json"}
    mock_response.json.return_value = {"text": "hello", "speakers": None}
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(mod, "STT_DIARIZE_ENABLED", False), \
         patch("lct_python_backend.services.stt_http_transcriber.httpx.AsyncClient", return_value=mock_client):
        text, segments = await session._transcribe_pcm(b"\x00\x00" * 100)

    assert text == "hello"
    assert segments is None

    call_kwargs = mock_client.post.call_args
    form_data = call_kwargs.kwargs.get("data") or call_kwargs[1].get("data", {})
    assert "diarize" not in form_data

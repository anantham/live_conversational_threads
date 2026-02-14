import base64
from unittest.mock import AsyncMock

import pytest

from lct_python_backend.services.stt_http_transcriber import (
    RealtimeHttpSttSession,
    decode_audio_base64,
    extract_transcript_text,
    pcm16le_to_wav,
)


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


@pytest.mark.asyncio
async def test_realtime_http_session_pushes_and_flushes_chunks():
    session = RealtimeHttpSttSession(
        provider="parakeet",
        http_url="http://localhost:5092/v1/audio/transcriptions",
        sample_rate_hz=16000,
        chunk_seconds=0.25,
    )
    session._transcribe_pcm = AsyncMock(return_value="chunk text")  # type: ignore[method-assign]

    result = await session.push_audio_chunk(b"\x00\x01" * 4000)
    assert result is not None
    assert result["text"] == "chunk text"
    assert result["is_final"] is False

    session._transcribe_pcm = AsyncMock(return_value="final text")  # type: ignore[method-assign]
    await session.push_audio_chunk(b"\x00\x01" * 2000)
    flush_result = await session.flush()
    assert flush_result is not None
    assert flush_result["text"] == "final text"
    assert flush_result["is_final"] is True

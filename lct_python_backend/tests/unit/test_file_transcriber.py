from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from lct_python_backend.services.file_transcriber import (
    AudioTranscriptionDetail,
    _decode_text_bytes,
    _align_asr_segments_to_speakers,
    _split_audio_to_chunks,
    chunk_transcript_lines,
    detect_file_kind,
    looks_like_google_meet_text,
    parse_google_meet_text,
    parse_plain_text,
    parse_srt_text,
    parse_vtt_text,
    resolve_import_audio_candidates,
    transcribe_audio_chunked,
    transcribe_audio_file,
    transcribe_audio_file_detailed,
    transcribe_uploaded_file,
)


def test_detect_file_kind_by_audio_extension():
    assert detect_file_kind("meeting.mp3") == "audio"


def test_detect_file_kind_by_audio_content_type():
    assert detect_file_kind("blob.bin", content_type="audio/wav") == "audio"


def test_detect_file_kind_vtt_extension():
    assert detect_file_kind("captions.vtt") == "vtt"


def test_detect_file_kind_srt_extension():
    assert detect_file_kind("captions.srt") == "srt"


def test_detect_file_kind_google_meet_pdf_extension():
    assert detect_file_kind("meeting.pdf") == "google_meet"


def test_detect_file_kind_google_meet_text_preview():
    preview = "00:00:05\nAlice ~: hello there\n"
    assert detect_file_kind("meeting.txt", text_preview=preview) == "google_meet"


def test_detect_file_kind_plain_text_fallback():
    assert detect_file_kind("notes.txt", text_preview="random plain notes") == "text"


def test_looks_like_google_meet_text_detects_speaker_pattern():
    assert looks_like_google_meet_text("Alice ~: Hello")


def test_parse_plain_text_trims_and_compacts_lines():
    text = "  hello \n\n world  \n"
    assert parse_plain_text(text) == "hello\nworld"


def test_parse_vtt_text_extracts_cues():
    payload = """WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:04.000
<v Alice>Hi there</v>
"""
    assert parse_vtt_text(payload) == "Hello world\nHi there"


def test_parse_vtt_text_ignores_note_blocks():
    payload = """WEBVTT

NOTE this is metadata
line 2

00:00:00.000 --> 00:00:02.000
Visible text
"""
    assert parse_vtt_text(payload) == "Visible text"


def test_parse_srt_text_extracts_body_lines():
    payload = """1
00:00:00,000 --> 00:00:02,000
Hello world

2
00:00:02,000 --> 00:00:03,500
Second line
"""
    assert parse_srt_text(payload) == "Hello world\nSecond line"


def test_parse_srt_text_handles_multiline_cues():
    payload = """1
00:00:00,000 --> 00:00:02,000
Hello
world
"""
    assert parse_srt_text(payload) == "Hello world"


def test_parse_google_meet_text_normalizes_utterances():
    payload = """00:00:01
Alice ~: Hello there
Bob: Hi Alice
"""
    parsed = parse_google_meet_text(payload)
    assert "Alice: Hello there" in parsed
    assert "Bob: Hi Alice" in parsed


def test_chunk_transcript_lines_respects_max_chars():
    transcript = "one\ntwo\nthree\nfour"
    chunks = chunk_transcript_lines(transcript, max_chars=7)
    assert chunks == ["one two", "three", "four"]


@pytest.mark.asyncio
async def test_transcribe_audio_file_success_json_payload(tmp_path: Path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"text": "hello from stt"},
        )

    transcript = await transcribe_audio_file(
        audio_path,
        http_url="http://stt.local/v1/audio/transcriptions",
        transport=httpx.MockTransport(handler),
    )
    assert transcript == "hello from stt"


@pytest.mark.asyncio
async def test_transcribe_audio_file_detailed_extracts_segments(tmp_path: Path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "text": "hello world",
                "segments": [
                    {"start": 0.0, "end": 0.8, "text": "hello"},
                    {"start": 0.8, "end": 1.4, "segment": "world"},
                ],
            },
        )

    detail = await transcribe_audio_file_detailed(
        audio_path,
        http_url="http://stt.local/v1/audio/transcriptions",
        response_format="verbose_json",
        transport=httpx.MockTransport(handler),
    )

    assert detail.transcript_text == "hello world"
    assert detail.asr_segments == [
        {"start": 0.0, "end": 0.8, "text": "hello"},
        {"start": 0.8, "end": 1.4, "text": "world"},
    ]


@pytest.mark.asyncio
async def test_transcribe_audio_file_supports_plain_text_body(tmp_path: Path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            text="plain transcript body",
        )

    transcript = await transcribe_audio_file(
        audio_path,
        http_url="http://stt.local/v1/audio/transcriptions",
        transport=httpx.MockTransport(handler),
    )
    assert transcript == "plain transcript body"


@pytest.mark.asyncio
async def test_transcribe_audio_file_raises_on_http_error(tmp_path: Path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="service unavailable")

    with pytest.raises(RuntimeError, match="503"):
        await transcribe_audio_file(
            audio_path,
            http_url="http://stt.local/v1/audio/transcriptions",
            transport=httpx.MockTransport(handler),
        )


# ---------------------------------------------------------------------------
# Chunked audio transcription tests
# ---------------------------------------------------------------------------

def _make_silent_wav(tmp_path: Path, duration_s: float = 3.0, name: str = "test.wav") -> Path:
    """Create a minimal silent WAV file using pydub."""
    from pydub import AudioSegment
    from pydub.generators import Sine

    # Generate a short sine tone (audible but simple)
    segment = Sine(440).to_audio_segment(duration=int(duration_s * 1000))
    wav_path = tmp_path / name
    segment.export(str(wav_path), format="wav")
    return wav_path


def test_split_audio_to_chunks_creates_expected_count(tmp_path: Path):
    """A 5s audio file split into 2s chunks with 0s overlap = 3 chunks."""
    wav = _make_silent_wav(tmp_path, duration_s=5.0)
    chunks = _split_audio_to_chunks(wav, chunk_duration_s=2, overlap_s=0)
    try:
        assert len(chunks) == 3
        for chunk_path, start_ms, end_ms in chunks:
            assert chunk_path.exists()
            assert end_ms > start_ms
    finally:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)


def test_split_audio_to_chunks_with_overlap(tmp_path: Path):
    """Overlap causes more chunks: 5s audio, 3s chunks, 1s overlap = step 2s = 3 chunks."""
    wav = _make_silent_wav(tmp_path, duration_s=5.0)
    chunks = _split_audio_to_chunks(wav, chunk_duration_s=3, overlap_s=1)
    try:
        assert len(chunks) >= 2
        # Verify overlap: second chunk should start before first chunk ends
        if len(chunks) >= 2:
            _, _, first_end = chunks[0]
            _, second_start, _ = chunks[1]
            assert second_start < first_end
    finally:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)


def test_split_audio_short_file_single_chunk(tmp_path: Path):
    """A file shorter than chunk_duration produces exactly 1 chunk."""
    wav = _make_silent_wav(tmp_path, duration_s=1.0)
    chunks = _split_audio_to_chunks(wav, chunk_duration_s=60, overlap_s=2)
    try:
        assert len(chunks) == 1
    finally:
        for chunk_path, _, _ in chunks:
            chunk_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_short_file_uses_single_shot(tmp_path: Path):
    """Short files (single chunk) fall back to single-shot transcription."""
    wav = _make_silent_wav(tmp_path, duration_s=1.0)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "short file transcript"})

    result = await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=60,
        transport=httpx.MockTransport(handler),
    )
    assert result == "short file transcript"


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_multi_chunk_concatenates(tmp_path: Path):
    """Multi-chunk files concatenate transcripts with newlines."""
    wav = _make_silent_wav(tmp_path, duration_s=5.0)

    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"text": f"chunk {call_count}"})

    result = await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=2,
        overlap_s=0,
        transport=httpx.MockTransport(handler),
    )
    # 5s / 2s chunks = 3 chunks
    assert call_count == 3
    assert result == "chunk 1\nchunk 2\nchunk 3"


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_calls_progress_callback(tmp_path: Path):
    """Progress callback is called for each chunk."""
    wav = _make_silent_wav(tmp_path, duration_s=4.0)
    progress_calls = []

    async def on_progress(idx, total, text):
        progress_calls.append((idx, total, text))

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "ok"})

    await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=2,
        overlap_s=0,
        on_chunk_progress=on_progress,
        transport=httpx.MockTransport(handler),
    )
    assert len(progress_calls) == 2
    assert progress_calls[0][0] == 1  # first chunk
    assert progress_calls[-1][0] == progress_calls[-1][1]  # last chunk idx == total


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_cleans_up_temp_files(tmp_path: Path):
    """Temp chunk files are cleaned up even on error."""
    import glob
    import tempfile

    chunk_glob = f"{tempfile.gettempdir()}/stt_chunk_*.wav"
    existing_chunks = set(glob.glob(chunk_glob))
    wav = _make_silent_wav(tmp_path, duration_s=4.0)

    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json={"text": "ok"})

    with pytest.raises(RuntimeError, match="500"):
        await transcribe_audio_chunked(
            wav,
            http_url="http://stt.local/transcriptions",
            chunk_duration_s=2,
            overlap_s=0,
            chunk_max_retries=0,
            transport=httpx.MockTransport(handler),
        )

    # Verify this test did not leak additional stt_chunk temp files.
    leftover = set(glob.glob(chunk_glob))
    leaked = leftover - existing_chunks
    assert leaked == set()


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_retries_transient_errors(tmp_path: Path):
    """Transient network errors should retry per chunk with backoff."""
    wav = _make_silent_wav(tmp_path, duration_s=4.0)
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise httpx.ReadTimeout("timed out", request=request)
        return httpx.Response(200, json={"text": f"chunk-{call_count}"})

    result = await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=2,
        overlap_s=0,
        chunk_max_retries=2,
        chunk_retry_backoff_s=0.0,
        transport=httpx.MockTransport(handler),
    )

    # 2 chunks total, with first attempt transient-failing once => 3 requests.
    assert call_count == 3
    assert result == "chunk-2\nchunk-3"


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_skips_empty_chunks(tmp_path: Path):
    """A chunk returning empty text should be skipped, not abort the pipeline."""
    wav = _make_silent_wav(tmp_path, duration_s=6.0)
    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        # chunk 2 of 3 returns empty — simulates a silent section
        if call_count == 2:
            return httpx.Response(200, json={"text": ""})
        return httpx.Response(200, json={"text": f"chunk-{call_count}"})

    result = await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=2,
        overlap_s=0,
        chunk_max_retries=0,
        chunk_retry_backoff_s=0.0,
        transport=httpx.MockTransport(handler),
    )

    assert call_count == 3
    # Empty chunk skipped; transcript stitched from the other two
    assert "chunk-1" in result
    assert "chunk-3" in result


@pytest.mark.asyncio
async def test_transcribe_audio_chunked_does_not_retry_non_retryable_http_status(tmp_path: Path):
    """Permanent 4xx STT failures should fail fast without retries."""
    wav = _make_silent_wav(tmp_path, duration_s=4.0)
    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(400, text="bad request")

    with pytest.raises(RuntimeError, match="400"):
        await transcribe_audio_chunked(
            wav,
            http_url="http://stt.local/transcriptions",
            chunk_duration_s=2,
            overlap_s=0,
            chunk_max_retries=3,
            chunk_retry_backoff_s=0.0,
            transport=httpx.MockTransport(handler),
        )

    assert call_count == 1


def test_align_asr_segments_to_speakers_by_overlap():
    asr_segments = [
        {"start": 0.0, "end": 1.0, "text": "hello"},
        {"start": 1.0, "end": 2.0, "text": "there"},
        {"start": 2.0, "end": 3.0, "text": "friend"},
    ]
    speaker_segments = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.3},
        {"speaker": "SPEAKER_01", "start": 1.3, "end": 3.5},
    ]

    aligned = _align_asr_segments_to_speakers(asr_segments, speaker_segments)

    assert aligned[0]["speaker"] == "SPEAKER_00"
    assert aligned[1]["speaker"] == "SPEAKER_01"
    assert "there" in aligned[1]["text"]
    assert "friend" in aligned[1]["text"]


# ---------------------------------------------------------------------------
# detect_file_kind content-type fallback tests
# ---------------------------------------------------------------------------

def test_detect_file_kind_subrip_content_type():
    assert detect_file_kind("video.unknown", content_type="application/x-subrip") == "srt"


def test_detect_file_kind_vtt_content_type():
    assert detect_file_kind("captions.unknown", content_type="text/vtt") == "vtt"


def test_detect_file_kind_text_plain_content_type():
    assert detect_file_kind("notes.unknown", content_type="text/plain", text_preview="some notes") == "text"


def test_detect_file_kind_text_plain_google_meet():
    preview = "00:10:47\nAlice ~: hello"
    assert detect_file_kind("notes.unknown", content_type="text/plain", text_preview=preview) == "google_meet"


def test_detect_file_kind_unknown():
    assert detect_file_kind("data.xyz") == "unknown"


# ---------------------------------------------------------------------------
# _decode_text_bytes encoding fallback tests
# ---------------------------------------------------------------------------

def test_decode_text_bytes_utf8():
    assert _decode_text_bytes("hello".encode("utf-8")) == "hello"


def test_decode_text_bytes_latin1_fallback():
    # \xe9 is 'é' in latin-1 but invalid standalone utf-8
    raw = b"caf\xe9"
    result = _decode_text_bytes(raw)
    assert "caf" in result


# ---------------------------------------------------------------------------
# transcribe_uploaded_file dispatch tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_transcribe_uploaded_file_vtt(tmp_path: Path):
    vtt_content = """WEBVTT

00:00:00.000 --> 00:00:02.000
Hello from VTT
"""
    p = tmp_path / "captions.vtt"
    p.write_text(vtt_content)

    result = await transcribe_uploaded_file(
        temp_path=p, filename="captions.vtt", content_type=None,
    )
    assert result.source_type == "vtt"
    assert "Hello from VTT" in result.transcript_text


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_srt(tmp_path: Path):
    srt_content = """1
00:00:00,000 --> 00:00:02,000
Hello from SRT
"""
    p = tmp_path / "captions.srt"
    p.write_text(srt_content)

    result = await transcribe_uploaded_file(
        temp_path=p, filename="captions.srt", content_type=None,
    )
    assert result.source_type == "srt"
    assert "Hello from SRT" in result.transcript_text


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_plain_text(tmp_path: Path):
    p = tmp_path / "notes.txt"
    p.write_text("line one\nline two\n")

    result = await transcribe_uploaded_file(
        temp_path=p, filename="notes.txt", content_type=None,
    )
    assert result.source_type == "text"
    assert result.transcript_text == "line one\nline two"
    assert [item["text"] for item in result.utterances] == ["line one", "line two"]
    assert [item["speaker_id"] for item in result.utterances] == ["SPEAKER_00", "SPEAKER_00"]


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_unknown_raises(tmp_path: Path):
    p = tmp_path / "data.xyz"
    p.write_bytes(b"\x00\x01\x02")

    with pytest.raises(ValueError, match="Unsupported file type"):
        await transcribe_uploaded_file(
            temp_path=p, filename="data.xyz", content_type=None,
        )


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_source_type_override(tmp_path: Path):
    """source_type_override bypasses auto-detection."""
    p = tmp_path / "meeting.txt"
    p.write_text("line one\nline two\n")

    result = await transcribe_uploaded_file(
        temp_path=p, filename="meeting.txt", content_type=None,
        source_type_override="text",
    )
    assert result.source_type == "text"
    assert result.metadata["file_kind"] == "text"


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_falls_back_to_remote_provider(monkeypatch, tmp_path: Path):
    import lct_python_backend.services.file_transcriber as mod

    wav = _make_silent_wav(tmp_path, duration_s=1.5, name="clip.wav")
    calls: list[str] = []
    fallback_events: list[tuple[str, str, str]] = []

    async def fake_chunked(*_args, **kwargs):
        url = str(kwargs.get("http_url") or "")
        calls.append(url)
        if len(calls) == 1:
            request = httpx.Request("POST", url or "http://localhost")
            raise httpx.ReadError("local provider down", request=request)
        return "speaker one: recovered transcript"

    async def on_fallback(from_provider: str, to_provider: str, error: str):
        fallback_events.append((from_provider, to_provider, error))

    monkeypatch.setattr(mod, "transcribe_audio_chunked", AsyncMock(side_effect=fake_chunked))

    result = await mod.transcribe_uploaded_file(
        temp_path=wav,
        filename="clip.wav",
        content_type="audio/wav",
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:8001/v1/audio/transcriptions",
            },
            "http_timeout_seconds": 120.0,
        },
        enable_parakeet_pyannote=False,
        on_provider_fallback=on_fallback,
    )

    assert result.source_type == "audio"
    assert result.transcript_text == "speaker one: recovered transcript"
    assert calls == [
        "http://localhost:5092/v1/audio/transcriptions",
        "http://100.81.65.74:8001/v1/audio/transcriptions",
    ]
    assert result.metadata["provider"] == "whisper"
    assert result.metadata["provider_fallback_used"] is True
    assert result.metadata["provider_fallback_from"] == "parakeet"
    assert result.metadata["provider_fallback_to"] == "whisper"
    assert result.metadata["provider_attempt_count"] == 2
    assert fallback_events and fallback_events[0][0] == "parakeet"
    assert fallback_events[0][1] == "whisper"


def test_resolve_import_audio_candidates_prefers_openai_diarized_for_quality():
    """With ``upload_local_first`` disabled, uploads prefer the OpenAI diarized
    cloud path for transcript quality even when a local URL is configured.

    Note: ``upload_local_first`` defaults to True, in which case the local URL
    wins instead — that default-on path is covered by
    test_stt_import_provider_selection.py. This test pins the quality-first
    branch by explicitly opting out of local-first.
    """
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "whisper",
            "local_only": False,
            "upload_local_first": False,
            "live_cloud_fallback_enabled": True,
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "live_fallback_priority": ["openai_audio", "remote_whisper"],
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "sk-openai-secret",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                }
            },
        },
        provider_override=None,
    )

    assert candidates[0]["provider"] == "openai_audio"
    assert candidates[0]["transport"] == "openai_audio"
    assert candidates[0]["request_diarization"] is True
    assert candidates[0]["model"] == "gpt-4o-transcribe-diarize"


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_prefers_openai_diarized_candidate(monkeypatch, tmp_path: Path):
    import lct_python_backend.services.file_transcriber as mod

    wav = _make_silent_wav(tmp_path, duration_s=1.5, name="clip.wav")
    chunk_result = {
        "ok": True,
        "provider": "openai_audio",
        "transport": "openai_audio",
        "model": "gpt-4o-transcribe-diarize",
        "text": "ignored because diarized segments are present",
        "segments": [
            {"speaker": "SPEAKER_00", "text": "hello there"},
            {"speaker": "SPEAKER_01", "text": "hi"},
        ],
        "segments_count": 2,
        "diarization_requested": True,
        "supports_diarization": True,
        "degraded": False,
        "error": None,
        "status": "ready",
        "status_code": None,
    }
    transcribe_candidate_mock = AsyncMock(return_value=chunk_result)
    chunked_mock = AsyncMock(side_effect=AssertionError("legacy chunked backend path should not run"))

    monkeypatch.setattr(mod, "transcribe_wav_stt_candidate", transcribe_candidate_mock)
    monkeypatch.setattr(mod, "transcribe_audio_chunked", chunked_mock)

    result = await mod.transcribe_uploaded_file(
        temp_path=wav,
        filename="clip.wav",
        content_type="audio/wav",
        stt_settings={
            "provider": "whisper",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_timeout_seconds": 10.0,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "api_key": "sk-openai-secret",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                }
            },
        },
    )

    assert result.source_type == "audio"
    assert result.metadata["provider"] == "openai_audio"
    assert result.metadata["transport"] == "openai_audio"
    assert result.metadata["model"] == "gpt-4o-transcribe-diarize"
    assert result.metadata["diarization_source"] == "stt_provider"
    assert result.metadata["stt_diarized_segment_count"] == 2
    assert "SPEAKER_00: hello there" in result.transcript_text
    assert "SPEAKER_01: hi" in result.transcript_text
    assert result.speaker_segments == [
        {"speaker": "SPEAKER_00", "text": "hello there"},
        {"speaker": "SPEAKER_01", "text": "hi"},
    ]
    assert [item["speaker_id"] for item in result.utterances] == ["SPEAKER_00", "SPEAKER_01"]
    assert [item["text"] for item in result.utterances] == ["hello there", "hi"]
    candidate = transcribe_candidate_mock.await_args.args[0]
    kwargs = transcribe_candidate_mock.await_args.kwargs
    assert candidate["provider"] == "openai_audio"
    assert candidate["request_diarization"] is True
    assert candidate["model"] == "gpt-4o-transcribe-diarize"
    assert kwargs["timeout_seconds"] == 30.0


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_parakeet_pyannote_sidecar(monkeypatch, tmp_path: Path):
    import lct_python_backend.services.file_transcriber as mod

    wav = _make_silent_wav(tmp_path, duration_s=1.5, name="clip.wav")
    detail = AudioTranscriptionDetail(
        transcript_text="hello there",
        asr_segments=[
            {"start": 0.0, "end": 0.8, "text": "hello"},
            {"start": 0.8, "end": 1.5, "text": "there"},
        ],
        diarized_segments=None,
        raw_payload={"text": "hello there"},
    )

    monkeypatch.setattr(mod, "STT_PARAKEET_PYANNOTE_ENABLED", True)
    monkeypatch.setattr(mod, "transcribe_audio_file_detailed", AsyncMock(return_value=detail))
    monkeypatch.setattr(
        mod,
        "_run_pyannote_diarization",
        lambda _path: [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 0.9},
            {"speaker": "SPEAKER_01", "start": 0.9, "end": 2.0},
        ],
    )

    result = await mod.transcribe_uploaded_file(
        temp_path=wav,
        filename="clip.wav",
        content_type="audio/wav",
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {"parakeet": "http://stt.local/v1/audio/transcriptions"},
            "http_timeout_seconds": 120.0,
        },
        provider_override="parakeet",
    )

    assert result.source_type == "audio"
    assert result.metadata["diarization_source"] == "pyannote_sidecar"
    assert "SPEAKER_00: hello" in result.transcript_text
    assert "SPEAKER_01: there" in result.transcript_text
    assert isinstance(result.metadata.get("timings_ms"), dict)
    assert result.metadata["timings_ms"].get("stt_ms") is not None


# ---------------------------------------------------------------------------
# _backend / ContextVar extraction tests (IndrasNet GPU coordinator wiring)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transcribe_audio_file_detailed_extracts_backend(tmp_path: Path):
    """When WhisperX response contains _backend, it populates detail.backend and the ContextVar."""
    from lct_python_backend.services.file_transcriber import _last_stt_backend

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "text": "hello",
                "segments": [{"start": 0.0, "end": 0.5, "text": "hello"}],
                "_backend": "local_whisperx",
            },
        )

    detail = await transcribe_audio_file_detailed(
        audio_path,
        http_url="http://stt.local/v1/audio/transcriptions",
        response_format="verbose_json",
        transport=httpx.MockTransport(handler),
    )

    assert detail.backend == "local_whisperx"
    assert _last_stt_backend.get("") == "local_whisperx"


@pytest.mark.asyncio
async def test_transcribe_audio_file_detailed_backend_empty_when_absent(tmp_path: Path):
    """When _backend is missing from response, detail.backend defaults to empty string."""
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF....WAVE")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"text": "world", "segments": [{"start": 0.0, "end": 0.5, "text": "world"}]},
        )

    detail = await transcribe_audio_file_detailed(
        audio_path,
        http_url="http://stt.local/v1/audio/transcriptions",
        response_format="verbose_json",
        transport=httpx.MockTransport(handler),
    )

    assert detail.backend == ""


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_surfaces_stt_backend_in_metadata(monkeypatch, tmp_path: Path):
    """stt_backend appears in metadata when IndrasNet proxy stamps _backend."""
    import lct_python_backend.services.file_transcriber as mod

    wav = _make_silent_wav(tmp_path, duration_s=1.5, name="gpu.wav")
    detail = AudioTranscriptionDetail(
        transcript_text="hello gpu",
        asr_segments=[{"start": 0.0, "end": 1.0, "text": "hello gpu"}],
        diarized_segments=None,
        raw_payload={"text": "hello gpu", "_backend": "modal_whisperx"},
        backend="modal_whisperx",
    )

    # parakeet + pyannote_enabled path calls transcribe_audio_file_detailed directly
    monkeypatch.setattr(mod, "STT_PARAKEET_PYANNOTE_ENABLED", True)
    monkeypatch.setattr(mod, "transcribe_audio_file_detailed", AsyncMock(return_value=detail))

    result = await mod.transcribe_uploaded_file(
        temp_path=wav,
        filename="gpu.wav",
        content_type="audio/wav",
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {"parakeet": "http://stt.local/v1/audio/transcriptions"},
            "http_timeout_seconds": 120.0,
        },
        provider_override="parakeet",
    )

    assert result.metadata.get("stt_backend") == "modal_whisperx"


@pytest.mark.asyncio
async def test_transcribe_uploaded_file_omits_stt_backend_when_empty(monkeypatch, tmp_path: Path):
    """stt_backend key is absent from metadata when not routed through IndrasNet."""
    import lct_python_backend.services.file_transcriber as mod

    wav = _make_silent_wav(tmp_path, duration_s=1.5, name="direct.wav")
    detail = AudioTranscriptionDetail(
        transcript_text="direct call",
        asr_segments=[{"start": 0.0, "end": 1.0, "text": "direct call"}],
        diarized_segments=None,
        raw_payload={"text": "direct call"},
        backend="",
    )

    monkeypatch.setattr(mod, "STT_PARAKEET_PYANNOTE_ENABLED", True)
    monkeypatch.setattr(mod, "transcribe_audio_file_detailed", AsyncMock(return_value=detail))

    result = await mod.transcribe_uploaded_file(
        temp_path=wav,
        filename="direct.wav",
        content_type="audio/wav",
        stt_settings={
            "provider": "parakeet",
            "provider_http_urls": {"parakeet": "http://stt.local/v1/audio/transcriptions"},
            "http_timeout_seconds": 120.0,
        },
        provider_override="parakeet",
    )

    assert "stt_backend" not in result.metadata

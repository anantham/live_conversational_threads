from pathlib import Path

import httpx
import pytest

from lct_python_backend.services.file_transcriber import (
    _decode_text_bytes,
    _split_audio_to_chunks,
    chunk_transcript_lines,
    detect_file_kind,
    looks_like_google_meet_text,
    parse_google_meet_text,
    parse_plain_text,
    parse_srt_text,
    parse_vtt_text,
    transcribe_audio_chunked,
    transcribe_audio_file,
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
            transport=httpx.MockTransport(handler),
        )

    # Verify no leftover stt_chunk_ temp files
    import glob
    import tempfile
    leftover = glob.glob(f"{tempfile.gettempdir()}/stt_chunk_*.wav")
    assert len(leftover) == 0


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

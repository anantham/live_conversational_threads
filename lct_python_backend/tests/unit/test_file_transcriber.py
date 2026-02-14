from pathlib import Path

import httpx
import pytest

from lct_python_backend.services.file_transcriber import (
    chunk_transcript_lines,
    detect_file_kind,
    looks_like_google_meet_text,
    parse_google_meet_text,
    parse_plain_text,
    parse_srt_text,
    parse_vtt_text,
    transcribe_audio_file,
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

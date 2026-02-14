# Bulk File Upload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accept audio/text file uploads on `/new`, process them through STT + chunking + LLM, and stream incremental graph data via SSE to the existing MinimalGraph.

**Architecture:** Single `POST /api/import/process-file` endpoint returns `text/event-stream`. Backend detects file type, transcribes audio if needed, feeds text through `TranscriptProcessor` (the same state machine used by live recording), and streams SSE events matching the existing WebSocket message contract. Frontend uses `fetch()` + `ReadableStream` to parse SSE frames.

**Tech Stack:** FastAPI (StreamingResponse), httpx (STT HTTP calls), React (fetch + ReadableStream), existing `TranscriptProcessor` + `sliding_window_chunking` + `generate_lct_json`

**Design doc:** `docs/plans/2026-02-15-bulk-file-upload-design.md`

---

## Task 1: file_transcriber.py — Text File Parsers

**Files:**
- Create: `lct_python_backend/services/file_transcriber.py`
- Create: `lct_python_backend/tests/unit/test_file_transcriber.py`

This service handles detecting file type and extracting plain text from uploaded files. Audio transcription is a separate function (Task 2).

### Step 1: Write failing tests for text extraction

Create `lct_python_backend/tests/unit/test_file_transcriber.py`:

```python
"""Tests for file_transcriber — file type detection and text extraction."""

import pytest

from lct_python_backend.services.file_transcriber import (
    detect_source_type,
    extract_text_from_file,
)


# ── detect_source_type ─────────────────────────────────────────────────────

class TestDetectSourceType:
    def test_auto_wav(self):
        assert detect_source_type("recording.wav", "auto") == "audio"

    def test_auto_mp3(self):
        assert detect_source_type("podcast.mp3", "auto") == "audio"

    def test_auto_m4a(self):
        assert detect_source_type("voice.m4a", "auto") == "audio"

    def test_auto_ogg(self):
        assert detect_source_type("clip.ogg", "auto") == "audio"

    def test_auto_flac(self):
        assert detect_source_type("lossless.flac", "auto") == "audio"

    def test_auto_webm(self):
        assert detect_source_type("browser.webm", "auto") == "audio"

    def test_auto_txt(self):
        assert detect_source_type("notes.txt", "auto") == "text"

    def test_auto_vtt(self):
        assert detect_source_type("captions.vtt", "auto") == "vtt"

    def test_auto_srt(self):
        assert detect_source_type("subtitles.srt", "auto") == "srt"

    def test_explicit_override(self):
        # Even if extension says .txt, explicit source_type wins
        assert detect_source_type("meet.txt", "google_meet") == "google_meet"

    def test_unknown_extension_raises(self):
        with pytest.raises(ValueError, match="Unsupported file"):
            detect_source_type("data.json", "auto")

    def test_no_extension_raises(self):
        with pytest.raises(ValueError, match="Unsupported file"):
            detect_source_type("noextension", "auto")

    def test_case_insensitive(self):
        assert detect_source_type("RECORDING.WAV", "auto") == "audio"
        assert detect_source_type("Notes.TXT", "auto") == "text"


# ── extract_text_from_file (text types only) ──────────────────────────────

class TestExtractTextFromFile:
    def test_plain_text(self, tmp_path):
        f = tmp_path / "transcript.txt"
        f.write_text("Hello world. This is a test transcript.", encoding="utf-8")
        result = extract_text_from_file(str(f), "text")
        assert result == "Hello world. This is a test transcript."

    def test_vtt_strips_headers_and_timestamps(self, tmp_path):
        vtt_content = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:04.000\n"
            "Hello from the first segment.\n\n"
            "00:00:05.000 --> 00:00:08.000\n"
            "And the second segment.\n"
        )
        f = tmp_path / "captions.vtt"
        f.write_text(vtt_content, encoding="utf-8")
        result = extract_text_from_file(str(f), "vtt")
        assert "Hello from the first segment." in result
        assert "And the second segment." in result
        assert "WEBVTT" not in result
        assert "-->" not in result

    def test_srt_strips_indices_and_timestamps(self, tmp_path):
        srt_content = (
            "1\n"
            "00:00:01,000 --> 00:00:04,000\n"
            "First subtitle line.\n\n"
            "2\n"
            "00:00:05,000 --> 00:00:08,000\n"
            "Second subtitle line.\n"
        )
        f = tmp_path / "subtitles.srt"
        f.write_text(srt_content, encoding="utf-8")
        result = extract_text_from_file(str(f), "srt")
        assert "First subtitle line." in result
        assert "Second subtitle line." in result
        assert "-->" not in result

    def test_empty_file_raises(self, tmp_path):
        f = tmp_path / "empty.txt"
        f.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="empty"):
            extract_text_from_file(str(f), "text")

    def test_audio_type_raises(self, tmp_path):
        f = tmp_path / "audio.wav"
        f.write_bytes(b"\x00" * 100)
        with pytest.raises(ValueError, match="Audio files"):
            extract_text_from_file(str(f), "audio")
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_file_transcriber.py -v`

Expected: `ModuleNotFoundError: No module named 'lct_python_backend.services.file_transcriber'`

### Step 3: Write minimal implementation

Create `lct_python_backend/services/file_transcriber.py`:

```python
"""File type detection and text extraction for uploaded files.

Handles plain text, VTT subtitles, SRT subtitles. Audio transcription
is handled separately via the HTTP STT provider.
"""

import logging
import re
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm"}
TEXT_EXTENSIONS = {".txt": "text", ".vtt": "vtt", ".srt": "srt"}

SourceType = Literal["audio", "text", "vtt", "srt", "google_meet"]


def detect_source_type(filename: str, source_type: str = "auto") -> SourceType:
    """Detect the processing pipeline based on filename and explicit override.

    Args:
        filename: Original upload filename.
        source_type: Explicit type ("auto" to detect from extension).

    Returns:
        One of: "audio", "text", "vtt", "srt", "google_meet".

    Raises:
        ValueError: If extension is unrecognized and source_type is "auto".
    """
    if source_type and source_type != "auto":
        return source_type  # type: ignore[return-value]

    ext = Path(filename or "").suffix.lower()
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in TEXT_EXTENSIONS:
        return TEXT_EXTENSIONS[ext]
    raise ValueError(
        f"Unsupported file extension '{ext}'. "
        f"Accepted: {', '.join(sorted(AUDIO_EXTENSIONS | set(TEXT_EXTENSIONS.keys())))}"
    )


def extract_text_from_file(file_path: str, source_type: SourceType) -> str:
    """Read a text/vtt/srt file and return cleaned transcript text.

    Args:
        file_path: Path to the uploaded file on disk.
        source_type: One of "text", "vtt", "srt".

    Returns:
        Cleaned transcript text as a single string.

    Raises:
        ValueError: If file is empty or source_type is "audio".
    """
    if source_type == "audio":
        raise ValueError("Audio files must be transcribed via STT, not read as text.")

    content = Path(file_path).read_text(encoding="utf-8").strip()
    if not content:
        raise ValueError("File is empty — nothing to process.")

    if source_type == "vtt":
        return _parse_vtt(content)
    if source_type == "srt":
        return _parse_srt(content)
    return content


# ── VTT / SRT parsers ─────────────────────────────────────────────────────

_TIMESTAMP_RE = re.compile(r"\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}")
_SRT_INDEX_RE = re.compile(r"^\d+$")


def _parse_vtt(raw: str) -> str:
    lines = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.upper().startswith("WEBVTT"):
            continue
        if _TIMESTAMP_RE.match(stripped):
            continue
        # Skip VTT cue settings lines (e.g., "align:start position:0%")
        if stripped.startswith("NOTE"):
            continue
        lines.append(stripped)
    return " ".join(lines)


def _parse_srt(raw: str) -> str:
    lines = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _SRT_INDEX_RE.match(stripped):
            continue
        if _TIMESTAMP_RE.match(stripped):
            continue
        lines.append(stripped)
    return " ".join(lines)
```

### Step 4: Run tests to verify they pass

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_file_transcriber.py -v`

Expected: All 14 tests PASS.

### Step 5: Commit

```bash
cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads
git add lct_python_backend/services/file_transcriber.py lct_python_backend/tests/unit/test_file_transcriber.py
git commit -m "feat(import): add file_transcriber service for text/vtt/srt extraction

MOTIVATION:
- Bulk file upload needs to detect file type and extract text
- VTT and SRT subtitle formats need timestamp stripping

CHANGES:
- file_transcriber.py: detect_source_type(), extract_text_from_file(), VTT/SRT parsers
- test_file_transcriber.py: 14 tests covering detection and extraction

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: file_transcriber.py — Audio Transcription Function

**Files:**
- Modify: `lct_python_backend/services/file_transcriber.py`
- Modify: `lct_python_backend/tests/unit/test_file_transcriber.py`

Add `transcribe_audio_file()` that POSTs the file to the HTTP STT provider (same endpoint used by `RealtimeHttpSttSession`).

### Step 1: Write failing test for audio transcription

Append to `lct_python_backend/tests/unit/test_file_transcriber.py`:

```python
import io
import wave
from unittest.mock import AsyncMock, patch

from lct_python_backend.services.file_transcriber import transcribe_audio_file


def _make_wav_bytes(duration_seconds: float = 0.5, sample_rate: int = 16000) -> bytes:
    """Create a minimal valid WAV file for testing."""
    num_frames = int(sample_rate * duration_seconds)
    with io.BytesIO() as buf:
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(b"\x00\x00" * num_frames)
        return buf.getvalue()


class TestTranscribeAudioFile:
    @pytest.mark.asyncio
    async def test_sends_file_to_stt_and_returns_text(self, tmp_path):
        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(_make_wav_bytes())

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = AsyncMock()
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"text": "hello world"}

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("lct_python_backend.services.file_transcriber.httpx.AsyncClient", return_value=mock_client):
            result = await transcribe_audio_file(
                str(wav_file),
                http_url="http://localhost:5092/v1/audio/transcriptions",
            )

        assert result == "hello world"
        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args
        assert "files" in call_kwargs.kwargs or "files" in (call_kwargs[1] if len(call_kwargs) > 1 else {})

    @pytest.mark.asyncio
    async def test_raises_on_empty_transcript(self, tmp_path):
        wav_file = tmp_path / "silence.wav"
        wav_file.write_bytes(_make_wav_bytes())

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = AsyncMock()
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"text": ""}

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("lct_python_backend.services.file_transcriber.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(ValueError, match="No transcript"):
                await transcribe_audio_file(
                    str(wav_file),
                    http_url="http://localhost:5092/v1/audio/transcriptions",
                )

    @pytest.mark.asyncio
    async def test_raises_on_no_http_url(self, tmp_path):
        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(_make_wav_bytes())
        with pytest.raises(ValueError, match="No STT HTTP URL"):
            await transcribe_audio_file(str(wav_file), http_url="")
```

### Step 2: Run tests to verify the new ones fail

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_file_transcriber.py::TestTranscribeAudioFile -v`

Expected: `ImportError: cannot import name 'transcribe_audio_file'`

### Step 3: Implement transcribe_audio_file

Add to `lct_python_backend/services/file_transcriber.py`:

```python
import httpx

from lct_python_backend.services.stt_http_transcriber import extract_transcript_text

DEFAULT_STT_TIMEOUT_SECONDS = 120.0  # longer timeout for full-file transcription


async def transcribe_audio_file(
    file_path: str,
    http_url: str,
    model: str = "",
    language: str = "",
    timeout_seconds: float = DEFAULT_STT_TIMEOUT_SECONDS,
) -> str:
    """Send an audio file to the HTTP STT provider and return transcript text.

    Args:
        file_path: Path to audio file on disk (.wav, .mp3, etc.).
        http_url: STT provider HTTP endpoint URL.
        model: Optional model name for the STT provider.
        language: Optional language hint.
        timeout_seconds: HTTP request timeout (default 120s for large files).

    Returns:
        Transcript text string.

    Raises:
        ValueError: If no URL configured or STT returns empty transcript.
        httpx.HTTPStatusError: If STT provider returns an error status.
    """
    if not http_url or not http_url.strip():
        raise ValueError("No STT HTTP URL configured. Check STT settings.")

    file_bytes = Path(file_path).read_bytes()
    filename = Path(file_path).name

    form_data = {}
    if model and model.strip():
        form_data["model"] = model.strip()
    if language and language.strip():
        form_data["language"] = language.strip()

    # Determine MIME type from extension
    ext = Path(file_path).suffix.lower()
    mime_map = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".webm": "audio/webm",
    }
    mime_type = mime_map.get(ext, "application/octet-stream")

    logger.info("[FILE STT] POST %s file=%s (%d bytes)", http_url, filename, len(file_bytes))

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(
            http_url,
            data=form_data,
            files={"file": (filename, file_bytes, mime_type)},
        )
        response.raise_for_status()

        # Reuse the flexible response parser from stt_http_transcriber
        payload = response.json() if "application/json" in response.headers.get("content-type", "") else {"text": response.text.strip()}
        text = extract_transcript_text(payload)

    if not text or not text.strip():
        raise ValueError("No transcript text returned from STT provider.")

    logger.info("[FILE STT] Got %d chars of transcript from %s", len(text), filename)
    return text.strip()
```

### Step 4: Run all file_transcriber tests

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_file_transcriber.py -v`

Expected: All 17 tests PASS (14 from Task 1 + 3 new).

### Step 5: Commit

```bash
cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads
git add lct_python_backend/services/file_transcriber.py lct_python_backend/tests/unit/test_file_transcriber.py
git commit -m "feat(import): add transcribe_audio_file for bulk audio upload

MOTIVATION:
- Bulk upload of audio files needs STT transcription
- Reuses extract_transcript_text from stt_http_transcriber

CHANGES:
- file_transcriber.py: transcribe_audio_file() sends file to HTTP STT provider
- test_file_transcriber.py: 3 async tests with mocked httpx client

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: process-file SSE Endpoint

**Files:**
- Modify: `lct_python_backend/import_api.py`
- Create: `lct_python_backend/tests/unit/test_process_file_endpoint.py`

The SSE endpoint ties together file_transcriber + TranscriptProcessor + sliding_window_chunking.

### Step 1: Write failing tests for the SSE endpoint

Create `lct_python_backend/tests/unit/test_process_file_endpoint.py`:

```python
"""Tests for POST /api/import/process-file SSE endpoint."""

import io
import json

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from fastapi.testclient import TestClient


def _make_test_app():
    """Create a minimal FastAPI app with just the import router."""
    from fastapi import FastAPI
    from lct_python_backend.import_api import router
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client():
    app = _make_test_app()
    return TestClient(app)


class TestProcessFileEndpoint:
    def test_rejects_missing_file(self, client):
        response = client.post("/api/import/process-file")
        assert response.status_code == 422  # FastAPI validation error

    def test_rejects_unsupported_extension(self, client):
        response = client.post(
            "/api/import/process-file",
            files={"file": ("data.json", b'{"key": "value"}', "application/json")},
        )
        assert response.status_code == 400
        assert "Unsupported" in response.text

    @patch("lct_python_backend.import_api.TranscriptProcessor")
    @patch("lct_python_backend.import_api.sliding_window_chunking")
    def test_text_file_streams_sse_events(self, mock_chunking, mock_processor_cls, client):
        # sliding_window_chunking returns a single chunk
        mock_chunking.return_value = {"chunk-1": "Hello world this is a test."}

        # Mock the TranscriptProcessor instance
        mock_processor = AsyncMock()
        mock_processor.existing_json = [{"node_name": "Test", "chunk_id": "chunk-1"}]
        mock_processor.chunk_dict = {"chunk-1": "Hello world this is a test."}
        mock_processor.handle_final_text = AsyncMock()
        mock_processor.flush = AsyncMock()
        mock_processor_cls.return_value = mock_processor

        response = client.post(
            "/api/import/process-file",
            files={"file": ("transcript.txt", b"Hello world this is a test.", "text/plain")},
            data={"source_type": "text"},
        )

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Parse SSE events from response body
        events = _parse_sse_events(response.text)

        # Should have at least: upload status, analyze status, done
        event_types = [e.get("type") for e in events]
        assert "processing_status" in event_types
        assert "done" in event_types

    @patch("lct_python_backend.import_api.transcribe_audio_file", new_callable=AsyncMock)
    @patch("lct_python_backend.import_api.TranscriptProcessor")
    @patch("lct_python_backend.import_api.sliding_window_chunking")
    def test_audio_file_calls_stt_then_streams(
        self, mock_chunking, mock_processor_cls, mock_transcribe, client
    ):
        mock_transcribe.return_value = "transcribed audio text"
        mock_chunking.return_value = {"chunk-1": "transcribed audio text"}

        mock_processor = AsyncMock()
        mock_processor.existing_json = [{"node_name": "Audio Node", "chunk_id": "chunk-1"}]
        mock_processor.chunk_dict = {"chunk-1": "transcribed audio text"}
        mock_processor.handle_final_text = AsyncMock()
        mock_processor.flush = AsyncMock()
        mock_processor_cls.return_value = mock_processor

        # Create a minimal WAV header
        import wave
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 100)
        wav_bytes = wav_buf.getvalue()

        response = client.post(
            "/api/import/process-file",
            files={"file": ("recording.wav", wav_bytes, "audio/wav")},
        )

        assert response.status_code == 200
        mock_transcribe.assert_called_once()

        events = _parse_sse_events(response.text)
        event_types = [e.get("type") for e in events]
        assert "done" in event_types


def _parse_sse_events(raw_text: str) -> list:
    """Parse SSE-formatted text into a list of JSON event dicts."""
    events = []
    for block in raw_text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        for line in block.split("\n"):
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[6:]))
                except json.JSONDecodeError:
                    pass
    return events
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_process_file_endpoint.py -v`

Expected: FAIL (no `process-file` route exists yet).

### Step 3: Implement the SSE endpoint

Add to `lct_python_backend/import_api.py`. New imports at the top of the file:

```python
import asyncio
import json
import uuid

from fastapi import Request
from fastapi.responses import StreamingResponse

from lct_python_backend.services.file_transcriber import (
    detect_source_type,
    extract_text_from_file,
    transcribe_audio_file,
)
from lct_python_backend.services.llm_helpers import sliding_window_chunking
from lct_python_backend.services.transcript_processing import TranscriptProcessor
from lct_python_backend.services.stt_config import get_env_stt_defaults
```

New route (add before the `/health` route):

```python
@router.post("/process-file")
async def process_file(
    request: Request,
    file: UploadFile = File(..., description="Audio or text file to process"),
    source_type: str = Form("auto"),
    conversation_id: Optional[str] = Form(None),
    speaker_id: str = Form("speaker_1"),
):
    """Upload a file and stream graph data as SSE events.

    Accepts audio files (transcribed via HTTP STT) or text files
    (plain text, VTT, SRT). Processes through TranscriptProcessor
    and streams incremental graph updates matching the WebSocket
    message contract.

    Returns: text/event-stream with SSE frames.
    """
    # Detect file type before starting the stream
    try:
        detected_type = detect_source_type(file.filename or "", source_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Read file content into memory (bounded by MAX_BODY_BYTES middleware)
    file_bytes = await file.read()
    file_size = len(file_bytes)
    conv_id = conversation_id or str(uuid.uuid4())

    async def event_stream():
        """Generator that yields SSE frames."""
        try:
            # ── Stage: upload ──────────────────────────────────────
            yield _sse_frame({
                "type": "processing_status",
                "level": "info",
                "message": f"File received ({_human_size(file_size)})",
                "context": {"stage": "upload", "bytes_total": file_size},
            })

            # ── Stage: transcribe (audio) or read (text) ──────────
            if detected_type == "audio":
                yield _sse_frame({
                    "type": "processing_status",
                    "level": "info",
                    "message": "Transcribing audio...",
                    "context": {"stage": "transcribe", "bytes_total": file_size, "bytes_processed": 0},
                })

                # Save to temp file for STT
                temp_path = Path(f"/tmp/lct_upload_{conv_id}{Path(file.filename or 'audio.wav').suffix}")
                temp_path.write_bytes(file_bytes)

                try:
                    stt_config = get_env_stt_defaults()
                    transcript_text = await transcribe_audio_file(
                        str(temp_path),
                        http_url=stt_config.get("http_url", ""),
                        model=stt_config.get("http_model", ""),
                        language=stt_config.get("http_language", ""),
                    )
                finally:
                    temp_path.unlink(missing_ok=True)

            elif detected_type == "google_meet":
                yield _sse_frame({
                    "type": "processing_status",
                    "level": "info",
                    "message": "Parsing Google Meet transcript...",
                    "context": {"stage": "transcribe"},
                })
                # Save temp and use existing import pipeline to get text
                temp_path = Path(f"/tmp/lct_upload_{conv_id}.txt")
                temp_path.write_bytes(file_bytes)
                try:
                    from lct_python_backend.services.import_orchestrator import parse_transcript
                    _parser, parsed = parse_transcript(str(temp_path), is_file=True)
                    transcript_text = " ".join(u.text for u in parsed.utterances)
                finally:
                    temp_path.unlink(missing_ok=True)

            else:
                # text, vtt, srt
                temp_path = Path(f"/tmp/lct_upload_{conv_id}{Path(file.filename or 'file.txt').suffix}")
                temp_path.write_bytes(file_bytes)
                try:
                    transcript_text = extract_text_from_file(str(temp_path), detected_type)
                finally:
                    temp_path.unlink(missing_ok=True)

            if not transcript_text or not transcript_text.strip():
                yield _sse_frame({
                    "type": "processing_status",
                    "level": "error",
                    "message": "No text content extracted from file.",
                    "context": {"stage": "transcribe"},
                })
                return

            # ── Stage: analyze ─────────────────────────────────────
            chunks = sliding_window_chunking(transcript_text)
            chunks_total = len(chunks)

            yield _sse_frame({
                "type": "processing_status",
                "level": "info",
                "message": f"Generating graph nodes ({chunks_total} chunk{'s' if chunks_total != 1 else ''})...",
                "context": {"stage": "analyze", "chunks_total": chunks_total, "chunks_done": 0},
            })

            # Set up TranscriptProcessor with SSE callbacks
            collected_json = []
            collected_chunks = {}

            async def send_update(existing_json, chunk_dict):
                nonlocal collected_json, collected_chunks
                collected_json = existing_json
                collected_chunks = chunk_dict

            async def send_status(level, message, context):
                pass  # We handle our own status messages

            processor = TranscriptProcessor(
                send_update=send_update,
                send_status=send_status,
            )

            chunks_done = 0
            for chunk_id, chunk_text in chunks.items():
                # Check if client disconnected
                if await request.is_disconnected():
                    logger.info("[PROCESS FILE] Client disconnected, aborting.")
                    return

                await processor.handle_final_text(chunk_text)
                await processor.flush()
                chunks_done += 1

                # Emit incremental graph update
                if collected_json:
                    yield _sse_frame({
                        "type": "existing_json",
                        "data": collected_json,
                    })
                if collected_chunks:
                    yield _sse_frame({
                        "type": "chunk_dict",
                        "data": collected_chunks,
                    })

                yield _sse_frame({
                    "type": "processing_status",
                    "level": "info",
                    "message": f"Analyzing chunk {chunks_done} of {chunks_total}...",
                    "context": {"stage": "analyze", "chunks_total": chunks_total, "chunks_done": chunks_done},
                })

            # ── Stage: done ────────────────────────────────────────
            yield _sse_frame({
                "type": "done",
                "conversation_id": conv_id,
                "node_count": len(collected_json),
            })

        except Exception as exc:
            logger.error("[PROCESS FILE] Error: %s", exc, exc_info=True)
            yield _sse_frame({
                "type": "processing_status",
                "level": "error",
                "message": str(exc),
                "context": {"stage": "error"},
            })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _sse_frame(data: dict) -> str:
    """Format a dict as an SSE data frame."""
    return f"data: {json.dumps(data)}\n\n"


def _human_size(nbytes: int) -> str:
    """Format bytes as human-readable string."""
    if nbytes < 1024:
        return f"{nbytes} B"
    if nbytes < 1024 * 1024:
        return f"{nbytes / 1024:.1f} KB"
    return f"{nbytes / (1024 * 1024):.1f} MB"
```

### Step 4: Run tests

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads && .venv/bin/python3 -m pytest lct_python_backend/tests/unit/test_process_file_endpoint.py -v`

Expected: All 4 tests PASS.

### Step 5: Commit

```bash
cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads
git add lct_python_backend/import_api.py lct_python_backend/tests/unit/test_process_file_endpoint.py
git commit -m "feat(import): add POST /api/import/process-file SSE endpoint

MOTIVATION:
- Users want to upload pre-recorded audio or text files
- Processes through same TranscriptProcessor as live recording
- Streams incremental graph data via SSE matching WS contract

CHANGES:
- import_api.py: process_file() endpoint with SSE streaming
- test_process_file_endpoint.py: 4 tests (missing file, bad ext, text flow, audio flow)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: FileUpload.jsx — Frontend Upload Component

**Files:**
- Create: `lct_app/src/components/FileUpload.jsx`

This component provides the upload button, fetch+SSE parsing, progress display, and cancel button.

### Step 1: Create FileUpload.jsx

Create `lct_app/src/components/FileUpload.jsx`:

```jsx
import { useCallback, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Upload, X } from "lucide-react";

const ACCEPTED_EXTENSIONS = ".wav,.mp3,.m4a,.ogg,.flac,.webm,.txt,.vtt,.srt";

const STAGE_LABELS = {
  upload: "Uploading...",
  transcribe: "Transcribing audio...",
  analyze: "Analyzing...",
  done: "Complete",
};

export default function FileUpload({
  onDataReceived,
  onChunksReceived,
  conversationId,
  disabled,
}) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null); // { stage, message, chunks_done, chunks_total }
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);

  const handleFileSelect = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset input so same file can be re-selected
      e.target.value = "";

      setUploading(true);
      setError("");
      setProgress({ stage: "upload", message: "Uploading..." });

      const controller = new AbortController();
      abortRef.current = controller;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("source_type", "auto");
      if (conversationId) {
        formData.append("conversation_id", conversationId);
      }

      try {
        const response = await fetch("/api/import/process-file", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 413) {
            throw new Error("File too large (max 50 MB)");
          }
          const text = await response.text();
          throw new Error(text || `Upload failed (${response.status})`);
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Split on double-newline SSE boundaries
          const frames = buffer.split("\n\n");
          // Keep the last incomplete frame in the buffer
          buffer = frames.pop() || "";

          for (const frame of frames) {
            const trimmed = frame.trim();
            if (!trimmed) continue;

            for (const line of trimmed.split("\n")) {
              if (!line.startsWith("data: ")) continue;

              try {
                const event = JSON.parse(line.slice(6));
                _handleSSEEvent(event, {
                  onDataReceived,
                  onChunksReceived,
                  setProgress,
                  setError,
                  setUploading,
                });
              } catch {
                // Ignore malformed JSON lines
              }
            }
          }
        }
      } catch (err) {
        if (err.name === "AbortError") {
          setProgress(null);
        } else {
          setError(err.message || "Upload failed");
        }
      } finally {
        setUploading(false);
        abortRef.current = null;
      }
    },
    [conversationId, onDataReceived, onChunksReceived]
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setUploading(false);
    setProgress(null);
  }, []);

  const handleButtonClick = useCallback(() => {
    if (uploading) {
      handleCancel();
    } else {
      fileInputRef.current?.click();
    }
  }, [uploading, handleCancel]);

  // Auto-dismiss errors after 6s
  if (error) {
    setTimeout(() => setError(""), 6000);
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        onChange={handleFileSelect}
        className="hidden"
        aria-label="Upload audio or text file"
      />

      {/* Upload/Cancel button */}
      <button
        onClick={handleButtonClick}
        disabled={disabled && !uploading}
        className={`relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none ${
          uploading
            ? "bg-amber-100 text-amber-600 hover:bg-amber-200"
            : disabled
            ? "bg-gray-50 text-gray-300 cursor-not-allowed"
            : "bg-gray-100 text-gray-500 hover:bg-gray-200"
        }`}
        aria-label={uploading ? "Cancel upload" : "Upload file"}
        title={uploading ? "Cancel upload" : "Upload audio or text file"}
      >
        {uploading ? <X size={18} /> : <Upload size={18} />}
      </button>

      {/* Progress indicator */}
      {uploading && progress && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-700 text-center">
            {progress.chunks_total
              ? `Analyzing chunk ${progress.chunks_done || 0} of ${progress.chunks_total}...`
              : STAGE_LABELS[progress.stage] || progress.message}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && !uploading && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 text-center shadow-sm">
            {error}
          </div>
        </div>
      )}
    </>
  );
}

function _handleSSEEvent(event, { onDataReceived, onChunksReceived, setProgress, setError, setUploading }) {
  switch (event.type) {
    case "existing_json":
      onDataReceived?.(event.data);
      break;

    case "chunk_dict":
      onChunksReceived?.(event.data);
      break;

    case "processing_status": {
      const ctx = event.context || {};
      if (event.level === "error") {
        setError(event.message);
        setUploading(false);
      } else {
        setProgress({
          stage: ctx.stage || "analyze",
          message: event.message,
          chunks_done: ctx.chunks_done,
          chunks_total: ctx.chunks_total,
        });
      }
      break;
    }

    case "done":
      setProgress({ stage: "done", message: "Complete" });
      break;

    default:
      break;
  }
}

FileUpload.propTypes = {
  onDataReceived: PropTypes.func,
  onChunksReceived: PropTypes.func,
  conversationId: PropTypes.string,
  disabled: PropTypes.bool,
};
```

### Step 2: Verify build passes

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads/lct_app && npm run build 2>&1 | tail -5`

Expected: Build succeeds (component not yet wired in, but syntax should be valid).

### Step 3: Commit

```bash
cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads
git add lct_app/src/components/FileUpload.jsx
git commit -m "feat(ui): add FileUpload component with SSE stream parsing

MOTIVATION:
- Users need an upload button to process pre-recorded files
- Uses fetch + ReadableStream for SSE parsing (EventSource is GET-only)

CHANGES:
- FileUpload.jsx: upload button, progress indicator, cancel, SSE event routing

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Wire FileUpload into NewConversation.jsx

**Files:**
- Modify: `lct_app/src/pages/NewConversation.jsx:1-7` (imports)
- Modify: `lct_app/src/pages/NewConversation.jsx:56-63` (state)
- Modify: `lct_app/src/pages/NewConversation.jsx:186-200` (footer JSX)

### Step 1: Add import and state

At top of `NewConversation.jsx`, add FileUpload import:

```jsx
import FileUpload from "../components/FileUpload";
```

Add `uploading` state to track when FileUpload is active (for disabling the mic):

```jsx
const [uploading, setUploading] = useState(false);
```

### Step 2: Add FileUpload to the audio footer

In the footer `<div>` (around line 186), add FileUpload next to AudioInput. Also pass `disabled={uploading}` concept — but AudioInput doesn't have a `disabled` prop, so we wrap with a simple conditional.

Replace the footer div content to include FileUpload alongside AudioInput:

```jsx
{/* Audio footer */}
<div className="shrink-0 w-full py-2 px-4 flex items-center justify-center gap-2 border-t border-gray-100 bg-white/80 backdrop-blur-sm relative">
  <AudioInput
    ref={audioRef}
    onDataReceived={handleDataReceived}
    onChunksReceived={handleChunksReceived}
    chunkDict={chunkDict}
    graphData={graphData}
    conversationId={conversationId}
    setConversationId={setConversationId}
    setMessage={setMessage}
    message={message}
    fileName={fileName}
    setFileName={setFileName}
  />
  <FileUpload
    onDataReceived={handleDataReceived}
    onChunksReceived={handleChunksReceived}
    conversationId={conversationId}
    disabled={false}
  />
</div>
```

### Step 3: Verify build passes

Run: `cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads/lct_app && npm run build 2>&1 | tail -5`

Expected: Build succeeds.

### Step 4: Manual test

1. Start backend: `cd lct_python_backend && ../.venv/bin/python3 -m uvicorn backend:app --reload --port 8000`
2. Start frontend: `cd lct_app && npm run dev`
3. Navigate to `http://localhost:5173/new`
4. Verify upload button (Upload icon) appears next to the mic button
5. Click upload button → file picker opens
6. Select a `.txt` file → progress indicator appears → graph nodes render
7. Click X during upload → upload cancels

### Step 5: Commit

```bash
cd /Users/aditya/Documents/Ongoing\ Local/live_conversational_threads
git add lct_app/src/pages/NewConversation.jsx
git commit -m "feat(ui): wire FileUpload into /new page footer

MOTIVATION:
- Upload button now visible next to mic on /new
- Reuses handleDataReceived and handleChunksReceived unchanged

CHANGES:
- NewConversation.jsx: import FileUpload, add to footer alongside AudioInput

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Summary

| Task | Files | Tests | LOC est |
|------|-------|-------|---------|
| 1. Text parsers | `file_transcriber.py` (new), `test_file_transcriber.py` (new) | 14 | ~100 |
| 2. Audio transcription | `file_transcriber.py` (modify), `test_file_transcriber.py` (modify) | 3 | ~50 |
| 3. SSE endpoint | `import_api.py` (modify), `test_process_file_endpoint.py` (new) | 4 | ~130 |
| 4. FileUpload component | `FileUpload.jsx` (new) | build check | ~150 |
| 5. Wire into page | `NewConversation.jsx` (modify) | build + manual | ~5 |
| **Total** | **4 new files, 2 modified** | **21 tests** | **~435 LOC** |

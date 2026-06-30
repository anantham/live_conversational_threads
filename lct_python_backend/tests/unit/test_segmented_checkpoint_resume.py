"""Tests for segmented transcription checkpoint/resume.

Verifies that transcribe_audio_segmented skips already-checkpointed segments
and yields cached text instead of making expensive STT calls.
"""

from unittest.mock import AsyncMock, patch

import pytest

from lct_python_backend.services.transcript.transcription_utils import SegmentResult


@pytest.mark.asyncio
async def test_segmented_resume_skips_cached_segments(monkeypatch):
    """Segments <= resume_from_segment should yield cached text without STT calls."""
    import lct_python_backend.services.audio_transcriber as mod

    # 4 segments, first 2 already checkpointed
    boundaries = [0, 10000, 20000, 30000, 40000]  # 4 segments
    cached_texts = ["cached segment one", "cached segment two"]

    monkeypatch.setattr(mod, "detect_segment_boundaries", lambda *a, **kw: boundaries)

    # Track whether transcribe_audio_chunked is called
    stt_calls = []

    async def fake_transcribe_chunked(audio_path, **kwargs):
        stt_calls.append(str(audio_path))
        return f"fresh transcript for {audio_path.name}"

    monkeypatch.setattr(mod, "transcribe_audio_chunked", fake_transcribe_chunked)
    monkeypatch.setattr(mod, "extract_audio_segment", lambda fp, start, end: fp / f"seg-{start}-{end}.wav")

    from pathlib import Path

    results: list[SegmentResult] = []
    async for seg in mod.transcribe_audio_segmented(
        file_path=Path("/fake/audio.mp3"),
        http_url="http://stt.test/transcribe",
        resume_from_segment=2,
        resumed_segment_texts=cached_texts,
    ):
        results.append(seg)

    assert len(results) == 4

    # First 2 segments: cached, no STT call
    assert results[0].transcript_text == "cached segment one"
    assert results[0].metadata.get("resumed") is True
    assert results[0].elapsed_ms == 0

    assert results[1].transcript_text == "cached segment two"
    assert results[1].metadata.get("resumed") is True

    # Segments 3 and 4: fresh STT calls
    assert "fresh transcript" in results[2].transcript_text
    assert results[2].metadata.get("resumed") is None
    assert "fresh transcript" in results[3].transcript_text

    # Only 2 STT calls made (segments 3 and 4)
    assert len(stt_calls) == 2


@pytest.mark.asyncio
async def test_segmented_no_resume_processes_all(monkeypatch):
    """With resume_from_segment=0, all segments go through STT."""
    import lct_python_backend.services.audio_transcriber as mod

    boundaries = [0, 10000, 20000, 30000]  # 3 segments
    monkeypatch.setattr(mod, "detect_segment_boundaries", lambda *a, **kw: boundaries)

    stt_calls = []

    async def fake_transcribe_chunked(audio_path, **kwargs):
        stt_calls.append(1)
        return "text"

    monkeypatch.setattr(mod, "transcribe_audio_chunked", fake_transcribe_chunked)
    monkeypatch.setattr(mod, "extract_audio_segment", lambda fp, start, end: fp / f"seg.wav")

    from pathlib import Path

    results = []
    async for seg in mod.transcribe_audio_segmented(
        file_path=Path("/fake/audio.mp3"),
        http_url="http://stt.test/transcribe",
        resume_from_segment=0,
    ):
        results.append(seg)

    assert len(results) == 3
    assert len(stt_calls) == 3
    assert all(r.metadata.get("resumed") is None for r in results)


@pytest.mark.asyncio
async def test_segmented_resume_preserves_segment_metadata(monkeypatch):
    """Resumed segments still have correct index, total, and timing metadata."""
    import lct_python_backend.services.audio_transcriber as mod

    boundaries = [0, 5000, 15000]  # 2 segments
    monkeypatch.setattr(mod, "detect_segment_boundaries", lambda *a, **kw: boundaries)

    async def fake_transcribe_chunked(audio_path, **kwargs):
        return "new text"

    monkeypatch.setattr(mod, "transcribe_audio_chunked", fake_transcribe_chunked)
    monkeypatch.setattr(mod, "extract_audio_segment", lambda fp, start, end: fp / f"seg.wav")

    from pathlib import Path

    results = []
    async for seg in mod.transcribe_audio_segmented(
        file_path=Path("/fake/audio.mp3"),
        http_url="http://stt.test/transcribe",
        resume_from_segment=1,
        resumed_segment_texts=["cached first segment"],
    ):
        results.append(seg)

    # Segment 1: resumed
    assert results[0].segment_index == 1
    assert results[0].segment_total == 2
    assert results[0].start_ms == 0
    assert results[0].end_ms == 5000
    assert results[0].metadata["duration_ms"] == 5000

    # Segment 2: fresh
    assert results[1].segment_index == 2
    assert results[1].segment_total == 2
    assert results[1].transcript_text == "new text"

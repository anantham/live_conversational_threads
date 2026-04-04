from pathlib import Path
from unittest.mock import AsyncMock

import pytest


def _write_chunk_file(path: Path, name: str) -> Path:
    chunk_path = path / name
    chunk_path.write_bytes(b"RIFF....WAVE")
    return chunk_path


@pytest.mark.asyncio
async def test_cloud_upload_retries_same_provider_chunk_then_succeeds(monkeypatch, tmp_path: Path):
    import lct_python_backend.services.file_transcriber as mod

    chunk_path = _write_chunk_file(tmp_path, "chunk-1.wav")
    sleep_mock = AsyncMock()
    transcribe_candidate_mock = AsyncMock(
        side_effect=[
            {
                "ok": False,
                "error": "stt provider request failed (503)",
            },
            {
                "ok": True,
                "text": "hello from retry",
                "segments": [],
            },
        ]
    )

    monkeypatch.setattr(
        mod,
        "resolve_import_audio_candidates",
        lambda **kwargs: [
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "model": "gpt-4o-mini-transcribe",
            }
        ],
    )
    monkeypatch.setattr(
        mod,
        "_split_audio_to_chunks",
        lambda *args, **kwargs: [(chunk_path, 0, 1000)],
    )
    monkeypatch.setattr(mod, "transcribe_wav_stt_candidate", transcribe_candidate_mock)
    monkeypatch.setattr(mod.asyncio, "sleep", sleep_mock)

    progress_calls = []

    async def on_chunk_progress(chunk_idx: int, total: int, chunk_text: str):
        progress_calls.append((chunk_idx, total, chunk_text))

    result = await mod.transcribe_uploaded_file(
        temp_path=chunk_path,
        filename="clip.wav",
        content_type="audio/wav",
        stt_settings={"http_timeout_seconds": 10.0},
        provider_override="openai_audio",
        on_chunk_progress=on_chunk_progress,
    )

    assert transcribe_candidate_mock.await_count == 2
    sleep_mock.assert_awaited_once_with(mod.DEFAULT_CHUNK_RETRY_BACKOFF_S)
    assert result.transcript_text == "hello from retry"
    assert progress_calls == [(1, 1, "hello from retry")]


@pytest.mark.asyncio
async def test_cloud_upload_resume_skips_cached_chunk_replay_in_progress_callback(monkeypatch, tmp_path: Path):
    import lct_python_backend.services.file_transcriber as mod

    source_path = _write_chunk_file(tmp_path, "source.wav")
    first_chunk = _write_chunk_file(tmp_path, "chunk-1.wav")
    second_chunk = _write_chunk_file(tmp_path, "chunk-2.wav")

    transcribe_candidate_mock = AsyncMock(
        return_value={
            "ok": True,
            "text": "fresh second chunk",
            "segments": [],
        }
    )

    monkeypatch.setattr(
        mod,
        "resolve_import_audio_candidates",
        lambda **kwargs: [
            {
                "provider": "openai_audio",
                "transport": "openai_audio",
                "http_url": "https://api.openai.com/v1/audio/transcriptions",
                "model": "gpt-4o-mini-transcribe",
            }
        ],
    )
    monkeypatch.setattr(
        mod,
        "_split_audio_to_chunks",
        lambda *args, **kwargs: [
            (first_chunk, 0, 1000),
            (second_chunk, 1000, 2000),
        ],
    )
    monkeypatch.setattr(mod, "transcribe_wav_stt_candidate", transcribe_candidate_mock)

    progress_calls = []

    async def on_chunk_progress(chunk_idx: int, total: int, chunk_text: str):
        progress_calls.append((chunk_idx, total, chunk_text))

    result = await mod.transcribe_uploaded_file(
        temp_path=source_path,
        filename="clip.wav",
        content_type="audio/wav",
        stt_settings={"http_timeout_seconds": 10.0},
        provider_override="openai_audio",
        on_chunk_progress=on_chunk_progress,
        resume_from_chunk=1,
        resumed_chunk_texts=["cached first chunk"],
    )

    transcribe_candidate_mock.assert_awaited_once()
    assert result.transcript_text == "cached first chunk\nfresh second chunk"
    assert progress_calls == [(1, 2, ""), (2, 2, "fresh second chunk")]

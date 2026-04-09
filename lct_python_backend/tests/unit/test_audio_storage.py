import subprocess
import wave

import pytest

from lct_python_backend.services import audio_storage
from lct_python_backend.services.audio_storage import AudioStorageManager


def test_audio_storage_init_does_not_require_event_loop(tmp_path):
    manager = AudioStorageManager(str(tmp_path))

    assert manager._lock is None


@pytest.mark.asyncio
async def test_finalize_preserves_pcm_on_wav_failure(tmp_path, monkeypatch):
    manager = AudioStorageManager(str(tmp_path))
    conversation_id = "conv-preserve"
    await manager.append_chunk(conversation_id, b"\x00\x01")

    pcm_path = tmp_path / f"{conversation_id}.pcm"
    assert pcm_path.exists()

    def failing_open(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(audio_storage.wave, "open", failing_open)

    result = await manager.finalize(conversation_id)

    assert result["wav_path"] is None
    assert result["flac_path"] is None
    assert pcm_path.exists()


@pytest.mark.asyncio
async def test_finalize_ffmpeg_uses_wav_input(tmp_path, monkeypatch):
    manager = AudioStorageManager(str(tmp_path))
    conversation_id = "conv-ffmpeg"
    await manager.append_chunk(conversation_id, b"\x00\x01" * 16)

    captured = {}

    monkeypatch.setattr(audio_storage.shutil, "which", lambda _name: "ffmpeg")

    def fake_run(args, **kwargs):
        captured["args"] = args
        return subprocess.CompletedProcess(args=args, returncode=0)

    monkeypatch.setattr(audio_storage.subprocess, "run", fake_run)

    result = await manager.finalize(conversation_id)

    assert result["wav_path"] is not None
    assert result["flac_path"] is not None
    assert captured["args"][0] == "ffmpeg"
    assert "-i" in captured["args"]
    assert "s16le" not in captured["args"]


@pytest.mark.asyncio
async def test_finalize_stitches_existing_wav_with_new_pcm(tmp_path, monkeypatch):
    manager = AudioStorageManager(str(tmp_path))
    conversation_id = "conv-stitch"
    wav_path = tmp_path / f"{conversation_id}.wav"

    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b"\x01\x02" * 10)

    await manager.append_chunk(conversation_id, b"\x03\x04" * 5)
    monkeypatch.setattr(audio_storage.shutil, "which", lambda _name: None)

    result = await manager.finalize(conversation_id)

    assert result["wav_path"] == str(wav_path)
    with wave.open(str(wav_path), "rb") as stitched_wav:
        frames = stitched_wav.readframes(stitched_wav.getnframes())

    assert frames == (b"\x01\x02" * 10) + (b"\x03\x04" * 5)


def test_get_status_reports_pcm_and_saved_outputs(tmp_path):
    manager = AudioStorageManager(str(tmp_path))
    conversation_id = "conv-status"
    pcm_path = tmp_path / f"{conversation_id}.pcm"
    wav_path = tmp_path / f"{conversation_id}.wav"

    pcm_path.write_bytes(b"\x00\x01" * 4)
    wav_path.write_bytes(b"fakewav")

    status = manager.get_status(conversation_id)

    assert status["has_pcm"] is True
    assert status["has_wav"] is True
    assert status["pcm_path"] == str(pcm_path)
    assert status["wav_path"] == str(wav_path)
    assert status["bytes_written"] == pcm_path.stat().st_size

import subprocess

import pytest

from lct_python_backend.services import audio_storage
from lct_python_backend.services.audio_storage import AudioStorageManager


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

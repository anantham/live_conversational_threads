"""Regression tests for the STT anti-hallucination fix (#1).

Test intent:
  1. The repeat-loop attractor (endless "thank you"/"excuse me") — broken by
     condition_on_previous_text=False in ANTI_HALLUCINATION_OPTS.
  2. Hallucinated filler on silence/ambient — caught by the silero-vad no-speech
     gate, while speech regions and relative levels remain visible as JSON-safe
     evidence for later cropping policy.
  3. Blocking model compute must not freeze health checks, and excess requests
     must receive an explicit retryable saturation response instead of queueing.

Run: lct_python_backend/local_stt/.venv/bin/python -m pytest test_server_stt.py -q
(Set STT_SPEECH_FIXTURE=/path/to/speech.wav to also exercise the speech-passes case;
skipped by default so CI needs no private audio.)
"""
import asyncio
import os
import sys
import tempfile
import threading
import types
import wave

import httpx
import pytest

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


def _write_silence_wav(path, seconds=5.0, sr=16000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(seconds * sr))


def test_anti_hallucination_opts_break_the_repeat_loop():
    # condition_on_previous_text=False is THE fix for the endless-repeat attractor;
    # if a future change flips it back on, the loop bug returns — fail here first.
    assert server.ANTI_HALLUCINATION_OPTS["condition_on_previous_text"] is False
    assert server.ANTI_HALLUCINATION_OPTS["no_speech_threshold"] >= 0.5


def test_vad_gate_finds_no_speech_in_silence():
    if server._get_vad() is None:
        pytest.skip("silero-vad unavailable in this env")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        _write_silence_wav(path, seconds=5.0)
        # No voice activity -> the handler's gate returns empty instead of letting
        # the model hallucinate. _has_speech must be exactly False (not None).
        assert server._has_speech(path) is False
    finally:
        os.unlink(path)


def test_vad_gate_passes_real_speech():
    fixture = os.getenv("STT_SPEECH_FIXTURE")
    if not fixture or not os.path.exists(fixture):
        pytest.skip("set STT_SPEECH_FIXTURE to a speech wav to run this")
    if server._get_vad() is None:
        pytest.skip("silero-vad unavailable in this env")
    assert server._has_speech(fixture) is True


@pytest.mark.asyncio
async def test_blocking_transcription_keeps_health_live_and_sheds_overflow(monkeypatch):
    entered = threading.Event()
    release = threading.Event()

    def blocking_transcribe(_path, **_kwargs):
        entered.set()
        if not release.wait(timeout=5):
            raise TimeoutError("test did not release the fake model")
        return {"text": "hello", "segments": [], "language": "en"}

    monkeypatch.setitem(
        sys.modules,
        "mlx_whisper",
        types.SimpleNamespace(transcribe=blocking_transcribe),
    )
    monkeypatch.setattr(server, "VAD_GATE", False)
    monkeypatch.setattr(server, "MAX_CONCURRENCY", 1)
    monkeypatch.setattr(server, "RETRY_AFTER_S", 7)
    monkeypatch.setattr(server, "_slots", asyncio.BoundedSemaphore(1))
    server._inflight["n"] = 0

    transport = httpx.ASGITransport(app=server.app)
    first_request = None
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first_request = asyncio.create_task(
                client.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("first.wav", b"not-real-audio", "audio/wav")},
                )
            )
            assert await asyncio.to_thread(entered.wait, 2), "fake model was never entered"

            health = await asyncio.wait_for(client.get("/health"), timeout=1.0)
            assert health.status_code == 200
            assert health.json()["busy"] is True
            assert health.json()["inflight"] == 1

            overflow = await asyncio.wait_for(
                client.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("second.wav", b"not-real-audio", "audio/wav")},
                ),
                timeout=1.0,
            )
            assert overflow.status_code == 503
            assert overflow.headers["Retry-After"] == "7"
            assert overflow.json()["code"] == "local_stt_saturated"
            assert overflow.json()["max_concurrency"] == 1
    finally:
        release.set()
        if first_request is not None:
            response = await first_request
            assert response.status_code == 200
        server._inflight["n"] = 0


@pytest.mark.asyncio
async def test_vad_regions_are_exposed_as_json_safe_response_evidence(monkeypatch):
    def transcribe(_path, **_kwargs):
        return {"text": "hello", "segments": [], "language": "en"}

    monkeypatch.setitem(
        sys.modules,
        "mlx_whisper",
        types.SimpleNamespace(transcribe=transcribe),
    )
    monkeypatch.setattr(server, "VAD_GATE", True)
    monkeypatch.setattr(
        server,
        "_vad_analyze",
        lambda _path: {
            "regions": [(0.4, 1.2), (1.6, 2.0)],
            "speech_dbfs": -23.5,
            "head_dbfs": float("-inf"),
            "tail_dbfs": -61.0,
            "total_s": 2.5,
        },
    )

    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/audio/transcriptions",
            files={"file": ("regions.wav", b"not-real-audio", "audio/wav")},
        )

    assert response.status_code == 200
    evidence = response.json()["_vad_analysis"]
    assert evidence["regions"] == [
        {"start": 0.4, "end": 1.2},
        {"start": 1.6, "end": 2.0},
    ]
    assert evidence["speech_seconds"] == 1.2
    assert evidence["speech_dbfs"] == -23.5
    assert evidence["head_dbfs"] is None
    assert evidence["tail_dbfs"] == -61.0
    assert evidence["total_seconds"] == 2.5
    assert response.json()["_vad_gated"] is False

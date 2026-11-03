"""Regression tests for the STT anti-hallucination fix (#1).

Test intent:
  1. The repeat-loop attractor (endless "thank you"/"excuse me") — broken by
     condition_on_previous_text=False in ANTI_HALLUCINATION_OPTS.
  2. Hallucinated filler on silence/ambient — caught by the silero-vad no-speech
     gate, while speech regions and relative levels remain visible as JSON-safe
     evidence for later cropping policy.
  3. Blocking model compute must not freeze health checks, and excess requests
     must receive an explicit retryable saturation response instead of queueing
     or materializing another parsed/spooled upload in memory.
  4. Optional speaker diarization failing (e.g. a decoder ABI break) must not
     discard a completed transcript.
  5. Watchdog /health polls must not flood the log, while failed or slow probes
     and every other request stay visible in a size-capped rotating file.

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
from io import BytesIO

import httpx
import pytest
from starlette.datastructures import UploadFile

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


@pytest.fixture
def anyio_backend():
    # The async tests drive the ASGI app on asyncio only (the server's own loop).
    # anyio's pytest plugin ships with Starlette, so no extra test dependency.
    return "asyncio"


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


@pytest.mark.anyio
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

            async def rejected_upload_must_not_be_read(_upload):
                raise AssertionError("saturated request materialized its upload")

            # FastAPI has already parsed the multipart body into UploadFile by
            # endpoint dispatch. The processing lane rejects here, before a
            # second body is copied from its spool into application memory.
            # Patch Starlette's class: the multipart parser builds
            # starlette.datastructures.UploadFile instances, and FastAPI's
            # UploadFile is only a subclass, so patching it is never reached.
            monkeypatch.setattr(UploadFile, "read", rejected_upload_must_not_be_read)

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
            assert overflow.json()["error"] == "Local STT is at processing capacity; retry later."
    finally:
        release.set()
        if first_request is not None:
            response = await first_request
            assert response.status_code == 200
        server._inflight["n"] = 0


@pytest.mark.anyio
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


async def _post_with_vad(monkeypatch, regions):
    calls = []

    def transcribe(path, **kwargs):
        calls.append(kwargs)
        return {"text": "hello", "segments": [], "language": "en"}

    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=transcribe))
    monkeypatch.setattr(server, "VAD_GATE", True)
    monkeypatch.setattr(server, "_vad_analyze", lambda _path: {
        "regions": regions, "speech_dbfs": -30.0, "head_dbfs": -70.0,
        "tail_dbfs": -70.0, "total_s": 5.0,
    })
    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/audio/transcriptions",
            files={"file": ("clip.wav", b"not-real-audio", "audio/wav")},
        )
    return response, calls


@pytest.mark.anyio
async def test_vad_gate_skips_the_model_when_no_speech_is_found(monkeypatch):
    response, calls = await _post_with_vad(monkeypatch, regions=[])

    assert response.status_code == 200
    assert response.json()["_vad_gated"] is True
    assert response.json()["text"] == ""
    assert calls == []


@pytest.mark.anyio
async def test_speech_is_transcribed_with_the_anti_hallucination_options(monkeypatch):
    response, calls = await _post_with_vad(monkeypatch, regions=[(0.5, 3.0)])

    assert response.status_code == 200
    assert response.json()["_vad_gated"] is False
    assert len(calls) == 1
    for key, value in server.ANTI_HALLUCINATION_OPTS.items():
        assert calls[0][key] == value


def test_diarization_failure_preserves_the_transcript(monkeypatch):
    """Test intent: optional speaker enrichment never turns usable STT into HTTP 500."""
    def fail_diarization(audio):
        assert audio == {"waveform": "decoded", "sample_rate": 16000}
        raise RuntimeError("decoder unavailable")

    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(
        transcribe=lambda _path, **_kwargs: {
            "text": "Radhika's message",
            "language": "en",
            "segments": [{"start": 0.0, "end": 1.0, "text": "Radhika's message"}],
        },
    ))
    monkeypatch.setattr(server, "VAD_GATE", False)
    monkeypatch.setattr(server, "_get_diarizer", lambda: fail_diarization)
    monkeypatch.setattr(server, "_decode_audio_for_model", lambda _path: {"waveform": "decoded", "sample_rate": 16000})

    response = asyncio.run(server.transcribe(
        UploadFile(filename="voice.wav", file=BytesIO(b"not-a-real-wav")),
        model=None,
        language=None,
        response_format="json",
        diarize="true",
        include_embeddings=None,
        word_timestamps=None,
        timestamp_granularities=None,
    ))

    assert response.status_code == 200
    assert b'Radhika\'s message' in response.body
    assert b'RuntimeError: decoder unavailable' in response.body


# --- Request logging (watchdog-noise suppression + rotating log file) ---------
# Test intent:
#   - a healthy, fast GET /health leaves no trace in the log (watchdog polls it);
#   - a slow /health is still logged, so a degrading server stays visible;
#   - every non-health request is logged on receipt and on completion;
#   - runtime logging writes to a size-capped rotating file and silences
#     uvicorn's own access log (which would bypass the health filter).
import logging  # noqa: E402
from logging.handlers import RotatingFileHandler  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


def _request_lines(caplog):
    return [r.getMessage() for r in caplog.records
            if r.name == "lct_local_stt" and ("-->" in r.getMessage() or "<--" in r.getMessage())]


def test_fast_healthy_health_probe_is_not_logged(caplog):
    caplog.set_level(logging.INFO, logger="lct_local_stt")
    response = TestClient(server.app).get("/health")
    assert response.status_code == 200
    assert _request_lines(caplog) == []


def test_slow_health_probe_is_still_logged(caplog, monkeypatch):
    monkeypatch.setattr(server, "HEALTH_SLOW_LOG_MS", 0.0)
    caplog.set_level(logging.INFO, logger="lct_local_stt")
    TestClient(server.app).get("/health")
    lines = _request_lines(caplog)
    assert len(lines) == 1 and "<-- GET /health 200" in lines[0]


def test_non_health_requests_are_logged_both_ways(caplog):
    caplog.set_level(logging.INFO, logger="lct_local_stt")
    response = TestClient(server.app).get("/no-such-route")
    assert response.status_code == 404
    lines = _request_lines(caplog)
    assert any("--> GET /no-such-route" in line for line in lines)
    assert any("<-- GET /no-such-route 404" in line for line in lines)


@pytest.fixture
def restore_logging():
    root = logging.getLogger()
    saved_root = (root.handlers[:], root.level)
    loggers = [logging.getLogger(n) for n in ("uvicorn.access", "uvicorn.error")]
    saved = [(lg.handlers[:], lg.propagate, lg.disabled) for lg in loggers]
    yield
    for h in root.handlers:
        if h not in saved_root[0]:
            h.close()
    root.handlers[:] = saved_root[0]
    root.setLevel(saved_root[1])
    for lg, (handlers, propagate, disabled) in zip(loggers, saved):
        lg.handlers[:], lg.propagate, lg.disabled = handlers, propagate, disabled


def test_runtime_logging_writes_a_rotating_file(tmp_path, monkeypatch, restore_logging):
    log_path = tmp_path / "nested" / "stt.log"
    monkeypatch.setenv("LOCAL_STT_LOG_PATH", str(log_path))
    server._configure_runtime_logging()

    handlers = logging.getLogger().handlers
    assert len(handlers) == 1 and isinstance(handlers[0], RotatingFileHandler)
    assert handlers[0].maxBytes == server.LOG_MAX_BYTES
    assert handlers[0].backupCount == server.LOG_BACKUP_COUNT
    assert logging.getLogger("uvicorn.access").disabled is True

    logging.getLogger("uvicorn.error").error("probe-marker")
    handlers[0].flush()
    assert "probe-marker" in log_path.read_text(encoding="utf-8")

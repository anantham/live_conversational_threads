"""A busy STT server (503 + Retry-After) is waited for, not treated as a failure.

Test intent:
  1. A 503 carrying Retry-After is retried after exactly the delay the server
     asked for, and the transcript is returned once a slot frees up.
  2. Waiting is bounded by STT_SATURATED_WAIT_BUDGET_S. When the budget runs
     out the call raises SttSaturatedError (still a "request failed (503)"
     RuntimeError, so existing provider fallbacks catch it).
  3. The chunk retry loop does not retry SttSaturatedError: the wait already
     happened, and retrying would repeat the whole budget per attempt.
  4. A 503 without a usable Retry-After (absent, HTTP-date, negative, inf, NaN),
     a 503 that is not the local STT's busy signal, or a 0 budget keeps the old
     behaviour: no wait here, a plain retryable RuntimeError.
  5. SttSaturatedError stays retryable at the job level (a busy server is worth
     retrying later); only the chunk loop skips it.

Context: the M5 local STT admits one request at a time and answers overflow
with 503 + Retry-After: 30. The chunk loop's old budget (~22.5 s of backoff)
gave up long before a busy slot freed up.
"""

from pathlib import Path

import httpx
import pytest

import lct_python_backend.services.audio_transcriber as mod

STT_URL = "http://stt.local/v1/audio/transcriptions"
SATURATED_BODY = {
    "error": "Local STT is at processing capacity; retry later.",
    "code": "local_stt_saturated",
    "retry_after_seconds": 30,
}


def _saturated(retry_after: str | None = "30", body: dict | None = None) -> httpx.Response:
    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    return httpx.Response(503, json=SATURATED_BODY if body is None else body, headers=headers)


def _make_wav(tmp_path: Path, duration_s: float = 1.0) -> Path:
    from pydub.generators import Sine

    wav_path = tmp_path / "speech.wav"
    Sine(440).to_audio_segment(duration=int(duration_s * 1000)).export(str(wav_path), format="wav")
    return wav_path


@pytest.fixture
def sleeps(monkeypatch):
    """Record requested waits instead of sleeping."""
    recorded: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        recorded.append(seconds)

    monkeypatch.setattr(mod, "_sleep", fake_sleep, raising=False)
    return recorded


@pytest.mark.asyncio
async def test_busy_server_is_retried_after_its_retry_after(tmp_path, sleeps, monkeypatch):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 900.0, raising=False)
    responses = [_saturated(), _saturated(), httpx.Response(200, json={"text": "hello there"})]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses.pop(0)

    wav = _make_wav(tmp_path)
    detail = await mod.transcribe_audio_file_detailed(
        wav, http_url=STT_URL, transport=httpx.MockTransport(handler)
    )

    assert detail.transcript_text == "hello there"
    assert len(requests) == 3
    assert sleeps == [30.0, 30.0]
    # Every retry re-sends the full upload, not an exhausted stream. (Multipart
    # boundaries differ per request, so check the audio is inside each body.)
    audio = wav.read_bytes()
    assert all(audio in request.read() for request in requests)


@pytest.mark.asyncio
async def test_waiting_stops_at_the_budget_with_a_saturated_error(tmp_path, sleeps, monkeypatch):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 50.0, raising=False)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _saturated()

    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_file_detailed(
            _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(handler)
        )

    assert type(excinfo.value).__name__ == "SttSaturatedError"
    assert "STT provider request failed (503)" in str(excinfo.value)
    # 30 s, then only the 20 s left in the budget, then one last try.
    assert sleeps == [30.0, 20.0]
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_chunk_loop_does_not_repeat_an_exhausted_wait(tmp_path, sleeps, monkeypatch):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 60.0, raising=False)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _saturated()

    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_chunked(
            _make_wav(tmp_path, duration_s=4.0),
            http_url=STT_URL,
            chunk_duration_s=2,
            overlap_s=0,
            chunk_max_retries=4,
            chunk_retry_backoff_s=0.0,
            transport=httpx.MockTransport(handler),
        )

    assert type(excinfo.value).__name__ == "SttSaturatedError"
    # One budget for the first chunk (30 + 30, three requests), not five.
    assert sleeps == [30.0, 30.0]
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_retry_after_zero_still_waits_one_second(tmp_path, sleeps, monkeypatch):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 900.0, raising=False)
    responses = [_saturated("0"), httpx.Response(200, json={"text": "ok"})]

    detail = await mod.transcribe_audio_file_detailed(
        _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(lambda r: responses.pop(0))
    )

    assert detail.transcript_text == "ok"
    assert sleeps == [1.0]


@pytest.mark.parametrize(
    "retry_after", [None, "Wed, 21 Oct 2026 07:28:00 GMT", "-5", "inf", "nan"]
)
@pytest.mark.asyncio
async def test_503_without_usable_retry_after_keeps_old_behaviour(
    tmp_path, sleeps, monkeypatch, retry_after
):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 900.0, raising=False)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _saturated(retry_after)

    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_file_detailed(
            _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(handler)
        )

    assert type(excinfo.value).__name__ == "RuntimeError"
    assert "STT provider request failed (503)" in str(excinfo.value)
    assert mod._is_retryable_stt_error(excinfo.value)
    assert sleeps == []
    assert len(requests) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"detail": "Service Unavailable"},  # a proxy or orchestrator, not the local STT
        {"error": "busy", "code": "something_else"},
    ],
)
@pytest.mark.asyncio
async def test_other_503s_with_retry_after_fail_fast(tmp_path, sleeps, monkeypatch, body):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 900.0, raising=False)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _saturated("30", body=body)

    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_file_detailed(
            _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(handler)
        )

    assert type(excinfo.value).__name__ == "RuntimeError"
    assert sleeps == []
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_zero_budget_disables_waiting(tmp_path, sleeps, monkeypatch):
    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 0.0, raising=False)

    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_file_detailed(
            _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(lambda r: _saturated())
        )

    assert type(excinfo.value).__name__ == "RuntimeError"
    assert mod._is_retryable_stt_error(excinfo.value)
    assert sleeps == []


@pytest.mark.asyncio
async def test_saturated_error_is_still_retryable_for_the_import_job(tmp_path, sleeps, monkeypatch):
    from lct_python_backend.services.import_pipeline.import_bulk_helpers import (
        is_retryable_import_failure,
    )

    monkeypatch.setattr(mod, "STT_SATURATED_WAIT_BUDGET_S", 30.0, raising=False)
    with pytest.raises(RuntimeError) as excinfo:
        await mod.transcribe_audio_file_detailed(
            _make_wav(tmp_path), http_url=STT_URL, transport=httpx.MockTransport(lambda r: _saturated())
        )

    assert type(excinfo.value).__name__ == "SttSaturatedError"
    assert mod._is_retryable_stt_error(excinfo.value)
    assert is_retryable_import_failure(excinfo.value, active_stage="segmented_transcribing")

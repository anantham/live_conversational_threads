"""Regression coverage for A5: ``initial_prompt`` forwarding through the
audio-transcription chain.

The segmented → chunked → single-file → detailed-HTTP-form chain is the path a
meeting/import job uses to bias STT with speaker names + topic context. A5 was a
silent drop of ``initial_prompt`` somewhere in that chain; none of the prior
segmented/chunked tests asserted the value, so the same drop could recur while
every other test stayed green.

These tests pin the two ends the reviewer called out:
  1. a prompt handed to ``transcribe_audio_segmented`` reaches
     ``transcribe_audio_chunked``; and
  2. chunked — both the multi-chunk and single-shot fallback paths — forwards it
     all the way into the actual multipart HTTP form sent to the STT provider.
"""

from pathlib import Path

import httpx
import pytest

import lct_python_backend.services.audio_transcriber as mod
from lct_python_backend.services.audio_transcriber import transcribe_audio_chunked

PROMPT = "Speakers: Alice, Bob. Topic: Q3 roadmap."


def _make_silent_wav(tmp_path: Path, duration_s: float = 3.0, name: str = "test.wav") -> Path:
    """Create a minimal audible WAV file using pydub (matches test_file_transcriber)."""
    from pydub.generators import Sine

    segment = Sine(440).to_audio_segment(duration=int(duration_s * 1000))
    wav_path = tmp_path / name
    segment.export(str(wav_path), format="wav")
    return wav_path


@pytest.mark.asyncio
async def test_segmented_forwards_initial_prompt_to_chunked(monkeypatch):
    """A prompt passed to transcribe_audio_segmented reaches every chunked call."""
    boundaries = [0, 10000, 20000]  # 2 segments
    monkeypatch.setattr(mod, "detect_segment_boundaries", lambda *a, **kw: boundaries)
    monkeypatch.setattr(mod, "extract_audio_segment", lambda fp, start, end: fp / f"seg-{start}.wav")

    seen_prompts: list = []

    async def fake_chunked(audio_path, **kwargs):
        seen_prompts.append(kwargs.get("initial_prompt"))
        return "text"

    monkeypatch.setattr(mod, "transcribe_audio_chunked", fake_chunked)

    results = []
    async for seg in mod.transcribe_audio_segmented(
        file_path=Path("/fake/audio.mp3"),
        http_url="http://stt.test/transcribe",
        initial_prompt=PROMPT,
    ):
        results.append(seg)

    assert len(results) == 2
    # Every segment's chunked call must carry the prompt — not just the first.
    assert seen_prompts == [PROMPT, PROMPT]


@pytest.mark.asyncio
async def test_chunked_single_shot_forwards_initial_prompt_to_http_form(tmp_path: Path):
    """Short files take the single-shot fallback; the prompt must reach the HTTP form."""
    wav = _make_silent_wav(tmp_path, duration_s=1.0)
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.read())
        return httpx.Response(200, json={"text": "ok"})

    result = await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=60,  # 1s file => single chunk => single-shot path
        initial_prompt=PROMPT,
        transport=httpx.MockTransport(handler),
    )

    assert result == "ok"
    assert len(bodies) == 1  # single-shot => exactly one HTTP request
    assert b'name="initial_prompt"' in bodies[0]
    assert PROMPT.encode() in bodies[0]


@pytest.mark.asyncio
async def test_chunked_multi_chunk_forwards_initial_prompt_to_http_form(tmp_path: Path):
    """Each chunk's HTTP request must carry the prompt (multi-chunk path)."""
    wav = _make_silent_wav(tmp_path, duration_s=5.0)
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.read())
        return httpx.Response(200, json={"text": "ok"})

    await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=2,  # 5s / 2s => 3 chunks
        overlap_s=0,
        initial_prompt=PROMPT,
        transport=httpx.MockTransport(handler),
    )

    assert len(bodies) == 3  # one HTTP request per chunk
    for body in bodies:
        assert b'name="initial_prompt"' in body
        assert PROMPT.encode() in body


@pytest.mark.asyncio
async def test_chunked_omits_initial_prompt_when_empty(tmp_path: Path):
    """An empty prompt must NOT inject an initial_prompt form field (guards the
    ``if coerce_str(initial_prompt)`` gate so the assertions above are meaningful)."""
    wav = _make_silent_wav(tmp_path, duration_s=1.0)
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.read())
        return httpx.Response(200, json={"text": "ok"})

    await transcribe_audio_chunked(
        wav,
        http_url="http://stt.local/transcriptions",
        chunk_duration_s=60,
        initial_prompt="",
        transport=httpx.MockTransport(handler),
    )

    assert len(bodies) == 1
    assert b'name="initial_prompt"' not in bodies[0]

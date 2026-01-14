import asyncio
import json
import os
from pathlib import Path

import pytest
import websockets

BYTES_PER_SECOND = 16000 * 2


def _looks_like_wav_header(data: bytes) -> bool:
    return len(data) >= 12 and data[0:4] in {b"RIFF", b"RIFX"} and data[8:12] == b"WAVE"


def _has_text_message(raw: object) -> bool:
    if raw is None:
        return False
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return True
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
            return bool(data.get("text"))
        except json.JSONDecodeError:
            return True
    return False


@pytest.mark.asyncio
async def test_whisper_ws_smoke():
    if os.getenv("RUN_WHISPER_WS_SMOKE_TEST") != "1":
        pytest.skip("RUN_WHISPER_WS_SMOKE_TEST not set")

    ws_url = os.getenv("WHISPER_WS_URL", "ws://100.81.65.74:43001/stream")
    pcm_path = Path(os.getenv("WHISPER_PCM_PATH", "outputs/stt_sample.pcm"))

    if not pcm_path.exists():
        pytest.skip(f"PCM file not found: {pcm_path}")

    audio_bytes = pcm_path.read_bytes()
    if not audio_bytes:
        pytest.skip("PCM file is empty")

    if _looks_like_wav_header(audio_bytes):
        pytest.skip("PCM file looks like WAV (RIFF header). Convert to raw PCM16 16kHz first.")

    skip_seconds = max(0.0, float(os.getenv("WHISPER_SKIP_SECONDS", "0")))
    skip_bytes = int(skip_seconds * BYTES_PER_SECOND)
    if skip_bytes >= len(audio_bytes):
        pytest.skip("WHISPER_SKIP_SECONDS exceeds PCM length")
    if skip_bytes:
        audio_bytes = audio_bytes[skip_bytes:]

    if len(audio_bytes) % 2:
        audio_bytes = audio_bytes[:-1]

    chunk_size = int(os.getenv("WHISPER_CHUNK_SIZE", "32000"))
    chunk_size -= chunk_size % 2
    max_seconds_env = os.getenv("WHISPER_MAX_SECONDS")
    if max_seconds_env:
        max_bytes = int(float(max_seconds_env) * BYTES_PER_SECOND)
    else:
        max_bytes = int(os.getenv("WHISPER_MAX_BYTES", str(chunk_size * 10)))
    max_bytes = min(max_bytes - (max_bytes % 2), len(audio_bytes))
    per_chunk_timeout = float(os.getenv("WHISPER_CHUNK_TIMEOUT", "1.0"))
    final_timeout = float(os.getenv("WHISPER_FINAL_TIMEOUT", "8.0"))
    stream_speed = float(os.getenv("WHISPER_STREAM_SPEED", "1.0"))
    stop_on_text = os.getenv("WHISPER_STOP_ON_TEXT", "true").strip().lower() in {"1", "true", "yes", "on"}
    ping_interval_env = os.getenv("WHISPER_PING_INTERVAL", "none").strip().lower()
    ping_timeout_env = os.getenv("WHISPER_PING_TIMEOUT", "none").strip().lower()
    ping_interval = None if ping_interval_env in {"none", "off", ""} else float(ping_interval_env)
    ping_timeout = None if ping_timeout_env in {"none", "off", ""} else float(ping_timeout_env)
    sent_any = False
    received_any = False

    async with websockets.connect(
        ws_url,
        max_size=10 * 1024 * 1024,
        ping_interval=ping_interval,
        ping_timeout=ping_timeout,
    ) as ws:
        for offset in range(0, min(len(audio_bytes), max_bytes), chunk_size):
            chunk = audio_bytes[offset:offset + chunk_size]
            if not chunk:
                break
            sent_any = True
            await ws.send(chunk)
            while True:
                try:
                    message = await asyncio.wait_for(ws.recv(), timeout=per_chunk_timeout)
                except asyncio.TimeoutError:
                    break
                received_any = received_any or _has_text_message(message)
                if received_any and stop_on_text:
                    break
            if received_any and stop_on_text:
                break
            sleep_seconds = len(chunk) / 32000
            if stream_speed > 0:
                sleep_seconds /= stream_speed
            await asyncio.sleep(sleep_seconds)

        if not received_any:
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=final_timeout)
                received_any = received_any or _has_text_message(message)
            except asyncio.TimeoutError:
                pass

    assert sent_any, "No audio chunks were sent"
    assert received_any, (
        "No transcript messages received from Whisper WS "
        f"(url={ws_url}, pcm={pcm_path}, chunk={chunk_size}, max_bytes={max_bytes}, skip_seconds={skip_seconds})"
    )

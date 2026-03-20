import mimetypes
import os
from pathlib import Path

import httpx
import pytest


def test_transcribe_proxy_smoke():
    if os.getenv("RUN_TRANSCRIBE_PROXY_SMOKE_TEST") != "1":
        pytest.skip("RUN_TRANSCRIBE_PROXY_SMOKE_TEST not set")

    audio_path = Path(os.getenv("TRANSCRIBE_PROXY_AUDIO_PATH", "")).expanduser()
    if not audio_path.exists():
        pytest.skip(f"TRANSCRIBE_PROXY_AUDIO_PATH not found: {audio_path}")

    url = os.getenv("TRANSCRIBE_PROXY_URL", "http://100.81.65.74:7777/api/transcribe")
    timeout_seconds = float(os.getenv("TRANSCRIBE_PROXY_TIMEOUT", "90"))
    language = os.getenv("TRANSCRIBE_PROXY_LANGUAGE", "en")
    diarize = os.getenv("TRANSCRIBE_PROXY_DIARIZE", "false")
    content_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"

    with audio_path.open("rb") as audio_file:
        response = httpx.post(
            url,
            data={"language": language, "diarize": diarize},
            files={"file": (audio_path.name, audio_file, content_type)},
            timeout=timeout_seconds,
        )

    response.raise_for_status()
    payload = response.json()

    assert payload.get("text"), (
        f"Expected transcript text from {url}, got keys={sorted(payload)} "
        f"backend={payload.get('_backend')!r}"
    )
    assert payload.get("_backend") in {"local_whisperx", "modal_whisperx"}

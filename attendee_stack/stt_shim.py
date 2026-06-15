"""Custom Async STT shim — bridges Attendee's transcription contract to a LOCAL STT.

When a self-hosted Attendee bot uses the ``custom_async_v2`` transcription
provider, its Celery worker POSTs each utterance's audio to
``CUSTOM_ASYNC_TRANSCRIPTION_URL`` and BLOCKS for the transcript in the same
HTTP response (verified against attendee-labs/attendee
``bots/tasks/process_utterance_task.py``). This shim implements exactly that
contract and forwards the audio to your local whisperx/parakeet STT so no audio
ever leaves the machine.

Attendee -> shim  (multipart/form-data):
    field ``audio`` : a MONO 128k MP3 (filename audio.mp3, content-type audio/mpeg)
    + any ``form_data`` fields you set in transcription_settings.custom_async_v2
      (e.g. ``language``).

shim -> Attendee  (HTTP 200 JSON), shape it parses:
    {"status": "done",
     "result": {"transcription": {
         "full_transcript": "<text>",          # REQUIRED, non-empty -> webhook fires
         "utterances": [{"words": [             # REQUIRED key (may be empty list)
             {"word": "hi", "start": 0.0, "end": 0.4}
         ]}]
     }}}
    On failure: {"status": "error", "error_code": "..."}.

Run it on the Windows host (reachable from the Attendee worker container as
``host.docker.internal``):
    uvicorn attendee_stack.stt_shim:app --host 0.0.0.0 --port 7878
then set on the Attendee server:
    CUSTOM_ASYNC_TRANSCRIPTION_URL=http://host.docker.internal:7878/transcribe

ADAPT ``_call_local_stt`` below to your STT's real request/response. The default
targets a generic whisper-style HTTP server (multipart ``file`` -> {text, words}).
If you'd rather not run an STT at all, switch LCT to closed-captions mode
(ATTENDEE_TRANSCRIPTION_MODE=closed_captions) and you don't need this shim.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("attendee_stt_shim")

app = FastAPI(title="Attendee Custom-Async STT shim")

# Your local STT endpoint. Default points at the IndrasNet/whisperx seam; adapt
# _call_local_stt to match its real API.
LOCAL_STT_URL = os.getenv("SHIM_STT_URL", "http://127.0.0.1:7777/api/transcribe")
LOCAL_STT_TIMEOUT_S = float(os.getenv("SHIM_STT_TIMEOUT_S", "300"))


async def _call_local_stt(mp3_bytes: bytes, language: str) -> Dict[str, Any]:
    """Send MP3 to the local STT and return {"text": str, "words": [...]}.

    >>> ADAPT THIS to your STT. <<< The default assumes a whisper-style server
    that accepts a multipart ``file`` and returns JSON with a ``text`` field and
    optionally ``words`` or ``segments[].words`` (each word: word/start/end).
    """
    async with httpx.AsyncClient(timeout=LOCAL_STT_TIMEOUT_S) as client:
        resp = await client.post(
            LOCAL_STT_URL,
            files={"file": ("audio.mp3", mp3_bytes, "audio/mpeg")},
            data={"language": language},
        )
        resp.raise_for_status()
        return resp.json()


def _extract_words(stt: Dict[str, Any]) -> List[Dict[str, Any]]:
    words: List[Dict[str, Any]] = []
    raw = stt.get("words")
    if not raw and isinstance(stt.get("segments"), list):
        raw = []
        for seg in stt["segments"]:
            if isinstance(seg, dict) and isinstance(seg.get("words"), list):
                raw.extend(seg["words"])
    for w in raw or []:
        if not isinstance(w, dict):
            continue
        token = w.get("word") or w.get("text")
        if token is None:
            continue
        words.append({"word": str(token), "start": float(w.get("start", 0.0)), "end": float(w.get("end", 0.0))})
    return words


@app.get("/health")
async def health():
    return {"status": "healthy", "local_stt_url": LOCAL_STT_URL}


@app.post("/transcribe")
async def transcribe(audio: UploadFile, language: str = Form("en")):
    try:
        mp3_bytes = await audio.read()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=200, content={"status": "error", "error_code": f"read_failed: {exc}"})
    if not mp3_bytes:
        return JSONResponse(status_code=200, content={"status": "error", "error_code": "empty_audio"})

    try:
        stt = await _call_local_stt(mp3_bytes, language)
    except Exception as exc:  # noqa: BLE001
        logger.exception("local STT call failed")
        return JSONResponse(status_code=200, content={"status": "error", "error_code": f"stt_failed: {exc}"})

    full_transcript = str(stt.get("text") or stt.get("transcript") or "").strip()
    words = _extract_words(stt)
    # `utterances` key MUST exist (Attendee iterates it). full_transcript must be
    # non-empty for the transcript.update webhook to fire.
    return {
        "status": "done",
        "result": {"transcription": {"full_transcript": full_transcript, "utterances": [{"words": words}]}},
    }

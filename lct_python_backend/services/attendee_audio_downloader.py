"""Attendee meeting-bot slow-pass: post-call high-fidelity re-transcription.

After a bot's meeting ends, this downloads the bot's own MP3 recording from
MinIO (Attendee's object store) and runs a slow-pass local STT over it, since
the bot's own recording is typically higher fidelity than what the live WS
capture got. Attendee uploads its own recording asynchronously after the bot
leaves the call, so the MinIO lookup polls with bounded backoff rather than
assuming the object is present the instant the meeting ends.

Decision-B (see transcript_reconciliation.py): this NEVER patches the live
transcript in place. An earlier prototype did, and destructively overwrote
speaker text an operator hadn't reviewed (codex audit finding A4) — the
auto-trigger was removed pending a review-gated revision flow. That flow now
exists (PR #118, transcript_revisions / revisions_api.py), so this proposes a
pending TranscriptRevision instead; an operator approves or rejects it.

Gated behind ATTENDEE_SLOWPASS_ENABLED (default off) and MinIO credentials
being configured — both boto3 and MINIO_ACCESS_KEY/MINIO_SECRET_KEY are
optional, so an install without them just skips this cleanly.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select

from lct_python_backend.config import AUDIO_RECORDINGS_DIR
from lct_python_backend.db_session import get_async_session_context
from lct_python_backend.models.core import Utterance
from lct_python_backend.services.audio_transcriber import transcribe_audio_file_detailed
from lct_python_backend.services.env_helpers import env_float
from lct_python_backend.services.transcript.transcript_reconciliation import (
    reconcile_and_patch_utterances,
)

logger = logging.getLogger("lct_backend")

MINIO_BUCKET = "attendee-recordings"

# Attendee uploads its own recording asynchronously after the bot leaves the
# call — poll for the object rather than assuming it's present immediately.
MINIO_POLL_INTERVAL_S = env_float("ATTENDEE_MINIO_POLL_INTERVAL_S", 5.0)
MINIO_POLL_TIMEOUT_S = env_float("ATTENDEE_MINIO_POLL_TIMEOUT_S", 120.0)


def _get_minio_client() -> Optional[Any]:
    """Build a boto3 S3 client for MinIO, or None if boto3/credentials are
    unavailable. Both are optional — this feature is opt-in (see
    ATTENDEE_SLOWPASS_ENABLED in attendee_api.py) and must not break a backend
    that never configured MinIO."""
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        logger.info("[audio-downloader] boto3 not installed — slow-pass MinIO fetch unavailable")
        return None

    access_key = os.environ.get("MINIO_ACCESS_KEY")
    secret_key = os.environ.get("MINIO_SECRET_KEY")
    if not access_key or not secret_key:
        logger.info("[audio-downloader] MINIO_ACCESS_KEY/MINIO_SECRET_KEY not set — slow-pass MinIO fetch skipped")
        return None

    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("MINIO_ENDPOINT_URL", "http://127.0.0.1:9000"),
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
    )


async def _find_recording_key(s3: Any, bot_id: str) -> Optional[str]:
    """Poll the bucket for a key containing bot_id, with bounded backoff —
    Attendee's own upload can lag behind the bot leaving the call."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + MINIO_POLL_TIMEOUT_S

    def list_objects():
        return s3.list_objects_v2(Bucket=MINIO_BUCKET)

    while True:
        objects = await loop.run_in_executor(None, list_objects)
        for obj in objects.get("Contents", []):
            if bot_id in obj["Key"] and obj["Key"].endswith(".mp3"):
                return obj["Key"]
        if loop.time() >= deadline:
            return None
        await asyncio.sleep(MINIO_POLL_INTERVAL_S)


async def fetch_and_transcribe(bot_id: str, conversation_id: str) -> None:
    """Background task triggered when a bot's meeting reaches a terminal state.

    Downloads the bot's own MP3 recording from MinIO, runs a slow-pass local
    STT over it, and proposes the result as a reviewable transcript revision.
    Never patches the live transcript directly (decision-B — see module
    docstring). Every failure mode here is caught and logged, never raised —
    this runs detached from the webhook response (see attendee_api.py).
    """
    logger.info("[audio-downloader] starting background fetch for bot=%s conv=%s", bot_id, conversation_id)
    try:
        s3 = _get_minio_client()
        if s3 is None:
            return

        target_key = await _find_recording_key(s3, bot_id)
        if not target_key:
            logger.warning(
                "[audio-downloader] no MP3 found for bot=%s within %.0fs — giving up",
                bot_id, MINIO_POLL_TIMEOUT_S,
            )
            return

        logger.info("[audio-downloader] found recording key=%s, downloading", target_key)
        os.makedirs(AUDIO_RECORDINGS_DIR, exist_ok=True)
        local_path = os.path.join(AUDIO_RECORDINGS_DIR, f"{conversation_id}.mp3")

        loop = asyncio.get_running_loop()

        def download_obj():
            s3.download_file(MINIO_BUCKET, target_key, local_path)

        await loop.run_in_executor(None, download_obj)
        logger.info("[audio-downloader] downloaded recording to %s", local_path)

        async with get_async_session_context() as db:
            result = await db.execute(
                select(Utterance)
                .where(Utterance.conversation_id == conversation_id)
                .order_by(Utterance.sequence_number)
            )
            utterances = result.scalars().all()

            unique_speakers = {u.speaker_name for u in utterances if u.speaker_name}
            prompt = f"Meeting transcript. Attendees: {', '.join(sorted(unique_speakers))}."

            # Privacy: the prompt embeds attendee speaker names — log its size, not text.
            logger.info(
                "[audio-downloader] running slow-pass STT on %s (prompt %d chars)",
                local_path, len(prompt),
            )
            detail = await transcribe_audio_file_detailed(
                file_path=Path(local_path),
                http_url="http://127.0.0.1:7777/api/transcribe",
                initial_prompt=prompt,
                timeout_seconds=600.0,
            )

            if not detail.asr_segments:
                logger.warning("[audio-downloader] STT returned no segments for bot=%s", bot_id)
                return

            logger.info(
                "[audio-downloader] STT finished — proposing revision from %d segment(s) "
                "against %d existing utterance(s)",
                len(detail.asr_segments), len(utterances),
            )
            await reconcile_and_patch_utterances(conversation_id, utterances, detail.asr_segments, db=db)
    except Exception:  # noqa: BLE001 — background task, never raise past this point
        logger.exception("[audio-downloader] failed to fetch/transcribe recording for bot=%s", bot_id)

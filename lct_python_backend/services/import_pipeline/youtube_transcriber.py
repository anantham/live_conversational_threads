"""Whole-recording, local-only YouTube transcription with mandatory diarization.

The audio is temporary. A private recovery receipt retains STT text even when
speaker labeling or later graph extraction fails; it is never a public artifact.
"""

import asyncio
import json
import math
import mimetypes
import os
import tempfile
import uuid
from pathlib import Path

import httpx

from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
from lct_python_backend.services.deployment_privacy_policy import assert_raw_transcript_retention_allowed
from lct_python_backend.services.provider_selection import resolve_import_audio_candidates
from lct_python_backend.services.stt.stt_authority import LOCAL_AUTHORITY_SCOPE
from lct_python_backend.services.transcript.transcription_utils import FileTranscriptResult
from .youtube_download import download_youtube_audio, youtube_import_available
from .youtube_source import MAX_DURATION_SECONDS, youtube_media_ref, youtube_video_id

_IMPORT_SLOT = asyncio.Semaphore(1)


def diarized_youtube_result(payload: dict, video_id: str, title: str) -> FileTranscriptResult:
    """Validate evidence, not merely HTTP status; never invent speakers or times."""
    diarization = payload.get("diarization")
    if not isinstance(diarization, dict) or diarization.get("error") or not diarization.get("n_speakers"):
        raise ValueError("Required diarization did not succeed. The transcript is retained for recovery; this import is not complete.")
    segments = payload.get("segments")
    if not isinstance(segments, list) or not segments:
        raise ValueError("Diarization returned no timestamped speech segments.")
    utterances = []
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        start, end = segment.get("start"), segment.get("end")
        if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in (start, end)) or not 0 <= start < end <= MAX_DURATION_SECONDS:
            raise ValueError("STT returned invalid speech timestamps; refusing misleading video links.")
        speaker = segment.get("speaker")
        known = isinstance(speaker, str) and bool(speaker.strip())
        overlap = bool(segment.get("overlap"))
        utterances.append({
            "id": str(uuid.uuid4()), "text": text,
            "speaker_id": speaker if known else "UNKNOWN",
            "speaker_source": "model_overlap" if overlap else "model" if known else "unknown",
            "speaker_confidence": None,
            "sequence_number": len(utterances) + 1,
            "timestamp_start": start, "timestamp_end": end, "duration_seconds": end - start,
            "platform_metadata": {"source": "youtube_diarized", "speaker_unverified": True, "overlap": overlap},
        })
    if not utterances or not any(u["speaker_id"] != "UNKNOWN" for u in utterances):
        raise ValueError("Diarization did not identify any speaker. Import remains incomplete.")
    transcript = "\n".join(f'{u["speaker_id"]}: {u["text"]}' for u in utterances)
    return FileTranscriptResult(
        transcript_text=transcript, source_type="youtube", utterances=utterances,
        metadata={
            "media_refs": [youtube_media_ref(video_id, title)],
            "diarization": {"status": "complete", "scope": "whole_recording", "labels_reviewed": False,
                            "speaker_count": len({u["speaker_id"] for u in utterances if u["speaker_id"] != "UNKNOWN"}),
                            "overlap_detection": "reported" if any("overlap" in s for s in segments) else "not_reported"},
            "stt_backend": "local_diarized", "time_unit": "seconds",
        },
    )


async def transcribe_youtube_request(*, temp_path: Path, stt_settings: dict, emit, **_kwargs):
    assert_raw_transcript_retention_allowed()
    if not youtube_import_available():
        raise ValueError("YouTube import is not enabled on this backend. It needs ENABLE_YOUTUBE_IMPORT=true and yt-dlp.")
    if temp_path.stat().st_size > 2048:
        raise ValueError("YouTube import expects one video URL, not an uploaded transcript.")
    video_id = youtube_video_id(temp_path.read_text(encoding="utf-8").strip())
    candidates = resolve_import_audio_candidates(settings=stt_settings, provider_override=None)
    candidate = next((c for c in candidates if c.get("authority_scope") == LOCAL_AUTHORITY_SCOPE and c.get("supports_diarization")), None)
    if candidate is None:
        raise ValueError("Enable an approved local STT authority with diarization before importing YouTube.")
    endpoint = candidate["http_url"]
    assert_audio_egress_allowed(endpoint, purpose="mandatory whole-recording YouTube diarization")

    async def status(stage, message):
        await emit("status", {"stage": stage, "message": message, "progress": 0.15, "stt_backend": "local_diarized"})

    await status("queued", "Waiting for the local YouTube importer…")
    async with _IMPORT_SLOT:
        with tempfile.TemporaryDirectory(prefix="lct-youtube-") as temporary:
            await status("downloading", "Downloading this public video's audio. No account or cookies are used.")
            audio, info = await download_youtube_audio(video_id, Path(temporary))
            await status("diarizing", "Transcribing and identifying speakers across the whole recording. This may take several minutes.")
            # No per-chunk Speaker 00 resets, no cloud fallback, no redirects.
            async with httpx.AsyncClient(timeout=httpx.Timeout(7200, connect=10), follow_redirects=False, trust_env=False) as client:
                with audio.open("rb") as stream:
                    response = await client.post(endpoint, data={"diarize": "true", "response_format": "json", "model": candidate.get("model", "")},
                                                 files={"file": (audio.name, stream, mimetypes.guess_type(audio.name)[0] or "application/octet-stream")})
                response.raise_for_status()
                payload = response.json()
            recovery_root = Path(os.getenv("LCT_YOUTUBE_RECOVERY_DIR", "tmp/youtube-recovery"))
            recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            receipt = f"{video_id}-{uuid.uuid4().hex}.json"
            with open(recovery_root / receipt, "x", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as recovered:
                json.dump({"video_id": video_id, "title": info.get("title"), "stt": payload}, recovered, ensure_ascii=False)
            try:
                result = diarized_youtube_result(payload, video_id, info.get("title", "YouTube recording"))
            except ValueError as exc:
                raise ValueError(f"{exc} Recovery receipt: {receipt}") from exc
            await status("diarized", f"Speaker labeling complete ({result.metadata['diarization']['speaker_count']} speakers). Generating the map next.")
            return result

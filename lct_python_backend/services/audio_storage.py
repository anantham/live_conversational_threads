import asyncio
import logging
import shutil
import subprocess
import wave
from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger("lct_backend")


class AudioStorageManager:
    def __init__(
        self,
        recordings_dir: str,
        sample_rate: int = 16000,
        channels: int = 1,
        sample_width: int = 2,
    ):
        self.recordings_dir = Path(recordings_dir)
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.sample_rate = sample_rate
        self.channels = channels
        self.sample_width = sample_width

        # Avoid binding an asyncio primitive at import time. Some test and CLI
        # paths import the module before any event loop exists.
        self._lock: Optional[asyncio.Lock] = None
        self._session_meta: Dict[str, Dict[str, int]] = defaultdict(lambda: {"bytes_written": 0})

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def append_chunk(self, conversation_id: str, chunk_bytes: bytes) -> None:
        if not chunk_bytes:
            return

        async with self._get_lock():
            pcm_path = self.recordings_dir / f"{conversation_id}.pcm"
            try:
                with pcm_path.open("ab") as pcm_file:
                    pcm_file.write(chunk_bytes)
                self._session_meta[conversation_id]["bytes_written"] += len(chunk_bytes)
                logger.debug("[AUDIO STORAGE] Appended %s bytes for %s", len(chunk_bytes), conversation_id)
            except Exception as exc:
                logger.exception("[AUDIO STORAGE] Failed to append chunk (%s): %s", conversation_id, exc)

    def get_status(self, conversation_id: str) -> Dict[str, Optional[object]]:
        pcm_path = self.recordings_dir / f"{conversation_id}.pcm"
        wav_path = self.recordings_dir / f"{conversation_id}.wav"
        flac_path = self.recordings_dir / f"{conversation_id}.flac"
        bytes_written = self._session_meta.get(conversation_id, {}).get("bytes_written", 0)
        if bytes_written <= 0 and pcm_path.exists():
            try:
                bytes_written = pcm_path.stat().st_size
            except OSError:
                bytes_written = 0
        return {
            "pcm_path": str(pcm_path) if pcm_path.exists() else None,
            "wav_path": str(wav_path) if wav_path.exists() else None,
            "flac_path": str(flac_path) if flac_path.exists() else None,
            "has_pcm": pcm_path.exists(),
            "has_wav": wav_path.exists(),
            "has_flac": flac_path.exists(),
            "bytes_written": bytes_written,
        }

    async def finalize(self, conversation_id: str) -> Dict[str, Optional[str]]:
        pcm_path = self.recordings_dir / f"{conversation_id}.pcm"
        wav_path = self.recordings_dir / f"{conversation_id}.wav"
        flac_path = self.recordings_dir / f"{conversation_id}.flac"
        result = {
            "wav_path": None,
            "flac_path": None,
            "bytes_written": self._session_meta.get(conversation_id, {}).get("bytes_written", 0),
        }

        if not pcm_path.exists():
            if wav_path.exists():
                result["wav_path"] = str(wav_path)
            if flac_path.exists():
                result["flac_path"] = str(flac_path)
            logger.debug("[AUDIO STORAGE] No PCM file to finalize for %s", conversation_id)
            return result

        wav_written = False
        try:
            existing_wav_frames = b""
            if wav_path.exists():
                with wave.open(str(wav_path), "rb") as existing_wav_file:
                    existing_wav_frames = existing_wav_file.readframes(existing_wav_file.getnframes())

            with pcm_path.open("rb") as pcm_file:
                new_pcm_frames = pcm_file.read()

            with wave.open(str(wav_path), "wb") as wav_file:
                wav_file.setnchannels(self.channels)
                wav_file.setsampwidth(self.sample_width)
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(existing_wav_frames + new_pcm_frames)

            result["wav_path"] = str(wav_path)
            wav_written = True
            if existing_wav_frames:
                logger.info("[AUDIO STORAGE] WAV stitched and generated at %s", wav_path)
            else:
                logger.info("[AUDIO STORAGE] WAV generated at %s", wav_path)
        except Exception as exc:
            logger.exception("[AUDIO STORAGE] Failed to write WAV for %s: %s", conversation_id, exc)

        if not wav_written:
            logger.warning(
                "[AUDIO STORAGE] Skipping cleanup and FLAC conversion; WAV missing for %s",
                conversation_id,
            )
            return result

        try:
            pcm_path.unlink()
        except FileNotFoundError:
            pass

        ffmpeg_path = shutil.which("ffmpeg")
        if ffmpeg_path:
            try:
                subprocess.run(
                    [
                        ffmpeg_path,
                        "-y",
                        "-i",
                        str(wav_path),
                        "-compression_level",
                        "12",
                        str(flac_path),
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                result["flac_path"] = str(flac_path)
                logger.info("[AUDIO STORAGE] FLAC generated at %s", flac_path)
            except subprocess.CalledProcessError as exc:
                logger.warning("[AUDIO STORAGE] FFmpeg conversion failed: %s", exc.stderr)
        else:
            logger.debug("[AUDIO STORAGE] FFmpeg not found; skipping FLAC conversion.")

        self._session_meta.pop(conversation_id, None)
        return result

    def get_paths(self, conversation_id: str) -> Dict[str, Optional[str]]:
        status = self.get_status(conversation_id)
        return {
            "wav_path": status["wav_path"],
            "flac_path": status["flac_path"],
            "bytes_written": status["bytes_written"],
        }

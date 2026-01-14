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

        self._lock = asyncio.Lock()
        self._session_meta: Dict[str, Dict[str, int]] = defaultdict(lambda: {"bytes_written": 0})

    async def append_chunk(self, conversation_id: str, chunk_bytes: bytes) -> None:
        if not chunk_bytes:
            return

        async with self._lock:
            pcm_path = self.recordings_dir / f"{conversation_id}.pcm"
            try:
                with pcm_path.open("ab") as pcm_file:
                    pcm_file.write(chunk_bytes)
                self._session_meta[conversation_id]["bytes_written"] += len(chunk_bytes)
                logger.debug("[AUDIO STORAGE] Appended %s bytes for %s", len(chunk_bytes), conversation_id)
            except Exception as exc:
                logger.exception("[AUDIO STORAGE] Failed to append chunk (%s): %s", conversation_id, exc)

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
            logger.debug("[AUDIO STORAGE] No PCM file to finalize for %s", conversation_id)
            return result

        wav_written = False
        try:
            with wave.open(str(wav_path), "wb") as wav_file:
                wav_file.setnchannels(self.channels)
                wav_file.setsampwidth(self.sample_width)
                wav_file.setframerate(self.sample_rate)
                with pcm_path.open("rb") as pcm_file:
                    wav_file.writeframes(pcm_file.read())

            result["wav_path"] = str(wav_path)
            wav_written = True
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
        wav_path = self.recordings_dir / f"{conversation_id}.wav"
        flac_path = self.recordings_dir / f"{conversation_id}.flac"
        return {
            "wav_path": str(wav_path) if wav_path.exists() else None,
            "flac_path": str(flac_path) if flac_path.exists() else None,
            "bytes_written": self._session_meta.get(conversation_id, {}).get("bytes_written", 0),
        }

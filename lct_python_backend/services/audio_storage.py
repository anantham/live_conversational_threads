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

    def _conversation_path(self, conversation_id: str, suffix: str) -> Path:
        """Build ``recordings_dir/<conversation_id><suffix>``, refusing any id that
        escapes the recordings directory. Defense-in-depth against path traversal —
        the API layer validates ``conversation_id`` too, but a crafted id like
        ``../../../../tmp/evil`` must never reach an open()/copy() here."""
        candidate = (self.recordings_dir / f"{conversation_id}{suffix}").resolve()
        if candidate.parent != self.recordings_dir.resolve():
            raise ValueError(
                f"unsafe conversation_id (path escapes recordings dir): {conversation_id!r}"
            )
        return candidate

    async def append_chunk(self, conversation_id: str, chunk_bytes: bytes) -> None:
        if not chunk_bytes:
            logger.warning("[AUDIO STORAGE] conversation=%s empty chunk received, skipping", conversation_id)
            return

        pcm_path = self._conversation_path(conversation_id, ".pcm")
        chunk_size = len(chunk_bytes)
        bytes_before = 0
        if pcm_path.exists():
            try:
                bytes_before = pcm_path.stat().st_size
            except OSError:
                bytes_before = 0
        
        logger.info("[AUDIO STORAGE] conversation=%s appending chunk_bytes=%s bytes_before=%s path=%s",
                   conversation_id, chunk_size, bytes_before, pcm_path)

        async with self._get_lock():
            try:
                with pcm_path.open("ab") as pcm_file:
                    pcm_file.write(chunk_bytes)
                self._session_meta[conversation_id]["bytes_written"] += chunk_size
                bytes_after = bytes_before + chunk_size
                logger.info("[AUDIO STORAGE] conversation=%s append successful: chunk_bytes=%s bytes_before=%s bytes_after=%s total_tracked=%s",
                        conversation_id, chunk_size, bytes_before, bytes_after, 
                        self._session_meta[conversation_id]["bytes_written"])
            except Exception as exc:
                logger.exception("[AUDIO STORAGE] conversation=%s FAILED to append chunk: %s", conversation_id, exc)

    # Source-import formats kept alongside live-recorded wav/flac.
    # Priority order: prefer wav/flac (lossless) then m4a/mp3/etc.
    SOURCE_AUDIO_SUFFIXES = (".wav", ".flac", ".m4a", ".mp3", ".ogg", ".aac", ".webm", ".mp4")

    def _find_source_audio(self, conversation_id: str) -> Optional[Path]:
        """Return the first existing audio file for this conversation across
        the known source suffixes (live wav/flac and source-imported formats)."""
        for suffix in self.SOURCE_AUDIO_SUFFIXES:
            try:
                candidate = self._conversation_path(conversation_id, suffix)
            except ValueError:
                return None
            if candidate.exists():
                return candidate
        return None

    def persist_source_audio(self, conversation_id: str, temp_path: str, suffix: str) -> Optional[Path]:
        """Copy an imported audio file into recordings/ so the audio endpoint
        can serve it. Called after a successful import. Suffix is taken from
        the original upload filename (e.g. .m4a, .mp3). Returns the destination
        path on success, None if the suffix isn't an audio format we recognize.
        """
        normalized_suffix = suffix.lower() if suffix else ""
        if normalized_suffix not in self.SOURCE_AUDIO_SUFFIXES:
            return None
        try:
            dest = self._conversation_path(conversation_id, normalized_suffix)
        except ValueError as exc:
            logger.warning("[AUDIO STORAGE] persist_source_audio refused unsafe id %r: %s", conversation_id, exc)
            return None
        try:
            shutil.copy2(temp_path, dest)
            logger.info("[AUDIO STORAGE] persisted source audio for %s -> %s", conversation_id, dest)
            return dest
        except OSError as exc:
            logger.warning("[AUDIO STORAGE] persist_source_audio failed for %s: %s", conversation_id, exc)
            return None

    def get_status(self, conversation_id: str) -> Dict[str, Optional[object]]:
        pcm_path = self._conversation_path(conversation_id, ".pcm")
        wav_path = self._conversation_path(conversation_id, ".wav")
        flac_path = self._conversation_path(conversation_id, ".flac")
        bytes_written = self._session_meta.get(conversation_id, {}).get("bytes_written", 0)
        if bytes_written <= 0 and pcm_path.exists():
            try:
                bytes_written = pcm_path.stat().st_size
            except OSError:
                bytes_written = 0
        source_path = self._find_source_audio(conversation_id)
        return {
            "pcm_path": str(pcm_path) if pcm_path.exists() else None,
            "wav_path": str(wav_path) if wav_path.exists() else None,
            "flac_path": str(flac_path) if flac_path.exists() else None,
            "source_path": str(source_path) if source_path else None,
            "source_suffix": source_path.suffix.lower() if source_path else None,
            "has_pcm": pcm_path.exists(),
            "has_wav": wav_path.exists(),
            "has_flac": flac_path.exists(),
            "has_source": source_path is not None,
            "bytes_written": bytes_written,
        }

    async def finalize(self, conversation_id: str) -> Dict[str, Optional[str]]:
        pcm_path = self._conversation_path(conversation_id, ".pcm")
        wav_path = self._conversation_path(conversation_id, ".wav")
        flac_path = self._conversation_path(conversation_id, ".flac")
        
        tracked_bytes = self._session_meta.get(conversation_id, {}).get("bytes_written", 0)
        logger.info("[AUDIO STORAGE] conversation=%s FINALIZE start: tracked_bytes=%s pcm_exists=%s wav_exists=%s",
                  conversation_id, tracked_bytes, pcm_path.exists(), wav_path.exists())
        
        result = {
            "wav_path": None,
            "flac_path": None,
            "bytes_written": tracked_bytes,
        }

        if not pcm_path.exists():
            if wav_path.exists():
                result["wav_path"] = str(wav_path)
            if flac_path.exists():
                result["flac_path"] = str(flac_path)
            logger.warning("[AUDIO STORAGE] conversation=%s finalize: NO PCM FILE FOUND tracked_bytes=%s", 
                         conversation_id, tracked_bytes)
            return result

        wav_written = False
        try:
            existing_wav_frames = b""
            if wav_path.exists():
                with wave.open(str(wav_path), "rb") as existing_wav_file:
                    existing_wav_frames = existing_wav_file.readframes(existing_wav_file.getnframes())

            with pcm_path.open("rb") as pcm_file:
                new_pcm_frames = pcm_file.read()

            new_pcm_size = len(new_pcm_frames)
            existing_wav_size = len(existing_wav_frames)
            total_audio = existing_wav_size + new_pcm_size
            
            logger.info("[AUDIO STORAGE] conversation=%s PCM size=%s existing_wav_size=%s total_audio=%s",
                     conversation_id, new_pcm_size, existing_wav_size, total_audio)
            
            if total_audio < 1600:  # Less than 100ms at 16kHz mono
                logger.warning("[AUDIO STORAGE] conversation=%s AUDIO TOO SMALL: %s bytes (%s ms), expected at least 1600 bytes (100ms)",
                            conversation_id, total_audio, total_audio / 32)
                # Don't fail - still try to save what we have
            else:
                logger.info("[AUDIO STORAGE] conversation=%s AUDIO OK: %s bytes (%s ms)",
                          conversation_id, total_audio, total_audio / 32)

            with wave.open(str(wav_path), "wb") as wav_file:
                wav_file.setnchannels(self.channels)
                wav_file.setsampwidth(self.sample_width)
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(existing_wav_frames + new_pcm_frames)

            result["wav_path"] = str(wav_path)
            wav_written = True
            logger.info("[AUDIO STORAGE] conversation=%s WAV written successfully path=%s total_bytes=%s",
                      conversation_id, wav_path, total_audio)
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

    async def extract_audio_slice(
        self,
        conversation_id: str,
        start_seconds: float,
        end_seconds: float,
    ) -> Optional[bytes]:
        """Extract a PCM slice for a given time window."""
        status = self.get_status(conversation_id)
        pcm_path = status.get("pcm_path")
        wav_path = status.get("wav_path")

        # Try WAV first as it's more durable, fallback to PCM
        path_to_read = Path(wav_path) if wav_path else (Path(pcm_path) if pcm_path else None)
        if not path_to_read or not path_to_read.exists():
            return None

        bytes_per_sample = self.sample_width
        samples_per_second = self.sample_rate
        bytes_per_second = samples_per_second * bytes_per_sample * self.channels

        start_offset = int(max(0, start_seconds) * bytes_per_second)
        end_offset = int(max(start_seconds, end_seconds) * bytes_per_second)
        length = end_offset - start_offset

        if length <= 0:
            return None

        # Align to sample width
        start_offset -= start_offset % bytes_per_sample

        async with self._get_lock():
            try:
                if path_to_read.suffix == ".wav":
                    with wave.open(str(path_to_read), "rb") as wav_file:
                        wav_file.setpos(int(max(0, start_seconds) * samples_per_second))
                        return wav_file.readframes(int((end_seconds - start_seconds) * samples_per_second))
                else:
                    with path_to_read.open("rb") as f:
                        f.seek(start_offset)
                        return f.read(length)
            except Exception as exc:
                logger.error("[AUDIO STORAGE] Slice extraction failed for %s: %s", conversation_id, exc)
                return None

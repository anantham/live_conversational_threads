"""Backend-owned realtime STT helpers for HTTP transcription providers."""

import base64
import io
import json
import logging
import os
import time
import wave
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np

logger = logging.getLogger("lct_backend")

DEFAULT_SAMPLE_RATE_HZ = int(os.getenv("STT_SAMPLE_RATE_HZ", "16000"))
DEFAULT_HTTP_TIMEOUT_SECONDS = float(os.getenv("STT_HTTP_TIMEOUT_SECONDS", "30"))
DEFAULT_HTTP_CHUNK_SECONDS = float(os.getenv("STT_HTTP_CHUNK_SECONDS", "1.2"))
DEFAULT_HTTP_MODEL = os.getenv("STT_HTTP_MODEL", "")
DEFAULT_HTTP_LANGUAGE = os.getenv("STT_HTTP_LANGUAGE", "")
TRACE_API_CALLS = os.getenv("TRACE_API_CALLS", "true").strip().lower() in {"1", "true", "yes", "on"}
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))

# --- Diarization feature flag ---
STT_DIARIZE_ENABLED = os.getenv("STT_DIARIZE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}

# --- VAD + Pooling feature flags ---
STT_VAD_ENABLED = os.getenv("STT_VAD_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
STT_VAD_MIN_SECONDS = float(os.getenv("STT_VAD_MIN_SECONDS", "0.5"))
STT_VAD_MAX_SECONDS = float(os.getenv("STT_VAD_MAX_SECONDS", "5.0"))
STT_VAD_SILENCE_MS = int(os.getenv("STT_VAD_SILENCE_MS", "300"))
STT_VAD_THRESHOLD = float(os.getenv("STT_VAD_THRESHOLD", "0.5"))
STT_HTTP_POOL_ENABLED = os.getenv("STT_HTTP_POOL_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}

# --- Silero VAD availability (checked once at first use) ---
_silero_vad_checked: bool = False
_silero_vad_ok: bool = False


def _check_silero_vad() -> bool:
    """Check if silero-vad is importable. Result is cached after first call."""
    global _silero_vad_checked, _silero_vad_ok
    if _silero_vad_checked:
        return _silero_vad_ok
    _silero_vad_checked = True
    try:
        from silero_vad import load_silero_vad  # noqa: F401

        _silero_vad_ok = True
        logger.info("[VAD] silero-vad package available")
    except ImportError:
        logger.warning(
            "[VAD] silero-vad not installed. "
            "Install with: pip install silero-vad. "
            "Falling back to fixed-interval chunking."
        )
    return _silero_vad_ok


def _create_vad_model():
    """Create a fresh Silero VAD model instance (one per session to avoid LSTM state sharing)."""
    try:
        from silero_vad import load_silero_vad

        model = load_silero_vad()
        logger.debug("[VAD] Silero VAD model loaded")
        return model
    except Exception as exc:
        logger.warning("[VAD] Model load failed: %s", exc)
        return None


def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...<truncated {len(text) - limit} chars>"


def _elapsed_ms(started_at: float) -> float:
    return round(max(0.0, (time.perf_counter() - started_at) * 1000.0), 2)


def decode_audio_base64(audio_base64: Any) -> bytes:
    if not isinstance(audio_base64, str) or not audio_base64.strip():
        return b""
    try:
        return base64.b64decode(audio_base64)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid base64-encoded audio chunk.") from exc


def pcm16le_to_wav(
    pcm_bytes: bytes,
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
    channels: int = 1,
) -> bytes:
    with io.BytesIO() as wav_io:
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setnchannels(max(1, int(channels)))
            wav_file.setsampwidth(2)  # int16 PCM
            wav_file.setframerate(max(8000, int(sample_rate_hz)))
            wav_file.writeframes(pcm_bytes)
        return wav_io.getvalue()


def extract_transcript_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()

    if not isinstance(payload, dict):
        return ""

    direct_keys = (
        "text",
        "transcript",
        "result",
        "output_text",
        "prediction",
    )
    for key in direct_keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    data_block = payload.get("data")
    if isinstance(data_block, dict):
        nested = extract_transcript_text(data_block)
        if nested:
            return nested

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            nested = extract_transcript_text(first)
            if nested:
                return nested

    return ""


def extract_diarized_segments(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """Extract speaker-diarized segments from STT response.

    Returns a list of {speaker, start, end, text} dicts when diarization data
    is present and valid, or None when absent/invalid.
    """
    if not isinstance(payload, dict):
        return None

    speakers = payload.get("speakers")
    if not isinstance(speakers, list) or not speakers:
        return None

    # Check for error responses (e.g. {"error": "..."})
    if len(speakers) == 1 and isinstance(speakers[0], dict) and "error" in speakers[0]:
        logger.debug("[DIARIZE] Server returned diarization error: %s", speakers[0]["error"])
        return None

    segments: List[Dict[str, Any]] = []
    for entry in speakers:
        if not isinstance(entry, dict):
            continue
        speaker = entry.get("speaker")
        text = entry.get("text")
        if not speaker or not text:
            continue
        segments.append({
            "speaker": str(speaker),
            "text": str(text).strip(),
            "start": entry.get("start"),
            "end": entry.get("end"),
        })

    return segments if segments else None


_VAD_WINDOW_SIZE_16K = 512  # 32ms at 16kHz
_VAD_WINDOW_SIZE_8K = 256  # 32ms at 8kHz


@dataclass
class RealtimeHttpSttSession:
    provider: str
    http_url: str
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ
    chunk_seconds: float = DEFAULT_HTTP_CHUNK_SECONDS
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS
    model: str = DEFAULT_HTTP_MODEL
    language: str = DEFAULT_HTTP_LANGUAGE
    _buffer: bytearray = field(default_factory=bytearray)
    _chunks_seen: int = 0
    # Connection pooling
    _client: Optional[httpx.AsyncClient] = field(default=None, init=False, repr=False)
    # VAD state
    _vad_model: Any = field(default=None, init=False, repr=False)
    _vad_available: bool = field(default=False, init=False)
    _last_speech_sample: int = field(default=0, init=False)
    _total_samples_seen: int = field(default=0, init=False)

    def __post_init__(self):
        # Connection pooling: create persistent client
        if STT_HTTP_POOL_ENABLED:
            timeout = max(5.0, float(self.timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS))
            self._client = httpx.AsyncClient(timeout=timeout)
            if TRACE_API_CALLS:
                logger.debug("[HTTP Pool] Persistent httpx.AsyncClient created (timeout=%.1fs)", timeout)

        # VAD: load model per session (separate LSTM states)
        if STT_VAD_ENABLED and _check_silero_vad():
            model = _create_vad_model()
            if model is not None:
                self._vad_model = model
                self._vad_available = True
                logger.info(
                    "[VAD] Enabled (min=%.1fs, max=%.1fs, silence=%dms, threshold=%.2f)",
                    STT_VAD_MIN_SECONDS,
                    STT_VAD_MAX_SECONDS,
                    STT_VAD_SILENCE_MS,
                    STT_VAD_THRESHOLD,
                )

    async def close(self):
        """Clean up pooled HTTP client and VAD model."""
        if self._client:
            await self._client.aclose()
            self._client = None
        if self._vad_model:
            try:
                self._vad_model.reset_states()
            except Exception:
                pass
            self._vad_model = None
            self._vad_available = False

    def is_ready(self) -> bool:
        return bool(str(self.http_url or "").strip())

    def _min_chunk_bytes(self) -> int:
        seconds = max(0.25, float(self.chunk_seconds or DEFAULT_HTTP_CHUNK_SECONDS))
        sample_width_bytes = 2  # int16
        return int(max(1.0, float(self.sample_rate_hz)) * sample_width_bytes * seconds)

    def _buffer_duration_seconds(self) -> float:
        """Duration of audio currently in the buffer."""
        if not self._buffer:
            return 0.0
        return len(self._buffer) / max(1, self.sample_rate_hz * 2)  # 2 bytes per int16 sample

    def _feed_vad(self, pcm_bytes: bytes) -> None:
        """Run VAD on incoming PCM chunk, updating _last_speech_sample if speech detected.

        Uses audio-sample-based timing (not wall clock) for accurate silence detection
        regardless of how fast audio data arrives.
        """
        if not self._vad_model:
            return
        num_new_samples = len(pcm_bytes) // 2
        base_sample = self._total_samples_seen
        try:
            import torch

            audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
            audio_float32 = audio_int16.astype(np.float32) / 32768.0
            window_size = _VAD_WINDOW_SIZE_16K if self.sample_rate_hz >= 16000 else _VAD_WINDOW_SIZE_8K

            for i in range(0, len(audio_float32) - window_size + 1, window_size):
                chunk = torch.from_numpy(audio_float32[i : i + window_size].copy())
                prob = self._vad_model(chunk, self.sample_rate_hz).item()
                if prob > STT_VAD_THRESHOLD:
                    self._last_speech_sample = base_sample + i + window_size
        except ImportError:
            logger.warning("[VAD] torch not available, disabling VAD for this session")
            self._vad_available = False
        except Exception as exc:
            logger.debug("[VAD] Frame processing failed: %s", exc)
            # Err on side of caution: assume speech to avoid premature flush
            self._last_speech_sample = base_sample + num_new_samples

    def _silence_ms(self) -> float:
        """Silence duration in ms based on audio samples (not wall clock)."""
        silence_samples = self._total_samples_seen - self._last_speech_sample
        return (silence_samples / max(1, self.sample_rate_hz)) * 1000

    async def push_audio_chunk(self, pcm_bytes: bytes) -> Optional[Dict[str, Any]]:
        if not pcm_bytes:
            return None
        self._chunks_seen += 1
        num_new_samples = len(pcm_bytes) // 2

        # Initialize speech sample when buffer starts (assume speech at start)
        if not self._buffer:
            self._last_speech_sample = self._total_samples_seen

        self._buffer.extend(pcm_bytes)

        if not self._vad_available:
            # Original behavior: fixed-interval chunking
            self._total_samples_seen += num_new_samples
            if len(self._buffer) < self._min_chunk_bytes():
                return None
            return await self._transcribe_buffer(is_final=False)

        # --- VAD-based chunking ---
        buffer_duration = self._buffer_duration_seconds()

        # Force flush at max seconds (safety cap)
        if buffer_duration >= STT_VAD_MAX_SECONDS:
            self._total_samples_seen += num_new_samples
            if TRACE_API_CALLS:
                logger.debug(
                    "[VAD] Force flush at %.1fs (max=%.1fs)",
                    buffer_duration,
                    STT_VAD_MAX_SECONDS,
                )
            self._vad_model.reset_states()
            return await self._transcribe_buffer(is_final=False)

        # Feed audio to VAD (updates _last_speech_sample if speech detected)
        self._feed_vad(pcm_bytes)
        self._total_samples_seen += num_new_samples

        # Re-check _vad_available (may have been disabled by _feed_vad on import error)
        if not self._vad_available:
            if len(self._buffer) < self._min_chunk_bytes():
                return None
            return await self._transcribe_buffer(is_final=False)

        # Don't consider flushing before min seconds
        if buffer_duration < STT_VAD_MIN_SECONDS:
            return None

        # Check if silence duration exceeds threshold (audio-time based)
        silence_ms = self._silence_ms()
        if silence_ms >= STT_VAD_SILENCE_MS:
            if TRACE_API_CALLS:
                logger.debug(
                    "[VAD] Speech-end flush at %.1fs (silence=%.0fms)",
                    buffer_duration,
                    silence_ms,
                )
            return await self._transcribe_buffer(is_final=False)

        return None

    async def flush(self) -> Optional[Dict[str, Any]]:
        if not self._buffer:
            return None
        return await self._transcribe_buffer(is_final=True)

    async def _transcribe_buffer(self, is_final: bool) -> Optional[Dict[str, Any]]:
        raw_pcm = bytes(self._buffer)
        self._buffer.clear()
        request_started_at = time.perf_counter()
        text, segments = await self._transcribe_pcm(raw_pcm)
        stt_request_ms = _elapsed_ms(request_started_at)
        if not text:
            return None
        result: Dict[str, Any] = {
            "text": text,
            "is_final": is_final,
            "metadata": {
                "provider": self.provider,
                "chunk_bytes": len(raw_pcm),
                "sample_rate_hz": self.sample_rate_hz,
                "chunks_seen": self._chunks_seen,
                "transport": "backend_http_stt",
                "stt_request_ms": stt_request_ms,
                "diarize_enabled": STT_DIARIZE_ENABLED,
                "vad_enabled": self._vad_available,
            },
        }
        if segments:
            result["segments"] = segments
        return result

    async def _transcribe_pcm(self, pcm_bytes: bytes) -> Tuple[str, Optional[List[Dict[str, Any]]]]:
        if not self.is_ready():
            raise RuntimeError(
                f"No STT HTTP URL configured for provider '{self.provider}'."
            )

        wav_payload = pcm16le_to_wav(pcm_bytes, sample_rate_hz=self.sample_rate_hz)
        form_data: Dict[str, str] = {}
        model = str(self.model or "").strip()
        if model:
            form_data["model"] = model
        language = str(self.language or "").strip()
        if language:
            form_data["language"] = language
        if STT_DIARIZE_ENABLED:
            form_data["diarize"] = "true"

        files = {"file": ("chunk.wav", wav_payload, "audio/wav")}
        timeout_seconds = max(5.0, float(self.timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS))
        if TRACE_API_CALLS:
            logger.info(
                "[STT HTTP] POST %s provider=%s chunk_bytes=%s wav_bytes=%s model=%s language=%s diarize=%s",
                self.http_url,
                self.provider,
                len(pcm_bytes),
                len(wav_payload),
                model or "-",
                language or "-",
                STT_DIARIZE_ENABLED,
            )

        # Use pooled client or create per-request client
        client = self._client
        should_close = False
        if not client:
            client = httpx.AsyncClient(timeout=timeout_seconds)
            should_close = True

        try:
            response = await client.post(self.http_url, data=form_data, files=files)
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                if TRACE_API_CALLS:
                    logger.warning(
                        "[STT HTTP] %s status=%s body_preview=%s",
                        self.http_url,
                        exc.response.status_code,
                        _preview_text(exc.response.text),
                    )
                raise
            payload = _parse_response_payload(response)
            text = extract_transcript_text(payload)
            segments = extract_diarized_segments(payload) if STT_DIARIZE_ENABLED else None
            if TRACE_API_CALLS:
                logger.info(
                    "[STT HTTP] %s status=%s transcript_preview=%s speakers=%s",
                    self.http_url,
                    response.status_code,
                    _preview_text(text),
                    len(segments) if segments else 0,
                )
            return text, segments
        finally:
            if should_close:
                await client.aclose()


def _parse_response_payload(response: httpx.Response) -> Any:
    content_type = str(response.headers.get("content-type", "")).lower()
    if "application/json" in content_type:
        return response.json()

    raw_text = response.text.strip()
    if not raw_text:
        return {}

    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        logger.debug("STT provider returned non-JSON response payload.")
        return {"text": raw_text}

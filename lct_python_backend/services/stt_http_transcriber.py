"""Backend-owned realtime STT helpers for HTTP transcription providers."""

import base64
import io
import json
import logging
import os
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np

logger = logging.getLogger("lct_backend")

DEFAULT_SAMPLE_RATE_HZ = int(os.getenv("STT_SAMPLE_RATE_HZ", "16000"))
DEFAULT_HTTP_TIMEOUT_SECONDS = float(os.getenv("STT_HTTP_TIMEOUT_SECONDS", "30"))
DEFAULT_HTTP_CHUNK_SECONDS = float(os.getenv("STT_HTTP_CHUNK_SECONDS", "1.2"))
DEFAULT_INITIAL_HTTP_CHUNK_SECONDS = float(os.getenv("STT_INITIAL_HTTP_CHUNK_SECONDS", "0.5"))
DEFAULT_HTTP_MODEL = os.getenv("STT_HTTP_MODEL", "")
DEFAULT_HTTP_LANGUAGE = os.getenv("STT_HTTP_LANGUAGE", "en")
from lct_python_backend.services.env_helpers import env_bool

TRACE_API_CALLS = env_bool("TRACE_API_CALLS", default=True)
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))
SMOKE_TEST_DURATION_SECONDS = float(os.getenv("STT_SMOKE_TEST_DURATION_SECONDS", "1.2"))
SMOKE_TEST_TIMEOUT_SECONDS = float(os.getenv("STT_SMOKE_TEST_TIMEOUT_SECONDS", "20"))
STT_CIRCUIT_BREAKER_ENABLED = env_bool("STT_CIRCUIT_BREAKER_ENABLED", default=True)
STT_CIRCUIT_TIMEOUT_TTL_SECONDS = float(os.getenv("STT_CIRCUIT_TIMEOUT_TTL_SECONDS", "45"))
STT_CIRCUIT_NETWORK_TTL_SECONDS = float(os.getenv("STT_CIRCUIT_NETWORK_TTL_SECONDS", "30"))
STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS = float(os.getenv("STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS", "30"))
STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS = float(os.getenv("STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS", "20"))
STT_CIRCUIT_AUTH_TTL_SECONDS = float(os.getenv("STT_CIRCUIT_AUTH_TTL_SECONDS", "300"))
OPENROUTER_TRANSCRIPTION_PROMPT = (
    "Transcribe this audio accurately. Return plain text only. "
    "Do not summarize. Do not add speaker labels."
)

# --- Diarization feature flag ---
STT_DIARIZE_ENABLED = env_bool("STT_DIARIZE_ENABLED", default=False)

# --- VAD + Pooling feature flags ---
STT_VAD_ENABLED = env_bool("STT_VAD_ENABLED", default=False)
STT_VAD_MIN_SECONDS = float(os.getenv("STT_VAD_MIN_SECONDS", "0.5"))
STT_VAD_MAX_SECONDS = float(os.getenv("STT_VAD_MAX_SECONDS", "5.0"))
STT_VAD_SILENCE_MS = int(os.getenv("STT_VAD_SILENCE_MS", "300"))
STT_VAD_THRESHOLD = float(os.getenv("STT_VAD_THRESHOLD", "0.5"))
STT_HTTP_POOL_ENABLED = env_bool("STT_HTTP_POOL_ENABLED", default=True)

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


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


def _candidate_endpoint(candidate: Dict[str, Any]) -> str:
    return str(candidate.get("http_url") or candidate.get("base_url") or "").strip()


def _candidate_cache_key(candidate: Dict[str, Any]) -> Tuple[str, str, str]:
    return (
        str(candidate.get("provider") or "").strip().lower(),
        str(candidate.get("transport") or "").strip().lower(),
        _candidate_endpoint(candidate),
    )


def _circuit_ttl_seconds(error_type: str) -> float:
    normalized = str(error_type or "").strip().lower()
    if normalized == "auth_failed":
        return max(0.0, STT_CIRCUIT_AUTH_TTL_SECONDS)
    if normalized in {"rate_limited", "quota_exceeded"}:
        return max(0.0, STT_CIRCUIT_RATE_LIMIT_TTL_SECONDS)
    if normalized == "timeout":
        return max(0.0, STT_CIRCUIT_TIMEOUT_TTL_SECONDS)
    if normalized == "network_error":
        return max(0.0, STT_CIRCUIT_NETWORK_TTL_SECONDS)
    if normalized in {"provider_error", "not_found"}:
        return max(0.0, STT_CIRCUIT_PROVIDER_ERROR_TTL_SECONDS)
    return 0.0


def _classify_http_status(status_code: Optional[int], response_text: str = "") -> str:
    if status_code in {401, 403}:
        return "auth_failed"

    preview = str(response_text or "").lower()
    if status_code == 429:
        if any(token in preview for token in ("quota", "insufficient_quota", "credit", "billing")):
            return "quota_exceeded"
        return "rate_limited"
    if status_code == 400:
        if "invalid_api_key" in preview or "incorrect api key" in preview:
            return "auth_failed"
        return "bad_request"
    if status_code == 404:
        return "not_found"
    if status_code == 408:
        return "timeout"
    if status_code and status_code >= 500:
        return "provider_error"
    return "provider_error"


def _summarize_exception(exc: Exception) -> Dict[str, Any]:
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        status_code = response.status_code if response is not None else None
        body_preview = ""
        error_type = _classify_http_status(status_code, "")
        
        # Try to read response body for better error messages
        try:
            if response is not None:
                body_preview = _preview_text(response.text if response is not None else "")
                # Re-classify based on actual body content
                if status_code == 400 and body_preview:
                    error_type = _classify_http_status(status_code, body_preview)
        except Exception as read_exc:
            logger.warning("[STT] Failed to read response body: %s", read_exc)
        
        reason_phrase = ""
        if response is not None:
            reason_phrase = str(getattr(response, "reason_phrase", "") or "").strip()
        
        status_label = f"HTTP {status_code}" if status_code is not None else "HTTP error"
        if reason_phrase:
            status_label = f"{status_label} {reason_phrase}"
        
        # Add helpful hint for auth failures
        detail = status_label
        if body_preview:
            detail = f"{detail}: {body_preview}"
        if error_type == "auth_failed":
            detail = f"{detail} - Check your API key is valid and not expired"
        
        return {
            "error_type": error_type,
            "status_code": status_code,
            "body_preview": body_preview,
            "detail": detail,
        }

    if isinstance(exc, httpx.TimeoutException):
        return {
            "error_type": "timeout",
            "status_code": None,
            "body_preview": "",
            "detail": str(exc) or "Timed out waiting for STT provider response.",
        }

    if isinstance(exc, httpx.RequestError):
        return {
            "error_type": "network_error",
            "status_code": None,
            "body_preview": "",
            "detail": str(exc) or "Network error while contacting STT provider.",
        }

    return {
        "error_type": "provider_error",
        "status_code": None,
        "body_preview": "",
        "detail": str(exc) or exc.__class__.__name__,
    }


def build_smoke_test_pcm(
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
    duration_seconds: float = SMOKE_TEST_DURATION_SECONDS,
) -> bytes:
    duration = min(max(float(duration_seconds or SMOKE_TEST_DURATION_SECONDS), 0.5), 4.0)
    sample_rate = max(8000, int(sample_rate_hz or DEFAULT_SAMPLE_RATE_HZ))
    sample_count = int(sample_rate * duration)
    if sample_count <= 0:
        return b""

    time_axis = np.linspace(0.0, duration, sample_count, endpoint=False, dtype=np.float32)
    frequencies = np.where(time_axis < duration / 2.0, 440.0, 660.0)
    tone = 0.18 * np.sin(2.0 * np.pi * frequencies * time_axis)

    attack_release = min(0.08, duration / 4.0)
    envelope = np.ones(sample_count, dtype=np.float32)
    if attack_release > 0:
        ramp_count = max(1, int(sample_rate * attack_release))
        ramp = np.linspace(0.0, 1.0, ramp_count, endpoint=True, dtype=np.float32)
        envelope[:ramp_count] = ramp
        envelope[-ramp_count:] = ramp[::-1]

    pcm_signal = np.clip(tone * envelope * 32767.0, -32768.0, 32767.0).astype(np.int16)
    return pcm_signal.tobytes()


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


from lct_python_backend.services.stt_response_parsers import (  # noqa: F401  re-exported
    extract_diarized_segments,
    extract_openai_diarized_segments,
    extract_openrouter_transcript_text,
    extract_transcript_text,
    text_from_segments as _text_from_segments,
)


_VAD_WINDOW_SIZE_16K = 512  # 32ms at 16kHz
_VAD_WINDOW_SIZE_8K = 256  # 32ms at 8kHz


@dataclass
class RealtimeHttpSttSession:
    provider: str
    http_url: str
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ
    chunk_seconds: float = DEFAULT_HTTP_CHUNK_SECONDS
    initial_chunk_seconds: float = DEFAULT_INITIAL_HTTP_CHUNK_SECONDS
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS
    model: str = DEFAULT_HTTP_MODEL
    language: str = DEFAULT_HTTP_LANGUAGE
    candidates: Optional[List[Dict[str, Any]]] = None
    session_id: str = ""
    conversation_id: str = ""
    _buffer: bytearray = field(default_factory=bytearray)
    _chunks_seen: int = 0
    # Connection pooling
    _client: Optional[httpx.AsyncClient] = field(default=None, init=False, repr=False)
    # VAD state
    _vad_model: Any = field(default=None, init=False, repr=False)
    _vad_available: bool = field(default=False, init=False)
    _last_speech_sample: int = field(default=0, init=False)
    _total_samples_seen: int = field(default=0, init=False)
    _last_runtime_metadata: Dict[str, Any] = field(default_factory=dict, init=False)
    _successful_transcripts: int = field(default=0, init=False)
    _candidate_circuit_state: Dict[Tuple[str, str, str], Dict[str, Any]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )

    def __post_init__(self):
        if not self.candidates:
            self.candidates = [
                {
                    "provider": self.provider,
                    "transport": "backend_http",
                    "http_url": str(self.http_url or "").strip(),
                    "reason": "configured_provider",
                    "supports_diarization": self.provider == "whisper",
                    "degraded": False,
                }
            ]
        # Connection pooling: create persistent client.
        # We disable keep-alive (max_keepalive_connections=0) — OpenAI's edge
        # routinely drops idle keep-alive sockets, then httpx reuses the
        # dead socket → WinError 10054 ("Connection forcibly closed").
        # Tradeoff: ~50-200ms TLS handshake per chunk, negligible vs the
        # 30s per-chunk STT latency, and eliminates the most common
        # transient class.
        if STT_HTTP_POOL_ENABLED:
            timeout = max(5.0, float(self.timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS))
            self._client = httpx.AsyncClient(
                timeout=timeout,
                limits=httpx.Limits(max_keepalive_connections=0, max_connections=10),
            )
            if TRACE_API_CALLS:
                logger.debug("[HTTP Pool] httpx.AsyncClient created (timeout=%.1fs, keepalive=off)", timeout)

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
            except Exception as exc:
                logger.warning("[VAD] reset_states() failed during cleanup: %s", exc)
            self._vad_model = None
            self._vad_available = False

    def is_ready(self) -> bool:
        for candidate in self.candidates or []:
            endpoint = _candidate_endpoint(candidate)
            if endpoint:
                return True
        return False

    def get_last_runtime_metadata(self) -> Dict[str, Any]:
        if not isinstance(self._last_runtime_metadata, dict):
            return {}
        return dict(self._last_runtime_metadata)

    def _current_chunk_seconds(self) -> float:
        steady_state = max(0.25, float(self.chunk_seconds or DEFAULT_HTTP_CHUNK_SECONDS))
        initial = max(0.25, float(self.initial_chunk_seconds or DEFAULT_INITIAL_HTTP_CHUNK_SECONDS))
        if self._successful_transcripts > 0:
            return steady_state
        return min(initial, steady_state)

    def _min_chunk_bytes(self) -> int:
        seconds = self._current_chunk_seconds()
        sample_width_bytes = 2  # int16
        return int(max(1.0, float(self.sample_rate_hz)) * sample_width_bytes * seconds)

    def _circuit_state_for_candidate(self, candidate: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not STT_CIRCUIT_BREAKER_ENABLED:
            return None
        key = _candidate_cache_key(candidate)
        state = self._candidate_circuit_state.get(key)
        if not state:
            return None
        if time.monotonic() >= float(state.get("until_monotonic") or 0.0):
            self._candidate_circuit_state.pop(key, None)
            return None
        return dict(state)

    def _mark_candidate_failure(
        self,
        candidate: Dict[str, Any],
        *,
        error_type: str,
        detail: str,
        latency_ms: float,
    ) -> None:
        ttl_seconds = _circuit_ttl_seconds(error_type)
        if ttl_seconds <= 0.0 or not STT_CIRCUIT_BREAKER_ENABLED:
            return
        key = _candidate_cache_key(candidate)
        self._candidate_circuit_state[key] = {
            "error_type": str(error_type or "provider_error"),
            "detail": str(detail or ""),
            "latency_ms": latency_ms,
            "opened_at": _utc_now_iso(),
            "until_monotonic": time.monotonic() + ttl_seconds,
            "ttl_seconds": ttl_seconds,
        }

    def _clear_candidate_failure(self, candidate: Dict[str, Any]) -> None:
        self._candidate_circuit_state.pop(_candidate_cache_key(candidate), None)

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
        raw_sample_count = len(raw_pcm) // 2
        chunk_end_seconds = self._total_samples_seen / max(1, self.sample_rate_hz)
        chunk_start_seconds = max(
            0.0,
            (self._total_samples_seen - raw_sample_count) / max(1, self.sample_rate_hz),
        )
        wav_payload = pcm16le_to_wav(raw_pcm, sample_rate_hz=self.sample_rate_hz)
        self._buffer.clear()
        request_started_at = time.perf_counter()
        self._last_runtime_metadata = {}
        text, segments = await self._transcribe_pcm(raw_pcm)
        stt_request_ms = _elapsed_ms(request_started_at)
        if not text:
            return None
        self._successful_transcripts += 1
        runtime_metadata = (
            dict(self._last_runtime_metadata)
            if isinstance(self._last_runtime_metadata, dict)
            else {}
        )
        result: Dict[str, Any] = {
            "text": text,
            "is_final": is_final,
            "timestamps": {
                "start": round(chunk_start_seconds, 6),
                "end": round(chunk_end_seconds, 6),
            },
            "metadata": {
                "provider": runtime_metadata.get("provider", self.provider),
                "chunk_bytes": len(raw_pcm),
                "sample_rate_hz": self.sample_rate_hz,
                "chunks_seen": self._chunks_seen,
                "transport": runtime_metadata.get("transport", "backend_http_stt"),
                "stt_request_ms": stt_request_ms,
                "diarize_enabled": runtime_metadata.get("diarize_enabled", STT_DIARIZE_ENABLED),
                "vad_enabled": self._vad_available,
                "fallback_used": bool(runtime_metadata.get("fallback_used")),
                "fallback_reason": runtime_metadata.get("fallback_reason"),
                "fallback_from": runtime_metadata.get("fallback_from"),
                "fallback_to": runtime_metadata.get("fallback_to"),
                "candidate_count": runtime_metadata.get("candidate_count"),
                "attempt_count": runtime_metadata.get("attempt_count"),
                "stt_flow_started_at": runtime_metadata.get("stt_flow_started_at"),
                "stt_flow_completed_at": runtime_metadata.get("stt_flow_completed_at"),
                "stt_flow_ms": runtime_metadata.get("stt_flow_ms"),
                "degraded": bool(runtime_metadata.get("degraded")),
                "supports_diarization": bool(runtime_metadata.get("supports_diarization")),
            },
            "_wav_payload": wav_payload,
        }
        if segments:
            result["segments"] = segments
        return result

    async def _transcribe_candidate(
        self,
        client: httpx.AsyncClient,
        candidate: Dict[str, Any],
        pcm_bytes: bytes,
        wav_payload: bytes,
        *,
        known_speakers: Optional[List[Dict[str, str]]] = None,
    ) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
        transport = str(candidate.get("transport") or "backend_http").strip().lower()
        if transport == "openai_audio":
            return await self._transcribe_openai_audio_candidate(
                client,
                candidate,
                wav_payload,
                known_speakers=known_speakers,
            )
        if transport == "openrouter_audio":
            return await self._transcribe_openrouter_audio_candidate(
                client,
                candidate,
                wav_payload,
            )
        return await self._transcribe_backend_http_candidate(
            client,
            candidate,
            pcm_bytes,
            wav_payload,
        )

    async def _transcribe_pcm(self, pcm_bytes: bytes) -> Tuple[str, Optional[List[Dict[str, Any]]]]:
        if not self.is_ready():
            raise RuntimeError(
                f"No STT HTTP URL configured for provider '{self.provider}'."
            )

        wav_payload = pcm16le_to_wav(pcm_bytes, sample_rate_hz=self.sample_rate_hz)
        timeout_seconds = max(5.0, float(self.timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS))
        client = self._client
        should_close = False
        if not client:
            client = httpx.AsyncClient(timeout=timeout_seconds)
            should_close = True

        candidates = list(self.candidates or [])
        errors: List[str] = []
        primary_provider = str(candidates[0].get("provider") or self.provider) if candidates else self.provider
        attempt_summaries: List[Dict[str, Any]] = []
        flow_started_at = time.perf_counter()
        flow_started_iso = _utc_now_iso()

        if TRACE_API_CALLS and candidates:
            candidate_log = [
                {
                    "route_id": str(candidate.get("route_id") or ""),
                    "provider": str(candidate.get("provider") or ""),
                    "transport": str(candidate.get("transport") or ""),
                    "endpoint": _candidate_endpoint(candidate),
                    "reason": str(candidate.get("reason") or ""),
                }
                for candidate in candidates
            ]
            logger.info(
                "[STT FLOW] session=%s conversation=%s provider=%s chunk_bytes=%s candidates=%s",
                self.session_id or "-",
                self.conversation_id or "-",
                self.provider,
                len(pcm_bytes),
                json.dumps(candidate_log, separators=(",", ":")),
            )

        try:
            for index, candidate in enumerate(candidates):
                transport = str(candidate.get("transport") or "backend_http").strip().lower()
                candidate_provider = str(candidate.get("provider") or self.provider).strip() or self.provider
                candidate_reason = str(candidate.get("reason") or "").strip() or None
                candidate_route_id = str(candidate.get("route_id") or "").strip() or None
                candidate_endpoint = _candidate_endpoint(candidate)
                circuit_state = self._circuit_state_for_candidate(candidate)
                if circuit_state:
                    ttl_remaining_ms = round(
                        max(
                            0.0,
                            (float(circuit_state.get("until_monotonic") or 0.0) - time.monotonic()) * 1000.0,
                        ),
                        2,
                    )
                    attempt_summaries.append(
                        {
                            "attempt": index + 1,
                            "route_id": candidate_route_id,
                            "provider": candidate_provider,
                            "transport": transport,
                            "endpoint": candidate_endpoint,
                            "reason": candidate_reason,
                            "started_at": _utc_now_iso(),
                            "latency_ms": 0.0,
                            "outcome": "skipped_circuit_open",
                            "error_type": circuit_state.get("error_type"),
                            "status_code": None,
                            "error": circuit_state.get("detail"),
                            "ttl_remaining_ms": ttl_remaining_ms,
                        }
                    )
                    logger.info(
                        "[STT FLOW] session=%s conversation=%s attempt=%s/%s skipped provider=%s transport=%s endpoint=%s error_type=%s ttl_remaining_ms=%s",
                        self.session_id or "-",
                        self.conversation_id or "-",
                        index + 1,
                        len(candidates),
                        candidate_provider,
                        transport,
                        candidate_endpoint or "-",
                        circuit_state.get("error_type") or "provider_error",
                        ttl_remaining_ms,
                    )
                    errors.append(
                        f"{candidate_provider}/{transport} [circuit_open for {ttl_remaining_ms}ms]: "
                        f"{circuit_state.get('detail') or circuit_state.get('error_type') or 'temporarily unavailable'}"
                    )
                    continue
                attempt_started_at = time.perf_counter()
                attempt_started_iso = _utc_now_iso()

                if TRACE_API_CALLS:
                    logger.info(
                        "[STT FLOW] session=%s conversation=%s attempt=%s/%s route=%s provider=%s transport=%s endpoint=%s reason=%s",
                        self.session_id or "-",
                        self.conversation_id or "-",
                        index + 1,
                        len(candidates),
                        candidate_route_id or "-",
                        candidate_provider,
                        transport,
                        candidate_endpoint or "-",
                        candidate_reason or "-",
                    )

                try:
                    text, segments, diarize_enabled = await self._transcribe_candidate(
                        client,
                        candidate,
                        pcm_bytes,
                        wav_payload,
                    )
                except Exception as exc:
                    attempt_latency_ms = _elapsed_ms(attempt_started_at)
                    error_info = _summarize_exception(exc)
                    error_message = (
                        f"{candidate_provider}/{transport} [{error_info['error_type']} after "
                        f"{attempt_latency_ms}ms]: {error_info['detail']}"
                    )
                    attempt_summaries.append(
                        {
                            "attempt": index + 1,
                            "route_id": candidate_route_id,
                            "provider": candidate_provider,
                            "transport": transport,
                            "endpoint": candidate_endpoint,
                            "reason": candidate_reason,
                            "started_at": attempt_started_iso,
                            "latency_ms": attempt_latency_ms,
                            "outcome": "error",
                            "error_type": error_info["error_type"],
                            "status_code": error_info["status_code"],
                            "error": error_info["detail"],
                        }
                    )
                    logger.warning(
                        "[STT FLOW] session=%s conversation=%s attempt=%s/%s failed provider=%s transport=%s endpoint=%s latency_ms=%s error_type=%s detail=%s",
                        self.session_id or "-",
                        self.conversation_id or "-",
                        index + 1,
                        len(candidates),
                        candidate_provider,
                        transport,
                        candidate_endpoint or "-",
                        attempt_latency_ms,
                        error_info["error_type"],
                        error_info["detail"],
                    )
                    self._mark_candidate_failure(
                        candidate,
                        error_type=error_info["error_type"],
                        detail=error_info["detail"],
                        latency_ms=attempt_latency_ms,
                    )
                    errors.append(error_message)
                    continue

                if not text:
                    attempt_latency_ms = _elapsed_ms(attempt_started_at)
                    error_message = (
                        f"{candidate_provider}/{transport} [empty_transcript after "
                        f"{attempt_latency_ms}ms]: provider accepted the request but returned no text"
                    )
                    attempt_summaries.append(
                        {
                            "attempt": index + 1,
                            "route_id": candidate_route_id,
                            "provider": candidate_provider,
                            "transport": transport,
                            "endpoint": candidate_endpoint,
                            "reason": candidate_reason,
                            "started_at": attempt_started_iso,
                            "latency_ms": attempt_latency_ms,
                            "outcome": "empty_transcript",
                            "error_type": "empty_transcript",
                            "status_code": None,
                            "error": "Provider accepted the request but returned no transcript text.",
                        }
                    )
                    logger.warning(
                        "[STT FLOW] session=%s conversation=%s attempt=%s/%s empty provider=%s transport=%s endpoint=%s latency_ms=%s",
                        self.session_id or "-",
                        self.conversation_id or "-",
                        index + 1,
                        len(candidates),
                        candidate_provider,
                        transport,
                        candidate_endpoint or "-",
                        attempt_latency_ms,
                    )
                    self._last_runtime_metadata = {
                        "provider": candidate_provider,
                        "transport": transport,
                        "fallback_used": False,
                        "fallback_reason": candidate_reason,
                        "fallback_from": None,
                        "fallback_to": None,
                        "candidate_count": len(candidates),
                        "attempt_count": len(attempt_summaries),
                        "attempts": attempt_summaries,
                        "stt_flow_started_at": flow_started_iso,
                        "stt_flow_completed_at": _utc_now_iso(),
                        "stt_flow_ms": _elapsed_ms(flow_started_at),
                        "degraded": bool(candidate.get("degraded")),
                        "supports_diarization": bool(candidate.get("supports_diarization")),
                        "diarize_enabled": diarize_enabled,
                        "empty_transcript": True,
                    }
                    if transport in {"openai_audio", "openrouter_audio"}:
                        logger.info(
                            "[STT FLOW] session=%s conversation=%s provider=%s transport=%s empty transcript treated as no-speech event; skipping fallback chain",
                            self.session_id or "-",
                            self.conversation_id or "-",
                            candidate_provider,
                            transport,
                        )
                        self._clear_candidate_failure(candidate)
                        return "", None
                    errors.append(error_message)
                    continue

                fallback_used = index > 0
                attempt_latency_ms = _elapsed_ms(attempt_started_at)
                flow_ms = _elapsed_ms(flow_started_at)
                attempt_summaries.append(
                    {
                        "attempt": index + 1,
                        "route_id": candidate_route_id,
                        "provider": candidate_provider,
                        "transport": transport,
                        "endpoint": candidate_endpoint,
                        "reason": candidate_reason,
                        "started_at": attempt_started_iso,
                        "latency_ms": attempt_latency_ms,
                        "outcome": "success",
                        "error_type": None,
                        "status_code": None,
                    }
                )
                self._last_runtime_metadata = {
                    "provider": candidate_provider,
                    "transport": transport,
                    "fallback_used": fallback_used,
                    "fallback_reason": candidate_reason,
                    "fallback_from": primary_provider if fallback_used else None,
                    "fallback_to": candidate_provider if fallback_used else None,
                    "candidate_count": len(candidates),
                    "attempt_count": len(attempt_summaries),
                    "attempts": attempt_summaries,
                    "stt_flow_started_at": flow_started_iso,
                    "stt_flow_completed_at": _utc_now_iso(),
                    "stt_flow_ms": flow_ms,
                    "degraded": bool(candidate.get("degraded")),
                    "supports_diarization": bool(candidate.get("supports_diarization")),
                    "diarize_enabled": diarize_enabled,
                }
                self._clear_candidate_failure(candidate)
                logger.info(
                    "[STT FLOW] session=%s conversation=%s success provider=%s transport=%s endpoint=%s attempt=%s/%s latency_ms=%s flow_ms=%s fallback_used=%s transcript_preview=%s",
                    self.session_id or "-",
                    self.conversation_id or "-",
                    candidate_provider,
                    transport,
                    candidate_endpoint or "-",
                    index + 1,
                    len(candidates),
                    attempt_latency_ms,
                    flow_ms,
                    fallback_used,
                    _preview_text(text),
                )
                return text, segments

            self._last_runtime_metadata = {
                "provider": primary_provider,
                "transport": "backend_http_stt",
                "fallback_used": False,
                "fallback_reason": None,
                "fallback_from": None,
                "fallback_to": None,
                "candidate_count": len(candidates),
                "attempt_count": len(attempt_summaries),
                "attempts": attempt_summaries,
                "stt_flow_started_at": flow_started_iso,
                "stt_flow_completed_at": _utc_now_iso(),
                "stt_flow_ms": _elapsed_ms(flow_started_at),
                "degraded": False,
                "supports_diarization": False,
                "diarize_enabled": STT_DIARIZE_ENABLED,
            }
            raise RuntimeError(
                "All live STT candidates failed. " + "; ".join(errors or ["No usable candidates"])
            )
        finally:
            if should_close:
                await client.aclose()

    async def _transcribe_backend_http_candidate(
        self,
        client: httpx.AsyncClient,
        candidate: Dict[str, Any],
        pcm_bytes: bytes,
        wav_payload: bytes,
    ) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
        http_url = str(candidate.get("http_url") or self.http_url or "").strip()
        model = str(candidate.get("model") or self.model or "").strip()
        language = str(candidate.get("language") or self.language or "").strip()
        diarize_enabled = bool(candidate.get("request_diarization", STT_DIARIZE_ENABLED))
        form_data: Dict[str, str] = {"diarize": "true" if diarize_enabled else "false"}
        if model:
            form_data["model"] = model
        if language:
            form_data["language"] = language

        if TRACE_API_CALLS:
            logger.info(
                "[STT HTTP] POST %s provider=%s chunk_bytes=%s wav_bytes=%s model=%s language=%s diarize=%s",
                http_url,
                candidate.get("provider") or self.provider,
                len(pcm_bytes),
                len(wav_payload),
                model or "-",
                language or "-",
                diarize_enabled,
            )

        response = await client.post(
            http_url,
            data=form_data,
            files={"file": ("chunk.wav", wav_payload, "audio/wav")},
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if TRACE_API_CALLS:
                logger.warning(
                    "[STT HTTP] %s status=%s body_preview=%s",
                    http_url,
                    exc.response.status_code,
                    _preview_text(exc.response.text),
                )
            raise

        payload = _parse_response_payload(response)
        text = extract_transcript_text(payload)
        segments = extract_diarized_segments(payload) if diarize_enabled else None
        if TRACE_API_CALLS:
            logger.info(
                "[STT HTTP] %s status=%s transcript_preview=%s speakers=%s",
                http_url,
                response.status_code,
                _preview_text(text),
                len(segments) if segments else 0,
            )
        return text, segments, diarize_enabled

    async def _transcribe_openai_audio_candidate(
        self,
        client: httpx.AsyncClient,
        candidate: Dict[str, Any],
        wav_payload: bytes,
        *,
        known_speakers: Optional[List[Dict[str, str]]] = None,
    ) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
        model = str(candidate.get("model") or "").strip()
        api_key = str(candidate.get("api_key") or "").strip()
        http_url = str(candidate.get("http_url") or "").strip()
        language = str(candidate.get("language") or self.language or "").strip()
        request_diarization = bool(candidate.get("request_diarization", True))
        
        # OpenAI supports streaming for already completed audio recordings.
        # This is useful for low-latency feedback even for chunks.
        # DISABLED: streaming causes httpx issues with error handling and fallback chain
        should_stream = False  # model in {"gpt-4o-mini-transcribe", "gpt-4o-transcribe"} and not request_diarization
        
        response_format = "diarized_json" if request_diarization else "json"
        form_data = {
            "model": model,
            "response_format": response_format,
        }
        if request_diarization:
            form_data["chunking_strategy"] = "auto"
            if known_speakers and model == "gpt-4o-transcribe-diarize":
                # known_speakers is List[Dict[name, audio_base64]]
                speaker_names = []
                speaker_refs = []
                for s in known_speakers:
                    name = s.get("name")
                    ref = s.get("audio_base64")
                    if name and ref:
                        speaker_names.append(name)
                        # Reference must be a data URL
                        if not ref.startswith("data:"):
                            ref = f"data:audio/wav;base64,{ref}"
                        speaker_refs.append(ref)
                
                if speaker_names:
                    # httpx supports multiple values for the same key by passing a list
                    form_data["known_speaker_names[]"] = speaker_names
                    form_data["known_speaker_references[]"] = speaker_refs

        if language:
            form_data["language"] = language
        if should_stream:
            form_data["stream"] = "true"
            
        headers = {"Authorization": f"Bearer {api_key}"}

        if TRACE_API_CALLS:
            logger.info(
                "[STT OpenAI] POST %s model=%s wav_bytes=%s response_format=%s language=%s stream=%s known_speakers=%s",
                http_url,
                model or "-",
                len(wav_payload),
                response_format,
                language or "-",
                should_stream,
                len(known_speakers) if known_speakers else 0,
            )

        if should_stream:
            # Use request directly to handle streaming response
            full_text = ""
            async with client.stream(
                "POST",
                http_url,
                headers=headers,
                data=form_data,
                files={"file": ("chunk.wav", wav_payload, "audio/wav")},
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[len("data: "):].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk_payload = json.loads(data_str)
                        text_part = extract_transcript_text(chunk_payload)
                        if text_part:
                            full_text += text_part
                    except json.JSONDecodeError:
                        continue
            return full_text, None, False

        response = await client.post(
            http_url,
            headers=headers,
            data=form_data,
            files={"file": ("chunk.wav", wav_payload, "audio/wav")},
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if TRACE_API_CALLS:
                logger.warning(
                    "[STT OpenAI] %s status=%s body_preview=%s",
                    http_url,
                    exc.response.status_code,
                    _preview_text(exc.response.text),
                )
            raise
        payload = _parse_response_payload(response)
        segments = extract_openai_diarized_segments(payload) if request_diarization else None
        text = extract_transcript_text(payload) or _text_from_segments(segments)
        if TRACE_API_CALLS:
            logger.info(
                "[STT OpenAI] %s status=%s transcript_preview=%s speakers=%s",
                http_url,
                response.status_code,
                _preview_text(text),
                len(segments) if segments else 0,
            )
        return text, segments, request_diarization

    async def _transcribe_openrouter_audio_candidate(
        self,
        client: httpx.AsyncClient,
        candidate: Dict[str, Any],
        wav_payload: bytes,
    ) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
        model = str(candidate.get("model") or "").strip()
        api_key = str(candidate.get("api_key") or "").strip()
        http_url = str(candidate.get("http_url") or "").strip()
        language = str(candidate.get("language") or self.language or "").strip()
        prompt = OPENROUTER_TRANSCRIPTION_PROMPT
        if language:
            prompt = f"{prompt} The audio language is {language}."
        base64_audio = base64.b64encode(wav_payload).decode("utf-8")
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64_audio,
                                "format": "wav",
                            },
                        },
                    ],
                }
            ],
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        if TRACE_API_CALLS:
            logger.info(
                "[STT OpenRouter] POST %s model=%s wav_bytes=%s language=%s",
                http_url,
                model or "-",
                len(wav_payload),
                language or "-",
            )

        response = await client.post(http_url, headers=headers, json=payload)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if TRACE_API_CALLS:
                logger.warning(
                    "[STT OpenRouter] %s status=%s body_preview=%s",
                    http_url,
                    exc.response.status_code,
                    _preview_text(exc.response.text),
                )
            raise
        response_payload = _parse_response_payload(response)
        text = extract_openrouter_transcript_text(response_payload)
        if TRACE_API_CALLS:
            logger.info(
                "[STT OpenRouter] %s status=%s transcript_preview=%s",
                http_url,
                response.status_code,
                _preview_text(text),
            )
        return text, None, False


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


async def smoke_test_stt_candidate(
    candidate: Dict[str, Any],
    *,
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
    timeout_seconds: float = SMOKE_TEST_TIMEOUT_SECONDS,
    language: str = DEFAULT_HTTP_LANGUAGE,
) -> Dict[str, Any]:
    candidate_provider = str(candidate.get("provider") or "unknown").strip() or "unknown"
    transport = str(candidate.get("transport") or "backend_http").strip().lower() or "backend_http"
    endpoint = _candidate_endpoint(candidate)
    checked_at = _utc_now_iso()
    started_at = time.perf_counter()

    pcm_bytes = build_smoke_test_pcm(sample_rate_hz=sample_rate_hz)
    wav_payload = pcm16le_to_wav(pcm_bytes, sample_rate_hz=sample_rate_hz)

    runtime = RealtimeHttpSttSession(
        provider=candidate_provider,
        http_url=endpoint,
        sample_rate_hz=sample_rate_hz,
        timeout_seconds=max(5.0, float(timeout_seconds or SMOKE_TEST_TIMEOUT_SECONDS)),
        language=language,
        candidates=[candidate],
    )
    client = runtime._client
    should_close = False
    if not client:
        client = httpx.AsyncClient(timeout=max(5.0, float(timeout_seconds or SMOKE_TEST_TIMEOUT_SECONDS)))
        should_close = True

    try:
        text, segments, diarize_enabled = await runtime._transcribe_candidate(
            client,
            candidate,
            pcm_bytes,
            wav_payload,
        )
        latency_ms = _elapsed_ms(started_at)
        warning = None
        if not text:
            warning = "Provider authenticated and accepted the test audio, but returned no transcript preview."
        result = {
            "provider": candidate_provider,
            "transport": transport,
            "route_id": str(candidate.get("route_id") or ""),
            "http_url": endpoint or None,
            "base_url": str(candidate.get("base_url") or "").strip() or None,
            "model": str(candidate.get("model") or "").strip() or None,
            "checked_at": checked_at,
            "ok": True,
            "status": "ready",
            "latency_ms": latency_ms,
            "sample_seconds": round(len(pcm_bytes) / max(1, sample_rate_hz * 2), 2),
            "diarization_requested": diarize_enabled,
            "supports_diarization": bool(candidate.get("supports_diarization")),
            "degraded": bool(candidate.get("degraded")),
            "transcript_preview": _preview_text(text),
            "segments_count": len(segments) if segments else 0,
            "warning": warning,
            "error": None,
            "status_code": None,
        }
        logger.info(
            "[STT TEST] provider=%s transport=%s endpoint=%s status=%s latency_ms=%s transcript_preview=%s warning=%s",
            candidate_provider,
            transport,
            endpoint or "-",
            result["status"],
            latency_ms,
            result["transcript_preview"] or "-",
            warning or "-",
        )
        return result
    except Exception as exc:
        latency_ms = _elapsed_ms(started_at)
        error_info = _summarize_exception(exc)
        logger.warning(
            "[STT TEST] provider=%s transport=%s endpoint=%s status=%s latency_ms=%s detail=%s",
            candidate_provider,
            transport,
            endpoint or "-",
            error_info["error_type"],
            latency_ms,
            error_info["detail"],
        )
        return {
            "provider": candidate_provider,
            "transport": transport,
            "route_id": str(candidate.get("route_id") or ""),
            "http_url": endpoint or None,
            "base_url": str(candidate.get("base_url") or "").strip() or None,
            "model": str(candidate.get("model") or "").strip() or None,
            "checked_at": checked_at,
            "ok": False,
            "status": error_info["error_type"],
            "latency_ms": latency_ms,
            "sample_seconds": round(len(pcm_bytes) / max(1, sample_rate_hz * 2), 2),
            "diarization_requested": bool(candidate.get("request_diarization", False)),
            "supports_diarization": bool(candidate.get("supports_diarization")),
            "degraded": bool(candidate.get("degraded")),
            "transcript_preview": "",
            "segments_count": 0,
            "warning": None,
            "error": error_info["detail"],
            "status_code": error_info["status_code"],
        }
    finally:
        if should_close:
            await client.aclose()
        await runtime.close()


async def transcribe_wav_stt_candidate(
    candidate: Dict[str, Any],
    *,
    wav_payload: bytes,
    sample_rate_hz: int = DEFAULT_SAMPLE_RATE_HZ,
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    language: str = DEFAULT_HTTP_LANGUAGE,
    known_speakers: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Transcribe an existing WAV payload against a single STT candidate."""
    candidate_provider = str(candidate.get("provider") or "unknown").strip() or "unknown"
    transport = str(candidate.get("transport") or "backend_http").strip().lower() or "backend_http"
    endpoint = _candidate_endpoint(candidate)
    started_at = time.perf_counter()

    runtime = RealtimeHttpSttSession(
        provider=candidate_provider,
        http_url=endpoint,
        sample_rate_hz=sample_rate_hz,
        timeout_seconds=max(5.0, float(timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS)),
        language=language,
        candidates=[candidate],
    )
    client = runtime._client
    should_close = False
    if not client:
        client = httpx.AsyncClient(timeout=max(5.0, float(timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS)))
        should_close = True

    try:
        text, segments, diarize_enabled = await runtime._transcribe_candidate(
            client,
            candidate,
            b"",
            wav_payload,
            known_speakers=known_speakers,
        )
        return {
            "ok": True,
            "provider": candidate_provider,
            "transport": transport,
            "route_id": str(candidate.get("route_id") or ""),
            "model": str(candidate.get("model") or "").strip() or None,
            "latency_ms": _elapsed_ms(started_at),
            "text": text,
            "segments": segments or [],
            "segments_count": len(segments) if segments else 0,
            "diarization_requested": diarize_enabled,
            "supports_diarization": bool(candidate.get("supports_diarization")),
            "degraded": bool(candidate.get("degraded")),
            "error": None,
            "status": "ready",
            "status_code": None,
        }
    except Exception as exc:
        error_info = _summarize_exception(exc)
        return {
            "ok": False,
            "provider": candidate_provider,
            "transport": transport,
            "route_id": str(candidate.get("route_id") or ""),
            "model": str(candidate.get("model") or "").strip() or None,
            "latency_ms": _elapsed_ms(started_at),
            "text": "",
            "segments": [],
            "segments_count": 0,
            "diarization_requested": bool(candidate.get("request_diarization", False)),
            "supports_diarization": bool(candidate.get("supports_diarization")),
            "degraded": bool(candidate.get("degraded")),
            "error": error_info["detail"],
            "status": error_info["error_type"],
            "status_code": error_info["status_code"],
        }
    finally:
        if should_close:
            await client.aclose()
        await runtime.close()

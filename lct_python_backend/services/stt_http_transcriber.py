"""Backend-owned realtime STT helpers for HTTP transcription providers."""

import base64
import io
import json
import logging
import os
import time
import wave
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger("lct_backend")

DEFAULT_SAMPLE_RATE_HZ = int(os.getenv("STT_SAMPLE_RATE_HZ", "16000"))
DEFAULT_HTTP_TIMEOUT_SECONDS = float(os.getenv("STT_HTTP_TIMEOUT_SECONDS", "30"))
DEFAULT_HTTP_CHUNK_SECONDS = float(os.getenv("STT_HTTP_CHUNK_SECONDS", "1.2"))
DEFAULT_HTTP_MODEL = os.getenv("STT_HTTP_MODEL", "")
DEFAULT_HTTP_LANGUAGE = os.getenv("STT_HTTP_LANGUAGE", "")
TRACE_API_CALLS = os.getenv("TRACE_API_CALLS", "true").strip().lower() in {"1", "true", "yes", "on"}
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))


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

    def is_ready(self) -> bool:
        return bool(str(self.http_url or "").strip())

    def _min_chunk_bytes(self) -> int:
        seconds = max(0.25, float(self.chunk_seconds or DEFAULT_HTTP_CHUNK_SECONDS))
        sample_width_bytes = 2  # int16
        return int(max(1.0, float(self.sample_rate_hz)) * sample_width_bytes * seconds)

    async def push_audio_chunk(self, pcm_bytes: bytes) -> Optional[Dict[str, Any]]:
        if not pcm_bytes:
            return None
        self._chunks_seen += 1
        self._buffer.extend(pcm_bytes)
        if len(self._buffer) < self._min_chunk_bytes():
            return None
        return await self._transcribe_buffer(is_final=False)

    async def flush(self) -> Optional[Dict[str, Any]]:
        if not self._buffer:
            return None
        return await self._transcribe_buffer(is_final=True)

    async def _transcribe_buffer(self, is_final: bool) -> Optional[Dict[str, Any]]:
        raw_pcm = bytes(self._buffer)
        self._buffer.clear()
        request_started_at = time.perf_counter()
        text = await self._transcribe_pcm(raw_pcm)
        stt_request_ms = _elapsed_ms(request_started_at)
        if not text:
            return None
        return {
            "text": text,
            "is_final": is_final,
            "metadata": {
                "provider": self.provider,
                "chunk_bytes": len(raw_pcm),
                "sample_rate_hz": self.sample_rate_hz,
                "chunks_seen": self._chunks_seen,
                "transport": "backend_http_stt",
                "stt_request_ms": stt_request_ms,
            },
        }

    async def _transcribe_pcm(self, pcm_bytes: bytes) -> str:
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

        files = {"file": ("chunk.wav", wav_payload, "audio/wav")}
        timeout_seconds = max(5.0, float(self.timeout_seconds or DEFAULT_HTTP_TIMEOUT_SECONDS))
        if TRACE_API_CALLS:
            logger.info(
                "[STT HTTP] POST %s provider=%s chunk_bytes=%s wav_bytes=%s model=%s language=%s",
                self.http_url,
                self.provider,
                len(pcm_bytes),
                len(wav_payload),
                model or "-",
                language or "-",
            )
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
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
            if TRACE_API_CALLS:
                logger.info(
                    "[STT HTTP] %s status=%s transcript_preview=%s",
                    self.http_url,
                    response.status_code,
                    _preview_text(text),
                )
            return text


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

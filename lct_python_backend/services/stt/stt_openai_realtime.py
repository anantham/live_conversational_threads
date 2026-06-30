"""OpenAI Realtime transcription runtime for low-latency live captions."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import numpy as np
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .stt_http_transcriber import pcm16le_to_wav

logger = logging.getLogger("lct_backend")

DEFAULT_OPENAI_REALTIME_BASE_URL = os.getenv(
    "OPENAI_REALTIME_WS_URL",
    "wss://api.openai.com/v1/realtime?intent=transcription",
).strip()
DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ = int(os.getenv("STT_OPENAI_REALTIME_SAMPLE_RATE_HZ", "24000"))
DEFAULT_OPENAI_REALTIME_FLUSH_WAIT_SECONDS = float(
    os.getenv("STT_OPENAI_REALTIME_FLUSH_WAIT_SECONDS", "1.5")
)
DEFAULT_OPENAI_REALTIME_CONNECT_TIMEOUT_SECONDS = float(
    os.getenv("STT_OPENAI_REALTIME_CONNECT_TIMEOUT_SECONDS", "15")
)
DEFAULT_OPENAI_REALTIME_VAD_THRESHOLD = float(os.getenv("STT_OPENAI_REALTIME_VAD_THRESHOLD", "0.5"))
DEFAULT_OPENAI_REALTIME_PREFIX_PADDING_MS = int(
    os.getenv("STT_OPENAI_REALTIME_PREFIX_PADDING_MS", "300")
)
DEFAULT_OPENAI_REALTIME_SILENCE_DURATION_MS = int(
    os.getenv("STT_OPENAI_REALTIME_SILENCE_DURATION_MS", "500")
)
# OpenAI's realtime API rejects an input_audio_buffer.commit carrying under
# 100ms of audio ("buffer too small ... buffer only has 0.00ms"). flush()
# skips the manual commit below this many bytes of uncommitted PCM.
# 100ms of pcm16 mono = sample_rate_hz * 2 bytes/sample * 0.1s.
OPENAI_REALTIME_MIN_COMMIT_BYTES = DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ * 2 // 10


def build_openai_realtime_ws_url(base_url: str) -> str:
    raw = str(base_url or "").strip() or DEFAULT_OPENAI_REALTIME_BASE_URL
    if raw.startswith("ws://") or raw.startswith("wss://"):
        return raw

    parsed = urlparse(raw)
    host = parsed.netloc or parsed.path or "api.openai.com"
    scheme = "wss" if parsed.scheme != "http" else "ws"
    return f"{scheme}://{host}/v1/realtime?intent=transcription"


def resample_pcm16_mono(pcm_bytes: bytes, input_rate_hz: int, output_rate_hz: int) -> bytes:
    if not pcm_bytes or input_rate_hz <= 0 or output_rate_hz <= 0:
        return b""
    if input_rate_hz == output_rate_hz:
        return pcm_bytes

    samples = np.frombuffer(pcm_bytes, dtype=np.int16)
    if samples.size == 0:
        return b""

    target_size = max(1, int(round(samples.size * float(output_rate_hz) / float(input_rate_hz))))
    source_positions = np.arange(samples.size, dtype=np.float32)
    target_positions = np.linspace(0.0, float(samples.size - 1), target_size, dtype=np.float32)
    resampled = np.interp(target_positions, source_positions, samples.astype(np.float32))
    return np.clip(np.round(resampled), -32768, 32767).astype(np.int16).tobytes()


@dataclass
class OpenAIRealtimeTranscriptionRuntime:
    provider: str
    api_key: str
    model: str
    base_url: str = ""
    sample_rate_hz: int = 16000
    timeout_seconds: float = DEFAULT_OPENAI_REALTIME_CONNECT_TIMEOUT_SECONDS
    language: str = ""
    session_id: str = ""
    conversation_id: str = ""
    stt_mode: str = field(default="openai_realtime", init=False)
    transport: str = field(default="openai_realtime", init=False)
    supports_diarization: bool = field(default=False, init=False)
    _socket: Any = field(default=None, init=False, repr=False)
    _receiver_task: Optional[asyncio.Task[Any]] = field(default=None, init=False, repr=False)
    _ready_event: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _startup_event: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _event_queue: asyncio.Queue[Dict[str, Any]] = field(default_factory=asyncio.Queue, init=False, repr=False)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _pending_commit_pcm: bytearray = field(default_factory=bytearray, init=False, repr=False)
    _pending_commit_start_sample: Optional[int] = field(default=None, init=False, repr=False)
    _provider_samples_sent: int = field(default=0, init=False, repr=False)
    _committed_pcm_by_item_id: Dict[str, bytes] = field(default_factory=dict, init=False, repr=False)
    _committed_window_by_item_id: Dict[str, Dict[str, float]] = field(default_factory=dict, init=False, repr=False)
    _partial_text_by_item_id: Dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _last_runtime_metadata: Dict[str, Any] = field(default_factory=dict, init=False)
    _startup_error: str = field(default="", init=False, repr=False)

    def __post_init__(self) -> None:
        self.api_key = str(self.api_key or "").strip()
        self.model = str(self.model or "").strip()
        self.base_url = build_openai_realtime_ws_url(self.base_url)
        self.sample_rate_hz = max(8000, int(self.sample_rate_hz or 16000))
        self.timeout_seconds = max(5.0, float(self.timeout_seconds or DEFAULT_OPENAI_REALTIME_CONNECT_TIMEOUT_SECONDS))

    def is_ready(self) -> bool:
        return bool(self.api_key and self.model and self._socket is not None and self._ready_event.is_set())

    def get_last_runtime_metadata(self) -> Dict[str, Any]:
        return dict(self._last_runtime_metadata)

    async def start(self) -> None:
        if self.is_ready():
            return
        if not self.api_key or not self.model:
            raise RuntimeError("OpenAI realtime STT requires an API key and model.")

        # Local-only guard: this dials a realtime STT websocket (default
        # wss://api.openai.com). Refuse non-local egress when LCT_LOCAL_ONLY is
        # on, before opening the socket. A local realtime endpoint still passes.
        from lct_python_backend.services.egress_guard import assert_local_egress
        assert_local_egress(self.base_url, purpose="OpenAI realtime STT websocket")
        # ADR-038 audio hard-gate: a voice cannot be redacted, so raw audio stays
        # local-only EVEN WHEN LCT_LOCAL_ONLY=0 (codex blocker 2). Cloud realtime
        # STT requires an explicit LCT_ALLOW_CLOUD_AUDIO=1 opt-in.
        from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
        assert_audio_egress_allowed(self.base_url, purpose="OpenAI realtime STT websocket")

        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            self._socket = await websockets.connect(
                self.base_url,
                additional_headers=headers,
                open_timeout=self.timeout_seconds,
                close_timeout=self.timeout_seconds,
                max_size=2**22,
            )
        except InvalidStatus as exc:
            detail = f"Realtime websocket auth failed: HTTP {getattr(exc, 'status_code', 'error')}"
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "error_type": "auth_failed",
                "detail": detail,
            }
            raise RuntimeError(detail) from exc
        except Exception as exc:  # noqa: BLE001
            detail = f"Failed to open OpenAI realtime STT websocket: {exc}"
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "error_type": "network_error",
                "detail": detail,
            }
            raise RuntimeError(detail) from exc

        self._receiver_task = asyncio.create_task(self._receiver_loop())
        self._startup_event.clear()
        self._startup_error = ""
        try:
            await self._send_json(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": {
                                    "type": "audio/pcm",
                                    "rate": DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
                                },
                                "noise_reduction": {"type": "near_field"},
                                "transcription": {
                                    "model": self.model,
                                    **({"language": self.language} if self.language else {}),
                                },
                                "turn_detection": {
                                    "type": "server_vad",
                                    "threshold": DEFAULT_OPENAI_REALTIME_VAD_THRESHOLD,
                                    "prefix_padding_ms": DEFAULT_OPENAI_REALTIME_PREFIX_PADDING_MS,
                                    "silence_duration_ms": DEFAULT_OPENAI_REALTIME_SILENCE_DURATION_MS,
                                },
                            }
                        },
                        "include": ["item.input_audio_transcription.logprobs"],
                    },
                }
            )
            await asyncio.wait_for(self._startup_event.wait(), timeout=self.timeout_seconds)
            if self._startup_error:
                raise RuntimeError(self._startup_error)
        except asyncio.TimeoutError as exc:
            detail = "Timed out waiting for OpenAI realtime STT session.updated."
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "error_type": "timeout",
                "detail": detail,
            }
            await self.close()
            raise RuntimeError(detail) from exc
        except Exception as exc:  # noqa: BLE001
            detail = str(exc).strip() or f"Failed to initialize OpenAI realtime STT session: {exc}"
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "error_type": "provider_error",
                "detail": detail,
            }
            await self.close()
            raise RuntimeError(detail) from exc

    async def push_audio_chunk(self, pcm_bytes: bytes) -> List[Dict[str, Any]]:
        if not pcm_bytes:
            return self._drain_events_nowait()
        if not self.is_ready():
            await self.start()
        resampled_pcm = resample_pcm16_mono(
            pcm_bytes,
            input_rate_hz=self.sample_rate_hz,
            output_rate_hz=DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
        )
        if not resampled_pcm:
            return self._drain_events_nowait()
        if self._pending_commit_start_sample is None:
            self._pending_commit_start_sample = self._provider_samples_sent
        self._pending_commit_pcm.extend(resampled_pcm)
        self._provider_samples_sent += len(resampled_pcm) // 2
        await self._send_json(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(resampled_pcm).decode("ascii"),
            }
        )
        self._last_runtime_metadata = {
            "provider": self.provider,
            "transport": self.transport,
            "model": self.model,
            "chunk_bytes": len(pcm_bytes),
            "resampled_chunk_bytes": len(resampled_pcm),
            "input_sample_rate_hz": self.sample_rate_hz,
            "provider_sample_rate_hz": DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
        }
        return self._drain_events_nowait()

    async def flush(self) -> List[Dict[str, Any]]:
        if not self.is_ready():
            logger.warning("[OPENAI][REALTIME] session=%s flush called but not ready", self.session_id)
            return []

        # Server-side VAD (turn_detection in session.update) already
        # auto-commits the input buffer on every detected silence. A manual
        # commit here only finalizes a trailing utterance that didn't end on
        # a silence. OpenAI rejects a commit carrying under 100ms of audio
        # ("buffer too small ... only has 0.00ms"), so commit only when at
        # least that much uncommitted audio is pending — otherwise the
        # sub-100ms (sub-syllable) tail is dropped, which is inaudible.
        pending_bytes = len(self._pending_commit_pcm)
        logger.info(
            "[OPENAI][REALTIME] session=%s flush: pending_bytes=%s provider_samples_sent=%s",
            self.session_id, pending_bytes, self._provider_samples_sent,
        )
        if pending_bytes >= OPENAI_REALTIME_MIN_COMMIT_BYTES:
            logger.info("[OPENAI][REALTIME] session=%s committing input_audio_buffer.commit", self.session_id)
            await self._send_json({"type": "input_audio_buffer.commit"})
        elif pending_bytes > 0:
            logger.debug(
                "[OPENAI][REALTIME] session=%s flush: skipping commit — %s bytes (<100ms) trailing audio",
                self.session_id, pending_bytes,
            )

        events = self._drain_events_nowait()
        deadline = time.monotonic() + max(0.25, DEFAULT_OPENAI_REALTIME_FLUSH_WAIT_SECONDS)
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                next_event = await asyncio.wait_for(
                    self._event_queue.get(),
                    timeout=min(0.25, remaining),
                )
            except asyncio.TimeoutError:
                if events:
                    break
                continue
            events.append(next_event)
            if next_event.get("event_type") == "final":
                break
        events.extend(self._drain_events_nowait())
        return events

    async def close(self) -> None:
        if self._receiver_task:
            self._receiver_task.cancel()
            await asyncio.gather(self._receiver_task, return_exceptions=True)
            self._receiver_task = None
        if self._socket is not None:
            try:
                await self._socket.close()
            except Exception:  # noqa: BLE001
                pass
            self._socket = None
        self._ready_event.clear()
        self._startup_event.clear()
        self._startup_error = ""
        self._pending_commit_start_sample = None
        self._provider_samples_sent = 0
        self._committed_window_by_item_id.clear()

    async def _send_json(self, payload: Dict[str, Any]) -> None:
        if self._socket is None:
            raise RuntimeError("Realtime websocket is not connected.")
        async with self._send_lock:
            await self._socket.send(json.dumps(payload))

    def _drain_events_nowait(self) -> List[Dict[str, Any]]:
        drained: List[Dict[str, Any]] = []
        while True:
            try:
                drained.append(self._event_queue.get_nowait())
            except asyncio.QueueEmpty:
                return drained

    async def _receiver_loop(self) -> None:
        try:
            async for raw_message in self._socket:
                try:
                    payload = json.loads(raw_message)
                except json.JSONDecodeError:
                    logger.debug("[STT OpenAI Realtime] Ignoring non-JSON message: %s", raw_message)
                    continue
                await self._handle_server_event(payload)
        except asyncio.CancelledError:
            raise
        except ConnectionClosed as exc:
            await self._event_queue.put(
                {
                    "event_type": "error",
                    "detail": f"OpenAI realtime STT websocket closed: {exc}",
                    "metadata": self._base_metadata(),
                }
            )
        except Exception as exc:  # noqa: BLE001
            await self._event_queue.put(
                {
                    "event_type": "error",
                    "detail": f"OpenAI realtime STT receive loop failed: {exc}",
                    "metadata": self._base_metadata(),
                }
            )

    async def _handle_server_event(self, payload: Dict[str, Any]) -> None:
        event_type = str(payload.get("type") or "").strip()
        if event_type == "session.updated":
            self._ready_event.set()
            self._startup_error = ""
            self._startup_event.set()
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "model": self.model,
                "session_updated": True,
            }
            logger.info(
                "[STT OpenAI Realtime] session=%s conversation=%s session.updated model=%s",
                self.session_id or "-",
                self.conversation_id or "-",
                self.model,
            )
            return

        if event_type == "input_audio_buffer.committed":
            item_id = str(payload.get("item_id") or "").strip()
            if item_id:
                self._committed_pcm_by_item_id[item_id] = bytes(self._pending_commit_pcm)
                if self._pending_commit_start_sample is not None:
                    committed_duration_samples = len(self._pending_commit_pcm) // 2
                    start_seconds = self._pending_commit_start_sample / float(DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ)
                    end_seconds = (
                        self._pending_commit_start_sample + committed_duration_samples
                    ) / float(DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ)
                    self._committed_window_by_item_id[item_id] = {
                        "start": round(start_seconds, 6),
                        "end": round(end_seconds, 6),
                    }
                self._pending_commit_pcm.clear()
                self._pending_commit_start_sample = None
            return

        if event_type == "conversation.item.input_audio_transcription.delta":
            item_id = str(payload.get("item_id") or "").strip()
            delta = str(payload.get("delta") or "")
            logprobs = payload.get("logprobs")
            if not item_id or not delta:
                return
            next_text = f"{self._partial_text_by_item_id.get(item_id, '')}{delta}"
            self._partial_text_by_item_id[item_id] = next_text
            await self._event_queue.put(
                {
                    "event_type": "partial",
                    "text": next_text.strip(),
                    "metadata": {
                        **self._base_metadata(),
                        "item_id": item_id,
                        "provider_event_type": event_type,
                        "logprobs": logprobs,
                    },
                }
            )
            return

        if event_type == "conversation.item.input_audio_transcription.completed":
            item_id = str(payload.get("item_id") or "").strip()
            transcript = str(payload.get("transcript") or "").strip()
            logprobs = payload.get("logprobs")
            wav_pcm = self._committed_pcm_by_item_id.pop(item_id, b"")
            window_timestamps = self._committed_window_by_item_id.pop(item_id, None)
            wav_payload = (
                pcm16le_to_wav(
                    wav_pcm,
                    sample_rate_hz=DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
                )
                if wav_pcm
                else None
            )
            self._partial_text_by_item_id.pop(item_id, None)
            await self._event_queue.put(
                {
                    "event_type": "final",
                    "text": transcript,
                    "metadata": {
                        **self._base_metadata(),
                        "item_id": item_id,
                        "provider_event_type": event_type,
                        "sample_rate_hz": DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
                        "logprobs": logprobs,
                    },
                    "timestamps": window_timestamps or {},
                    "_wav_payload": wav_payload,
                }
            )
            return

        if event_type in {
            "conversation.item.input_audio_transcription.failed",
            "error",
        }:
            error_payload = payload.get("error")
            detail = ""
            if isinstance(error_payload, dict):
                detail = str(
                    error_payload.get("message")
                    or error_payload.get("type")
                    or error_payload
                ).strip()
            if not detail:
                detail = str(payload.get("message") or payload or "Unknown realtime transcription error").strip()
            if not self._ready_event.is_set():
                self._startup_error = detail
                self._startup_event.set()
                return
            await self._event_queue.put(
                {
                    "event_type": "error",
                    "detail": detail,
                    "metadata": {
                        **self._base_metadata(),
                        "provider_event_type": event_type,
                    },
                }
            )
            return

        if event_type in {"input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped"}:
            await self._event_queue.put(
                {
                    "event_type": "status",
                    "message": event_type,
                    "metadata": {
                        **self._base_metadata(),
                        "provider_event_type": event_type,
                        "item_id": str(payload.get("item_id") or "").strip() or None,
                    },
                }
            )

    def _base_metadata(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "transport": self.transport,
            "model": self.model,
            "provider_sample_rate_hz": DEFAULT_OPENAI_REALTIME_SAMPLE_RATE_HZ,
        }

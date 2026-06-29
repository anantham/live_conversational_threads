"""Backend websocket transcription runtime for orchestrated realtime STT."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import websockets
from websockets.exceptions import ConnectionClosed

from .stt_openai_realtime import resample_pcm16_mono

logger = logging.getLogger("lct_backend")

DEFAULT_BACKEND_REALTIME_CONNECT_TIMEOUT_SECONDS = float(
    os.getenv("STT_BACKEND_REALTIME_CONNECT_TIMEOUT_SECONDS", "15")
)
DEFAULT_BACKEND_REALTIME_FLUSH_WAIT_SECONDS = float(
    os.getenv("STT_BACKEND_REALTIME_FLUSH_WAIT_SECONDS", "1.5")
)
DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ = int(
    os.getenv("STT_BACKEND_REALTIME_SAMPLE_RATE_HZ", "16000")
)


@dataclass
class BackendRealtimeTranscriptionRuntime:
    provider: str
    ws_url: str
    model: str = ""
    sample_rate_hz: int = DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ
    timeout_seconds: float = DEFAULT_BACKEND_REALTIME_CONNECT_TIMEOUT_SECONDS
    language: str = ""
    session_id: str = ""
    conversation_id: str = ""
    stt_mode: str = field(default="backend_ws", init=False)
    transport: str = field(default="backend_ws", init=False)
    supports_diarization: bool = field(default=False, init=False)
    _socket: Any = field(default=None, init=False, repr=False)
    _receiver_task: Optional[asyncio.Task[Any]] = field(default=None, init=False, repr=False)
    _ready_event: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _startup_event: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _event_queue: asyncio.Queue[Dict[str, Any]] = field(default_factory=asyncio.Queue, init=False, repr=False)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _last_runtime_metadata: Dict[str, Any] = field(default_factory=dict, init=False)
    _startup_error: str = field(default="", init=False, repr=False)

    def __post_init__(self) -> None:
        self.ws_url = str(self.ws_url or "").strip()
        self.model = str(self.model or "").strip()
        self.sample_rate_hz = max(8000, int(self.sample_rate_hz or DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ))
        self.timeout_seconds = max(
            5.0,
            float(self.timeout_seconds or DEFAULT_BACKEND_REALTIME_CONNECT_TIMEOUT_SECONDS),
        )

    def is_ready(self) -> bool:
        return bool(self.ws_url and self._socket is not None and self._ready_event.is_set())

    def get_last_runtime_metadata(self) -> Dict[str, Any]:
        return dict(self._last_runtime_metadata)

    async def start(self) -> None:
        if self.is_ready():
            return
        if not self.ws_url:
            raise RuntimeError("Backend realtime STT requires a websocket URL.")

        try:
            self._socket = await websockets.connect(
                self.ws_url,
                open_timeout=self.timeout_seconds,
                close_timeout=self.timeout_seconds,
                max_size=2**22,
            )
        except Exception as exc:  # noqa: BLE001
            detail = f"Failed to open backend realtime STT websocket: {exc}"
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
            await asyncio.wait_for(self._startup_event.wait(), timeout=self.timeout_seconds)
            if self._startup_error:
                raise RuntimeError(self._startup_error)
            if self.language:
                await self._send_json({"type": "config", "language": self.language})
        except asyncio.TimeoutError as exc:
            detail = "Timed out waiting for backend realtime STT ready event."
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "error_type": "timeout",
                "detail": detail,
            }
            await self.close()
            raise RuntimeError(detail) from exc
        except Exception as exc:  # noqa: BLE001
            detail = str(exc).strip() or f"Failed to initialize backend realtime STT session: {exc}"
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
        outbound_pcm = resample_pcm16_mono(
            pcm_bytes,
            input_rate_hz=self.sample_rate_hz,
            output_rate_hz=DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ,
        )
        if not outbound_pcm:
            return self._drain_events_nowait()
        await self._send_bytes(outbound_pcm)
        self._last_runtime_metadata = {
            "provider": self.provider,
            "transport": self.transport,
            "model": self.model,
            "chunk_bytes": len(pcm_bytes),
            "resampled_chunk_bytes": len(outbound_pcm),
            "input_sample_rate_hz": self.sample_rate_hz,
            "provider_sample_rate_hz": DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ,
        }
        return self._drain_events_nowait()

    async def flush(self) -> List[Dict[str, Any]]:
        if not self.is_ready():
            return []

        await self._send_json({"type": "end"})
        events = self._drain_events_nowait()
        saw_final = any(event.get("event_type") == "final" for event in events)
        saw_done = any(event.get("event_type") == "status" and event.get("message") == "done" for event in events)
        deadline = time.monotonic() + max(0.25, DEFAULT_BACKEND_REALTIME_FLUSH_WAIT_SECONDS)
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                next_event = await asyncio.wait_for(
                    self._event_queue.get(),
                    timeout=min(0.25, remaining),
                )
            except asyncio.TimeoutError:
                continue
            events.append(next_event)
            if next_event.get("event_type") == "final":
                saw_final = True
                break
            if next_event.get("event_type") == "status" and next_event.get("message") == "done":
                saw_done = True
                break
        events.extend(self._drain_events_nowait())
        if not saw_final:
            if not saw_done:
                saw_done = any(event.get("event_type") == "status" and event.get("message") == "done" for event in events)
            if saw_done:
                self._promote_last_partial_to_final(events)
        return events

    @staticmethod
    def _promote_last_partial_to_final(events: List[Dict[str, Any]]) -> None:
        for event in reversed(events):
            if event.get("event_type") == "partial" and str(event.get("text") or "").strip():
                event["event_type"] = "final"
                metadata = dict(event.get("metadata") or {})
                metadata["promoted_from_partial"] = True
                event["metadata"] = metadata
                return

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

    async def _send_json(self, payload: Dict[str, Any]) -> None:
        if self._socket is None:
            raise RuntimeError("Backend realtime websocket is not connected.")
        async with self._send_lock:
            await self._socket.send(json.dumps(payload))

    async def _send_bytes(self, payload: bytes) -> None:
        if self._socket is None:
            raise RuntimeError("Backend realtime websocket is not connected.")
        async with self._send_lock:
            await self._socket.send(payload)

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
                    logger.debug("[STT Backend Realtime] Ignoring non-JSON message: %s", raw_message)
                    continue
                await self._handle_server_event(payload)
        except asyncio.CancelledError:
            raise
        except ConnectionClosed as exc:
            await self._event_queue.put(
                {
                    "event_type": "error",
                    "detail": f"Backend realtime STT websocket closed: {exc}",
                    "metadata": self._base_metadata(),
                }
            )
        except Exception as exc:  # noqa: BLE001
            await self._event_queue.put(
                {
                    "event_type": "error",
                    "detail": f"Backend realtime STT receive loop failed: {exc}",
                    "metadata": self._base_metadata(),
                }
            )

    async def _handle_server_event(self, payload: Dict[str, Any]) -> None:
        message_type = str(payload.get("type") or "").strip()
        if message_type == "ready":
            self._ready_event.set()
            self._startup_error = ""
            self._startup_event.set()
            self.model = str(payload.get("model") or self.model or "").strip()
            provider_sample_rate = int(payload.get("sample_rate") or DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ)
            self._last_runtime_metadata = {
                "provider": self.provider,
                "transport": self.transport,
                "model": self.model,
                "provider_sample_rate_hz": provider_sample_rate,
                "chunk_seconds": payload.get("chunk_seconds"),
            }
            logger.info(
                "[STT Backend Realtime] session=%s conversation=%s ready model=%s sample_rate=%s",
                self.session_id or "-",
                self.conversation_id or "-",
                self.model or "-",
                provider_sample_rate,
            )
            return

        if message_type == "config_ack":
            await self._event_queue.put(
                {
                    "event_type": "status",
                    "message": "config_ack",
                    "metadata": {
                        **self._base_metadata(),
                        "language": str(payload.get("language") or "").strip() or None,
                    },
                }
            )
            return

        if message_type == "transcript":
            text = str(payload.get("text") or "").strip()
            if not text:
                return
            await self._event_queue.put(
                {
                    "event_type": "final" if bool(payload.get("is_final")) else "partial",
                    "text": text,
                    "metadata": {
                        **self._base_metadata(),
                        "language": str(payload.get("language") or self.language or "").strip() or None,
                        "sample_rate_hz": DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ,
                    },
                }
            )
            return

        if message_type == "done":
            await self._event_queue.put(
                {
                    "event_type": "status",
                    "message": "done",
                    "metadata": self._base_metadata(),
                }
            )
            return

        if message_type == "keepalive":
            return

        if message_type == "error":
            detail = str(payload.get("message") or "Realtime STT provider error").strip()
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
                        "provider_event_type": message_type,
                        "error_type": str(payload.get("error_type") or "provider_error"),
                    },
                }
            )

    def _base_metadata(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "transport": self.transport,
            "model": self.model,
            "provider_sample_rate_hz": DEFAULT_BACKEND_REALTIME_SAMPLE_RATE_HZ,
        }

"""Per-connection WebSocket session context for the STT transcript handler.

Extracts all mutable per-connection state and nested closures from
``stt_api.transcripts_websocket`` into a single class, making the WS handler
a thin one-liner: ``await WsSessionContext(...).run()``.

No public API change — the router in ``stt_api.py`` is the only caller.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.stt_http_transcriber import RealtimeHttpSttSession, decode_audio_base64
from lct_python_backend.services.stt_session import SessionState, persist_transcript_event
from lct_python_backend.services.stt_ws_helpers import (
    build_telemetry_metadata as _build_telemetry_metadata,
    coerce_latency_ms as _coerce_latency_ms,
    elapsed_ms as _elapsed_ms,
    normalize_provider as _normalize_provider,
    now_ms as _now_ms,
    safe_float as _safe_float,
    safe_int as _safe_int,
    safe_send_json as _safe_send_json,
    send_processor_update as _send_processor_update_helper,
    should_emit_final_segment as _should_emit_final_segment,
    ws_is_connected as _ws_is_connected,
)
from lct_python_backend.services.transcript_processing import TranscriptProcessor

logger = logging.getLogger("lct_backend")


class WsSessionContext:
    """Holds all per-connection state and orchestrates the WS message loop.

    Args:
        websocket:            Accepted FastAPI WebSocket.
        session:              AsyncSession scoped to this connection.
        audio_storage:        Module-level AudioStorageManager instance.
        llm_config:           Pre-loaded LLM config dict (avoids re-loading per message).
        load_stt_settings_fn: Async callable ``(session) -> dict`` — passed in to keep
                              the class free of global state and testable.
        download_token:       Optional token for audio download URLs (from env).
    """

    def __init__(
        self,
        *,
        websocket: WebSocket,
        session,
        audio_storage: AudioStorageManager,
        llm_config: Dict[str, Any],
        load_stt_settings_fn,
        download_token: Optional[str] = None,
    ) -> None:
        self.websocket = websocket
        self.session = session
        self.audio_storage = audio_storage
        self.download_token = download_token
        self._load_stt_settings = load_stt_settings_fn

        # Session state
        self.state = SessionState(metadata={})
        self.stt_runtime: Optional[RealtimeHttpSttSession] = None
        self.pending_partial_parts: List[str] = []
        self.pending_partial_chars: int = 0
        self.pending_speaker_segments: List[Dict[str, Any]] = []
        self.stt_unready_notified: bool = False
        self.stt_flush_requested: bool = False
        self.telemetry_state: Dict[str, Optional[int]] = {
            "audio_send_started_at_ms": None,
            "first_partial_at_ms": None,
            "first_final_at_ms": None,
        }

        # Task tracking
        self.background_tasks: set = set()
        self.pending_processor_final_tasks: set = set()
        self.pending_stt_chunk_tasks: set = set()

        # Locks
        self.processor_lock = asyncio.Lock()
        self.stt_stream_lock = asyncio.Lock()

        # Processor wired to self's callbacks
        self.processor = TranscriptProcessor(
            send_update=self._processor_update,
            send_status=self._processor_status,
            llm_config=llm_config,
        )

    # ------------------------------------------------------------------
    # Task tracking helpers
    # ------------------------------------------------------------------

    def _track_background_task(self, task: "asyncio.Task[Any]") -> None:
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

    def _track_processor_final_task(self, task: "asyncio.Task[Any]") -> None:
        self.pending_processor_final_tasks.add(task)
        self.background_tasks.add(task)
        task.add_done_callback(self.pending_processor_final_tasks.discard)
        task.add_done_callback(self.background_tasks.discard)

    def _track_stt_chunk_task(self, task: "asyncio.Task[Any]") -> None:
        self.pending_stt_chunk_tasks.add(task)
        self.background_tasks.add(task)
        task.add_done_callback(self.pending_stt_chunk_tasks.discard)
        task.add_done_callback(self.background_tasks.discard)

    # ------------------------------------------------------------------
    # Processor callbacks
    # ------------------------------------------------------------------

    async def _processor_update(self, existing_json, chunk_dict) -> None:
        await _send_processor_update_helper(self.websocket, existing_json, chunk_dict, logger)

    async def _processor_status(self, level: str, message: str, context: Dict[str, Any]) -> None:
        await _safe_send_json(
            self.websocket,
            {
                "type": "processing_status",
                "level": str(level or "info"),
                "message": str(message or ""),
                "context": context or {},
            },
        )

    # ------------------------------------------------------------------
    # Internal processor helpers
    # ------------------------------------------------------------------

    async def _processor_handle_final_text(
        self,
        text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if speaker_segments:
            try:
                await self.processor.handle_final_text(text, speaker_segments=speaker_segments)
                return
            except TypeError as exc:
                if "speaker_segments" not in str(exc):
                    raise
                logger.debug(
                    "[WS] Processor handle_final_text does not accept speaker_segments; retrying without labels."
                )
        await self.processor.handle_final_text(text)

    async def _run_processor_final(
        self,
        text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        try:
            async with self.processor_lock:
                await self._processor_handle_final_text(text, speaker_segments=speaker_segments)
        except Exception as exc:
            logger.exception("[WS] Final transcript processing failed: %s", exc)
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "error",
                    "message": "Failed to process final transcript into graph data.",
                    "context": {"error": str(exc), "stage": "handle_final_text"},
                },
            )

    # ------------------------------------------------------------------
    # Event persistence
    # ------------------------------------------------------------------

    async def _persist_event(
        self,
        event_type: str,
        text: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
        timestamps: Optional[Dict[str, Any]] = None,
        emit_to_client: bool = False,
        process_final: bool = True,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        normalized_text = str(text or "").strip()
        if not normalized_text:
            return

        event_metadata = dict(metadata or {})
        raw_stage_metrics = (
            event_metadata.get("telemetry")
            if isinstance(event_metadata.get("telemetry"), dict)
            else {}
        )
        event_metadata["telemetry"] = _build_telemetry_metadata(
            self.telemetry_state,
            event_type,
            raw_stage_metrics,
        )
        event_metadata.setdefault("provider", self.state.provider or "parakeet")

        payload = {
            "text": normalized_text,
            "metadata": event_metadata,
            "timestamps": timestamps or {},
            "speaker_id": self.state.speaker_id,
        }
        await persist_transcript_event(self.session, self.state, payload, event_type, normalized_text)
        await self.session.commit()

        if event_type == "final" and process_final:
            self._track_processor_final_task(
                asyncio.create_task(
                    self._run_processor_final(normalized_text, speaker_segments=speaker_segments)
                )
            )

        if emit_to_client:
            await _safe_send_json(
                self.websocket,
                {
                    "type": f"transcript_{event_type}",
                    "text": normalized_text,
                    "metadata": event_metadata,
                    "timestamps": payload["timestamps"],
                },
            )

    # ------------------------------------------------------------------
    # Audio chunk processing
    # ------------------------------------------------------------------

    async def _process_audio_chunk(self, chunk_bytes: bytes, audio_decode_ms: float) -> None:
        if not chunk_bytes:
            return

        if self.state.store_audio and self.state.conversation_id:
            await self.audio_storage.append_chunk(self.state.conversation_id, chunk_bytes)

        if not self.stt_runtime or not self.stt_runtime.is_ready():
            if not self.stt_unready_notified:
                self.stt_unready_notified = True
                await _safe_send_json(
                    self.websocket,
                    {
                        "type": "stt_provider_error",
                        "detail": (
                            f"No STT HTTP URL configured for provider '{self.state.provider}'. "
                            "Set provider HTTP URL in Settings."
                        ),
                    },
                )
            return

        async with self.stt_stream_lock:
            try:
                partial_result = await self.stt_runtime.push_audio_chunk(chunk_bytes)
            except Exception as exc:
                logger.warning("STT provider request failed: %s", exc)
                await _safe_send_json(
                    self.websocket,
                    {
                        "type": "stt_provider_error",
                        "detail": f"STT provider request failed: {exc}",
                    },
                )
                return

            if not partial_result or not partial_result.get("text"):
                return

            partial_text = str(partial_result.get("text") or "").strip()
            if not partial_text:
                return

            partial_metadata = (
                partial_result.get("metadata")
                if isinstance(partial_result.get("metadata"), dict)
                else {}
            )
            telemetry_overrides: Dict[str, Any] = {}
            decoded_ms = _coerce_latency_ms(audio_decode_ms)
            if decoded_ms is not None:
                telemetry_overrides["audio_decode_ms"] = decoded_ms
            stt_request_ms = _coerce_latency_ms(partial_metadata.get("stt_request_ms"))
            if stt_request_ms is not None:
                telemetry_overrides["stt_request_ms"] = stt_request_ms
            if telemetry_overrides:
                existing_telemetry = (
                    partial_metadata.get("telemetry")
                    if isinstance(partial_metadata.get("telemetry"), dict)
                    else {}
                )
                partial_metadata["telemetry"] = {**existing_telemetry, **telemetry_overrides}

            await self._persist_event(
                "partial",
                partial_text,
                metadata=partial_metadata,
                emit_to_client=True,
            )
            self.pending_partial_parts.append(partial_text)
            self.pending_partial_chars += len(partial_text)

            chunk_segments = partial_result.get("segments")
            if isinstance(chunk_segments, list):
                self.pending_speaker_segments.extend(chunk_segments)

            if _should_emit_final_segment(
                partial_text,
                self.pending_partial_parts,
                self.pending_partial_chars,
            ):
                final_text = " ".join(self.pending_partial_parts).strip()
                final_segments = self.pending_speaker_segments if self.pending_speaker_segments else None
                await self._persist_event(
                    "final",
                    final_text,
                    metadata={
                        **partial_metadata,
                        "aggregated_parts": len(self.pending_partial_parts),
                        "transport": "backend_http_stt",
                    },
                    emit_to_client=True,
                    speaker_segments=final_segments,
                )
                self.pending_partial_parts = []
                self.pending_partial_chars = 0
                self.pending_speaker_segments = []

    # ------------------------------------------------------------------
    # Post-flush background processing
    # ------------------------------------------------------------------

    async def _run_post_flush_processing(self) -> None:
        try:
            if self.pending_stt_chunk_tasks:
                await asyncio.gather(
                    *list(self.pending_stt_chunk_tasks),
                    return_exceptions=True,
                )

            flush_final_metadata: Dict[str, Any] = {}
            final_text_for_post_flush: Optional[str] = None
            final_segments_for_post_flush: Optional[List[Dict[str, Any]]] = None

            if self.stt_runtime and self.stt_runtime.is_ready():
                async with self.stt_stream_lock:
                    stt_flush_started_at = time.perf_counter()
                    try:
                        final_result = await self.stt_runtime.flush()
                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                    except Exception as exc:
                        logger.warning("STT provider flush failed: %s", exc)
                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                        await _safe_send_json(
                            self.websocket,
                            {"type": "stt_provider_error", "detail": f"STT flush failed: {exc}"},
                        )
                        final_result = None

                    if final_result and final_result.get("text"):
                        final_text_piece = str(final_result.get("text") or "").strip()
                        if final_text_piece:
                            flush_final_metadata = (
                                final_result.get("metadata")
                                if isinstance(final_result.get("metadata"), dict)
                                else {}
                            )
                            stt_request_ms = _coerce_latency_ms(flush_final_metadata.get("stt_request_ms"))
                            telemetry_overrides: Dict[str, Any] = {}
                            if stt_request_ms is not None:
                                telemetry_overrides["stt_request_ms"] = stt_request_ms
                            normalized_flush_ms = _coerce_latency_ms(stt_flush_ms)
                            if normalized_flush_ms is not None:
                                telemetry_overrides["stt_flush_request_ms"] = normalized_flush_ms
                            if telemetry_overrides:
                                existing_telemetry = (
                                    flush_final_metadata.get("telemetry")
                                    if isinstance(flush_final_metadata.get("telemetry"), dict)
                                    else {}
                                )
                                flush_final_metadata["telemetry"] = {
                                    **existing_telemetry,
                                    **telemetry_overrides,
                                }
                            self.pending_partial_parts.append(final_text_piece)
                            self.pending_partial_chars += len(final_text_piece)
                            flush_segments = final_result.get("segments")
                            if isinstance(flush_segments, list):
                                self.pending_speaker_segments.extend(flush_segments)

            if self.pending_partial_parts:
                final_text = " ".join(self.pending_partial_parts).strip()
                flush_speaker_segments = (
                    self.pending_speaker_segments if self.pending_speaker_segments else None
                )
                final_event_metadata: Dict[str, Any] = {
                    **flush_final_metadata,
                    "aggregated_parts": len(self.pending_partial_parts),
                    "transport": "backend_http_stt",
                }
                await self._persist_event(
                    "final",
                    final_text,
                    metadata=final_event_metadata,
                    emit_to_client=True,
                    process_final=False,
                    speaker_segments=flush_speaker_segments,
                )
                final_text_for_post_flush = final_text
                final_segments_for_post_flush = flush_speaker_segments
                self.pending_partial_parts = []
                self.pending_partial_chars = 0
                self.pending_speaker_segments = []

            if self.state.store_audio and self.state.conversation_id:
                finalized = await self.audio_storage.finalize(self.state.conversation_id)
                audio_ready_payload: Dict[str, Any] = {
                    "type": "audio_ready",
                    "audio_paths": finalized,
                }
                if finalized.get("wav_path") and self.download_token:
                    audio_ready_payload["download_url"] = (
                        f"/api/conversations/{self.state.conversation_id}/audio?token={self.download_token}"
                    )
                await _safe_send_json(self.websocket, audio_ready_payload)

            if self.pending_processor_final_tasks:
                await asyncio.gather(
                    *list(self.pending_processor_final_tasks),
                    return_exceptions=True,
                )
            async with self.processor_lock:
                if final_text_for_post_flush:
                    await self._processor_handle_final_text(
                        final_text_for_post_flush,
                        speaker_segments=final_segments_for_post_flush,
                    )
                await self.processor.flush()

        except Exception as exc:
            logger.exception("[WS] Processor flush failed: %s", exc)
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "error",
                    "message": "Final flush failed while generating graph updates.",
                    "context": {"error": str(exc), "stage": "flush"},
                },
            )

    # ------------------------------------------------------------------
    # Message handlers
    # ------------------------------------------------------------------

    async def handle_session_meta(self, payload: Dict[str, Any]) -> None:
        """Handle ``session_meta`` message — (re-)initialise per-session state."""
        self.stt_flush_requested = False
        if self.pending_stt_chunk_tasks:
            for task in list(self.pending_stt_chunk_tasks):
                task.cancel()
            await asyncio.gather(*list(self.pending_stt_chunk_tasks), return_exceptions=True)
        self.pending_partial_parts = []
        self.pending_partial_chars = 0
        self.pending_speaker_segments = []
        self.stt_unready_notified = False
        self.telemetry_state = {
            "audio_send_started_at_ms": None,
            "first_partial_at_ms": None,
            "first_final_at_ms": None,
        }

        conversation_id = payload.get("conversation_id")
        if not conversation_id:
            await self.websocket.send_json({"type": "error", "detail": "Missing conversation_id"})
            return

        stt_settings: Dict[str, Any] = {}
        try:
            stt_settings = await self._load_stt_settings(self.session)
        except Exception as exc:
            logger.warning("Unable to load STT settings during session setup: %s", exc)

        normalized_provider = _normalize_provider(
            payload.get("provider"),
            stt_settings.get("provider"),
        )
        provider_http_urls = (
            stt_settings.get("provider_http_urls")
            if isinstance(stt_settings.get("provider_http_urls"), dict)
            else {}
        )
        provider_http_url = str(
            payload.get("provider_http_url")
            or provider_http_urls.get(normalized_provider)
            or stt_settings.get("http_url")
            or ""
        ).strip()

        self.state.conversation_id = conversation_id
        self.state.session_id = payload.get("session_id") or str(uuid.uuid4())
        self.state.provider = normalized_provider
        default_store_audio = bool(stt_settings.get("store_audio"))
        self.state.store_audio = bool(payload.get("store_audio", default_store_audio))
        self.state.speaker_id = payload.get("speaker_id", self.state.speaker_id)
        self.state.metadata = payload.get("metadata") or {}

        self.stt_runtime = RealtimeHttpSttSession(
            provider=normalized_provider,
            http_url=provider_http_url,
            sample_rate_hz=_safe_int(
                payload.get("sample_rate_hz") or stt_settings.get("sample_rate_hz"),
                16000,
            ),
            chunk_seconds=_safe_float(
                payload.get("http_chunk_seconds") or stt_settings.get("http_chunk_seconds"),
                1.2,
            ),
            timeout_seconds=_safe_float(stt_settings.get("http_timeout_seconds"), 30.0),
            model=str(stt_settings.get("http_model") or ""),
            language=str(stt_settings.get("http_language") or ""),
        )

        await self.websocket.send_json({
            "type": "session_ack",
            "conversation_id": conversation_id,
            "session_id": self.state.session_id,
            "store_audio": self.state.store_audio,
            "provider": normalized_provider,
            "provider_http_url": provider_http_url or None,
            "stt_mode": "backend_http",
            "stt_ready": bool(self.stt_runtime.is_ready()),
        })

    async def handle_audio_chunk(self, payload: Dict[str, Any]) -> None:
        """Handle ``audio_chunk`` message."""
        if not self.state.conversation_id:
            await self.websocket.send_json({"type": "error", "detail": "session_meta must be sent first"})
            return

        if self.stt_flush_requested:
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "warning",
                    "message": "Ignoring audio chunk after final_flush request.",
                    "context": {"stage": "audio_chunk"},
                },
            )
            return

        if self.telemetry_state.get("audio_send_started_at_ms") is None:
            self.telemetry_state["audio_send_started_at_ms"] = _now_ms()

        decode_started_at = time.perf_counter()
        try:
            chunk_bytes = decode_audio_base64(
                payload.get("audio_base64") or payload.get("audio_b64")
            )
        except ValueError as exc:
            await self.websocket.send_json({"type": "error", "detail": str(exc)})
            return

        audio_decode_ms = _elapsed_ms(decode_started_at)
        if not chunk_bytes:
            return

        self._track_stt_chunk_task(
            asyncio.create_task(self._process_audio_chunk(chunk_bytes, audio_decode_ms))
        )

    async def handle_transcript_event(self, payload: Dict[str, Any], msg_type: str) -> None:
        """Handle ``transcript_partial`` / ``transcript_final`` messages."""
        if not self.state.conversation_id:
            await self.websocket.send_json({"type": "error", "detail": "session_meta must be sent first"})
            return
        text = payload.get("text", "")
        if not text:
            return
        event_type = "final" if msg_type == "transcript_final" else "partial"
        await self._persist_event(
            event_type,
            text,
            metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
            timestamps=payload.get("timestamps") if isinstance(payload.get("timestamps"), dict) else {},
            emit_to_client=False,
        )

    async def handle_final_flush(self, payload: Dict[str, Any]) -> None:
        """Handle ``final_flush`` message — drain STT, persist, run processor."""
        self.stt_flush_requested = True
        flush_started_at = time.perf_counter()
        flush_stage_metrics: Dict[str, Any] = {
            "pending_stt_chunks": len(self.pending_stt_chunk_tasks),
            "final_flush_total_ms": _elapsed_ms(flush_started_at),
        }
        flush_payload: Dict[str, Any] = {
            "type": "flush_ack",
            "telemetry": {
                key: value
                for key, value in flush_stage_metrics.items()
                if _coerce_latency_ms(value) is not None
            },
        }
        await _safe_send_json(self.websocket, flush_payload)
        self._track_background_task(asyncio.create_task(self._run_post_flush_processing()))

    # ------------------------------------------------------------------
    # Main message loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Receive and dispatch WebSocket messages until disconnection."""
        try:
            while True:
                message = await self.websocket.receive_text()
                payload = json.loads(message)
                msg_type = payload.get("type")

                if msg_type == "session_meta":
                    await self.handle_session_meta(payload)
                elif msg_type == "audio_chunk":
                    await self.handle_audio_chunk(payload)
                elif msg_type in {"transcript_partial", "transcript_final"}:
                    await self.handle_transcript_event(payload, msg_type)
                elif msg_type == "final_flush":
                    await self.handle_final_flush(payload)
                elif msg_type == "client_log":
                    logger.info("[CLIENT LOG] %s", payload.get("message"))
                elif msg_type == "ping":
                    await self.websocket.send_json({"type": "pong"})

        except WebSocketDisconnect:
            logger.info("[WS] Client disconnected")
        except RuntimeError as exc:
            if "WebSocket is not connected" in str(exc):
                logger.info("[WS] Client disconnected")
            else:
                logger.exception("[WS] Runtime error in transcript websocket: %s", exc)
                await _safe_send_json(
                    self.websocket, {"type": "error", "detail": "Internal server error"}
                )
                if _ws_is_connected(self.websocket):
                    try:
                        await self.websocket.close(code=1011)
                    except RuntimeError:
                        pass
        except Exception as exc:
            logger.exception("[WS] Error processing transcript websocket: %s", exc)
            await _safe_send_json(
                self.websocket, {"type": "error", "detail": "Internal server error"}
            )
            if _ws_is_connected(self.websocket):
                try:
                    await self.websocket.close(code=1011)
                except RuntimeError:
                    pass
        finally:
            if self.pending_stt_chunk_tasks:
                for task in list(self.pending_stt_chunk_tasks):
                    task.cancel()
                await asyncio.gather(*list(self.pending_stt_chunk_tasks), return_exceptions=True)
            if self.stt_runtime:
                try:
                    await self.stt_runtime.close()
                except Exception as exc:
                    logger.debug("[WS] stt_runtime.close() failed: %s", exc)

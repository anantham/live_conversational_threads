"""In-process bridge: Attendee meeting transcripts -> LCT live-graph pipeline.

A :class:`MeetingSession` owns a **loopback WebSocket client** to this backend's
own ``/ws/transcripts`` endpoint. It replays the exact live-STT protocol the mic
path uses (``auth`` -> ``session_meta`` -> ``transcript_final``* -> ``final_flush``),
so a meeting transcript drives the same persist -> processor -> consolidation
pipeline with ZERO changes to the STT session code.

The server pushes graph updates (``existing_json`` / ``chunk_dict`` /
``graph_patch`` / ``session_started`` / ``flush_complete``) back over the same
socket. A reader task fans those out verbatim to browser "viewer" sockets
(``/ws/meeting/{conversation_id}``) so the frontend reuses its existing
live-graph handlers with no new graph code.

Why loopback rather than driving :class:`WsSessionContext` in-process: the real
endpoint owns the whole lifecycle — the post-flush consolidation + graph persist
+ teardown (``stt_ws_session.py`` ``_run_post_flush_processing`` and ``run()``'s
``finally``). Going over a real socket reuses all of it; the mic path is left
untouched. The loopback target is ``127.0.0.1``, which the ``LCT_LOCAL_ONLY``
egress chokepoint (ADR-034) classifies as local, so the guard permits it.

Decoupling note: the bridge — not the browser — owns the producer socket and the
DB session. So the bot keeps recording and the graph keeps building even if the
user closes the viewer tab; viewers attach/detach freely.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import websockets

from lct_python_backend.services.env_helpers import env_float, env_str_or_none

logger = logging.getLogger("lct_backend")

# Token the loopback producer presents to /ws/transcripts (same as the mic
# client's first auth frame). Read from the live process env (load_dotenv ran at
# backend import). None/empty => the WS endpoint skips auth in dev.
AUTH_TOKEN: Optional[str] = os.getenv("AUTH_TOKEN") or None

# After final_flush the server keeps emitting graph patches while it consolidates
# (L3-L5), enriches edges and persists. We must keep the producer socket OPEN
# until that finishes (the DB session is tied to the socket's lifetime), then
# close. "Finished" is detected by quiescence: no new server message for
# QUIESCE_S, capped at MAX_S.
FINALIZE_QUIESCE_S: float = env_float("ATTENDEE_FINALIZE_QUIESCE_S", 30.0)
FINALIZE_MAX_S: float = env_float("ATTENDEE_FINALIZE_MAX_S", 600.0)
SESSION_META_TIMEOUT_S: float = env_float("ATTENDEE_SESSION_META_TIMEOUT_S", 15.0)

# Attendee bot states (label strings as delivered in bot.state_change) that mean
# "the meeting is over, run the final flush". Codes handled too, defensively.
TERMINAL_STATES = {"ended", "fatal_error", "data_deleted"}
TERMINAL_STATE_CODES = {7, 9, 10}


def _resolve_self_ws_url() -> str:
    """ws:// URL of this backend's own /ws/transcripts endpoint (loopback).

    Resolved at connect time so the port file is fresh. Order: explicit
    LCT_SELF_WS_URL override -> LCT_SELF_PORT -> repo-root .backend-port -> 43181.
    """
    override = env_str_or_none("LCT_SELF_WS_URL")
    if override:
        return override
    port = env_str_or_none("LCT_SELF_PORT")
    if not port:
        try:
            # services/attendee_bridge.py -> parents[2] == repo root
            port_file = Path(__file__).resolve().parents[2] / ".backend-port"
            port = port_file.read_text(encoding="utf-8").strip()
        except Exception:
            port = None
    port = port or "43181"
    return f"ws://127.0.0.1:{port}/ws/transcripts"


def _meeting_name(meeting_url: str) -> str:
    code = (meeting_url or "").rstrip("/").rsplit("/", 1)[-1] or "meeting"
    return f"Google Meet ({code})"


def _is_terminal_state(state: Any) -> bool:
    if isinstance(state, bool):
        return False
    if isinstance(state, int):
        return state in TERMINAL_STATE_CODES
    if isinstance(state, str):
        return state.strip().lower() in TERMINAL_STATES
    return False


class MeetingSession:
    """One live meeting: loopback producer + viewer fan-out + dedupe."""

    def __init__(self, *, conversation_id: str, meeting_url: str, bot_name: str) -> None:
        self.conversation_id = conversation_id
        self.meeting_url = meeting_url
        self.bot_name = bot_name
        self.bot_id: Optional[str] = None

        self._ws: Optional[Any] = None  # websockets client connection
        self._reader_task: Optional[asyncio.Task] = None
        self._finalize_task: Optional[asyncio.Task] = None
        self._send_lock = asyncio.Lock()
        self._sub_lock = asyncio.Lock()
        self._started_evt = asyncio.Event()  # set on session_started

        # Viewer fan-out + replay log for late joiners.
        self._subscribers: Set["asyncio.Queue[Optional[dict]]"] = set()
        self._message_log: List[dict] = []

        self._seen_idempotency: Set[str] = set()
        self._utterance_count = 0
        self._last_msg_at: float = time.monotonic()
        self.bot_state: Optional[Any] = None
        self.status: str = "starting"  # starting|joining|recording|finalizing|ended|error
        self._closed = False
        self._finalizing = False
        # Latency instrumentation: wall-clock anchor for recording start (set on
        # JOINED_RECORDING) so each utterance's timestamp_ms (relative to recording
        # start) maps to an absolute speech time. Lets us measure speech -> shown.
        self._rec_anchor_wall: Optional[float] = None
        self._e2e_latencies_ms: List[float] = []

    # -- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        """Open the loopback producer, authenticate, send session_meta, and wait
        until the server confirms session_started (conversation row exists)."""
        url = _resolve_self_ws_url()
        logger.info("[attendee-bridge] conv=%s connecting loopback producer -> %s", self.conversation_id, url)
        self._ws = await websockets.connect(url, open_timeout=SESSION_META_TIMEOUT_S, max_size=None)
        if AUTH_TOKEN:
            await self._ws.send(json.dumps({"type": "auth", "token": AUTH_TOKEN}))
        await self._ws.send(json.dumps({
            "type": "session_meta",
            "conversation_id": self.conversation_id,
            "provider": "attendee",
            "metadata": {
                "conversation_name": _meeting_name(self.meeting_url),
                "source": "attendee_meeting_bot",
                "source_metadata": {"meeting_url": self.meeting_url, "bot_name": self.bot_name},
            },
        }))
        self._reader_task = asyncio.create_task(self._reader_loop(), name=f"attendee-reader-{self.conversation_id}")
        try:
            await asyncio.wait_for(self._started_evt.wait(), timeout=SESSION_META_TIMEOUT_S)
        except asyncio.TimeoutError:
            await self.close(reason="session_meta_timeout")
            raise RuntimeError("Timed out waiting for session_started from /ws/transcripts")
        self.status = "joining"

    def attach_bot(self, bot_id: str) -> None:
        self.bot_id = bot_id

    async def inject_utterance(
        self,
        *,
        text: str,
        speaker_name: Optional[str],
        speaker_uuid: Optional[str] = None,
        speaker_is_host: Optional[bool] = None,
        timestamp_ms: Optional[int] = None,
        duration_ms: Optional[int] = None,
        recv_wall: Optional[float] = None,
    ) -> None:
        """Forward one finalized meeting utterance as a transcript_final frame and
        relay it to viewers (live captions). Stamps speech->shown latency for
        empirical real-time measurement (the viewer reads metadata.latency)."""
        if self._closed or self._finalizing or not self._ws:
            return
        text = (text or "").strip()
        if not text:
            return
        recv = recv_wall or time.time()
        timestamps: Dict[str, Any] = {}
        if isinstance(timestamp_ms, (int, float)):
            start_s = float(timestamp_ms) / 1000.0
            timestamps["start"] = start_s
            if isinstance(duration_ms, (int, float)):
                timestamps["end"] = start_s + max(0.0, float(duration_ms) / 1000.0)
        # Latency: timestamp_ms is relative to recording start; anchor it to the
        # wall clock captured at JOINED_RECORDING to get absolute speech time.
        #   attendee_lag_ms = speech_end -> webhook arrival (Google captions + Attendee)
        #   pipeline_ms     = webhook arrival -> shown (our cost)
        #   e2e_ms          = speech_end -> shown (what the viewer perceives)
        shown = time.time()
        e2e_ms = attendee_lag_ms = None
        if isinstance(timestamp_ms, (int, float)) and self._rec_anchor_wall is not None:
            speech_end_wall = self._rec_anchor_wall + (float(timestamp_ms) + float(duration_ms or 0)) / 1000.0
            attendee_lag_ms = round((recv - speech_end_wall) * 1000.0, 1)
            e2e_ms = round((shown - speech_end_wall) * 1000.0, 1)
            self._e2e_latencies_ms.append(e2e_ms)
        pipeline_ms = round((shown - recv) * 1000.0, 1)
        logger.info(
            "[LATENCY] conv=%s e2e_ms=%s attendee_lag_ms=%s pipeline_ms=%s ts_ms=%s dur_ms=%s | %s: %s",
            self.conversation_id, e2e_ms, attendee_lag_ms, pipeline_ms,
            timestamp_ms, duration_ms, speaker_name, text[:80],
        )
        frame = {
            "type": "transcript_final",
            "text": text,
            "metadata": {
                "speaker_name": speaker_name,
                "speaker_source": "attendee",
                # Meeting-scoped speaker id from Attendee; carried for downstream
                # speaker rollup even though the session speaker_id is constant.
                "speaker_uuid": speaker_uuid,
                "speaker_is_host": speaker_is_host,
                "latency": {"e2e_ms": e2e_ms, "attendee_lag_ms": attendee_lag_ms, "pipeline_ms": pipeline_ms},
            },
            "timestamps": timestamps,
        }
        async with self._send_lock:
            await self._ws.send(json.dumps(frame))
        self._relay(frame)
        self._utterance_count += 1
        if self.status in {"joining", "starting"}:
            self.status = "recording"

    async def finalize(self, reason: str = "bot_ended") -> None:
        """Send final_flush and schedule a graceful close once the server's
        post-flush consolidation + persist quiesce."""
        if self._finalizing or self._closed:
            return
        self._finalizing = True
        self.status = "finalizing"
        logger.info("[attendee-bridge] conv=%s finalizing (%s) after %d utterance(s)",
                    self.conversation_id, reason, self._utterance_count)
        try:
            if self._ws is not None:
                async with self._send_lock:
                    await self._ws.send(json.dumps({"type": "final_flush"}))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[attendee-bridge] conv=%s final_flush send failed: %s", self.conversation_id, exc)
        self._relay({"type": "bot_status", "data": {"status": "finalizing", "bot_state": self.bot_state}})
        self._finalize_task = asyncio.create_task(self._finalize_watcher(), name=f"attendee-finalize-{self.conversation_id}")

    async def _finalize_watcher(self) -> None:
        """Hold the producer open until graph activity quiesces, then close."""
        start = time.monotonic()
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            idle = now - self._last_msg_at
            if idle >= FINALIZE_QUIESCE_S:
                logger.info("[attendee-bridge] conv=%s post-flush quiesced (idle=%.1fs); closing", self.conversation_id, idle)
                break
            if now - start >= FINALIZE_MAX_S:
                logger.warning("[attendee-bridge] conv=%s finalize cap reached (%.0fs); closing", self.conversation_id, FINALIZE_MAX_S)
                break
        await self.close(reason="finalized")

    async def close(self, reason: str = "closed") -> None:
        if self._closed:
            return
        self._closed = True
        self.status = "ended" if reason in {"finalized", "bot_ended"} else "error"
        # Tell viewers the stream is done, then release them.
        self._relay({"type": "meeting_ended", "data": {"reason": reason, "status": self.status}})
        async with self._sub_lock:
            for q in list(self._subscribers):
                q.put_nowait(None)  # sentinel -> viewer loop exits
            self._subscribers.clear()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        _unregister(self)
        logger.info("[attendee-bridge] conv=%s closed (%s)", self.conversation_id, reason)

    # -- producer reader + viewer fan-out -----------------------------------

    async def _reader_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                self._last_msg_at = time.monotonic()
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if msg.get("type") == "session_started":
                    self._started_evt.set()
                await self._relay_async(msg)
        except asyncio.CancelledError:
            raise
        except websockets.exceptions.ConnectionClosed:
            if not self._finalizing and not self._closed:
                logger.warning("[attendee-bridge] conv=%s producer closed unexpectedly", self.conversation_id)
                await self.close(reason="producer_closed")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[attendee-bridge] conv=%s reader error: %s", self.conversation_id, exc)
            if not self._closed:
                await self.close(reason="reader_error")

    def _relay(self, msg: dict) -> None:
        """Append to the replay log and fan out to current viewers (sync)."""
        self._message_log.append(msg)
        for q in list(self._subscribers):
            q.put_nowait(msg)

    async def _relay_async(self, msg: dict) -> None:
        async with self._sub_lock:
            self._relay(msg)

    async def subscribe(self) -> "tuple[asyncio.Queue, List[dict]]":
        """Register a viewer. Returns (queue, snapshot) atomically so the viewer
        replays the full history then receives every subsequent message with no
        gap or duplicate."""
        q: "asyncio.Queue[Optional[dict]]" = asyncio.Queue()
        async with self._sub_lock:
            snapshot = list(self._message_log)
            if self._closed:
                q.put_nowait(None)
            else:
                self._subscribers.add(q)
        return q, snapshot

    async def unsubscribe(self, q: "asyncio.Queue") -> None:
        async with self._sub_lock:
            self._subscribers.discard(q)

    # -- webhook-driven updates ---------------------------------------------

    def already_seen(self, idempotency_key: Optional[str]) -> bool:
        if not idempotency_key:
            return False
        if idempotency_key in self._seen_idempotency:
            return True
        self._seen_idempotency.add(idempotency_key)
        return False

    async def on_bot_state(self, new_state: Any, *, sub_type: Any = None) -> None:
        self.bot_state = new_state
        label = str(new_state)
        if isinstance(new_state, str):
            low = new_state.strip().lower()
            if "recording" in low:
                self.status = "recording"
                if self._rec_anchor_wall is None:
                    # Anchor the latency clock at recording start (best-effort:
                    # this webhook lands shortly after recording actually begins).
                    self._rec_anchor_wall = time.time()
            elif "waiting_room" in low:
                self.status = "waiting_room"
            elif "joining" in low or low == "joined":
                self.status = "joining"
        self._relay({"type": "bot_status", "data": {"status": self.status, "bot_state": label, "event_sub_type": sub_type}})
        if _is_terminal_state(new_state):
            await self.finalize(reason=f"bot_state:{label}")

    def public_status(self) -> Dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "bot_id": self.bot_id,
            "meeting_url": self.meeting_url,
            "status": self.status,
            "bot_state": str(self.bot_state) if self.bot_state is not None else None,
            "utterances": self._utterance_count,
            "viewers": len(self._subscribers),
            "closed": self._closed,
        }


# -- module-level registry ---------------------------------------------------

_by_conversation: Dict[str, MeetingSession] = {}
_by_bot: Dict[str, MeetingSession] = {}
_registry_lock = asyncio.Lock()


async def register(session: MeetingSession) -> None:
    async with _registry_lock:
        _by_conversation[session.conversation_id] = session
        if session.bot_id:
            _by_bot[session.bot_id] = session


async def bind_bot(session: MeetingSession, bot_id: str) -> None:
    session.attach_bot(bot_id)
    async with _registry_lock:
        _by_bot[bot_id] = session


def _unregister(session: MeetingSession) -> None:
    _by_conversation.pop(session.conversation_id, None)
    if session.bot_id:
        _by_bot.pop(session.bot_id, None)


def get_by_bot(bot_id: str) -> Optional[MeetingSession]:
    return _by_bot.get(bot_id)


def get_by_conversation(conversation_id: str) -> Optional[MeetingSession]:
    return _by_conversation.get(conversation_id)


def all_sessions() -> List[MeetingSession]:
    return list(_by_conversation.values())

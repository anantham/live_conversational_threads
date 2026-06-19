"""Per-connection WebSocket session context for the STT transcript handler.

Extracts all mutable per-connection state and nested closures from
``stt_api.transcripts_websocket`` into a single class, making the WS handler
a thin one-liner: ``await WsSessionContext(...).run()``.

No public API change — the router in ``stt_api.py`` is the only caller.
"""

import asyncio
import base64
import copy
import json
import logging
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import select

from lct_python_backend.models import Utterance
from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend.services.consumption_match_runner import (
    ConsumptionMatchDeduper,
    run_match_for_segment as run_consumption_match_for_segment,
    should_run as should_run_consumption_match,
)
from lct_python_backend.services.live_prayer import (
    LivePrayerDeduper,
    run_for_segment as run_live_prayer_for_segment,
    should_run as should_run_live_prayer,
)
from lct_python_backend.services.contacts_cache import read_contacts_cache
from lct_python_backend.services.user_identity_service import get_self_contact_id
from lct_python_backend.services.byok_session_store import (
    BYOK_SCOPE_LLM_LIVE,
    BYOK_SCOPE_STT_LIVE,
    build_runtime_llm_config_for_byok,
    build_runtime_llm_providers_for_byok,
    build_runtime_stt_settings_for_byok,
    resolve_byok_session,
    ByokSessionLookupError,
)
from lct_python_backend.services.graph_persistence import persist_live_graph_snapshot
from lct_python_backend.services.hierarchy_consolidator import (
    consolidate_ideas_to_topics,
    consolidate_topics_to_themes,
    consolidate_themes_to_arcs,
)
from lct_python_backend.services.quota_service import QuotaService
from lct_python_backend.services.owner_context import resolve_owner_id
from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
from lct_python_backend.services.speaker_naming_service import is_confirmed_speaker_name
from lct_python_backend.services.speaker_voice_library import (
    gather_known_speakers_from_participants,
    get_speaker_audio_references,
)
from lct_python_backend.services.stt_http_transcriber import decode_audio_base64, pcm16le_to_wav, transcribe_wav_stt_candidate
from lct_python_backend.services.no_audio_guard import NoAudioGuard
from lct_python_backend.services.stt_live_graph import (
    build_draft_graph_patch,
    build_speaker_reconciliation_patch,
    clean_transcript_text,
    source_texts_overlap,
    should_emit_draft_update,
)
from lct_python_backend.services.stt_live_runtime import LiveSttRuntime, build_live_stt_runtime
from lct_python_backend.services.stt_live_provider_selection import (
    build_live_stt_background_refinement_candidate,
    resolve_live_stt_candidates,
)
from lct_python_backend.services.stt_session import SessionState, ensure_conversation, persist_transcript_event
from lct_python_backend.services.stt_ws_helpers import (
    build_ws_error_payload as _build_ws_error_payload,
    build_telemetry_metadata as _build_telemetry_metadata,
    coerce_latency_ms as _coerce_latency_ms,
    elapsed_ms as _elapsed_ms,
    normalize_provider as _normalize_provider,
    now_ms as _now_ms,
    safe_float as _safe_float,
    safe_int as _safe_int,
    safe_send_json as _safe_send_json,
    send_graph_patch as _send_graph_patch_helper,
    send_processor_update as _send_processor_update_helper,
    should_emit_final_segment as _should_emit_final_segment,
    ws_is_connected as _ws_is_connected,
)
from lct_python_backend.services.session_observability import (
    finish_session as finish_observed_session,
    record_event as record_observability_event,
    start_session as start_observed_session,
)
from lct_python_backend.services.thread_observability_service import (
    finish_thread_session,
    record_thread_event,
    start_thread_session,
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
        llm_providers: Optional[List[Dict[str, Any]]],
        load_stt_settings_fn,
        download_token: Optional[str] = None,
    ) -> None:
        self.websocket = websocket
        self.session = session
        self.audio_storage = audio_storage
        self.download_token = download_token
        self._load_stt_settings = load_stt_settings_fn
        self._base_llm_config = copy.deepcopy(llm_config or {})
        self._base_llm_providers = copy.deepcopy(llm_providers or [])
        self._runtime_llm_config = copy.deepcopy(self._base_llm_config)
        self._runtime_llm_providers = copy.deepcopy(self._base_llm_providers)

        # Session state
        self.state = SessionState(metadata={})
        self.stt_runtime: Optional[LiveSttRuntime] = None
        self.refinement_candidate: Optional[Dict[str, Any]] = None
        self.pending_partial_parts: List[str] = []
        self.pending_partial_chars: int = 0
        self.pending_partial_timestamps: Dict[str, Optional[float]] = {"start": None, "end": None}
        self.pending_speaker_segments: List[Dict[str, Any]] = []
        # Distinct diarization speaker labels seen this session. The one-shot
        # 2nd-speaker WS nudge fires the first time this reaches 2.
        self.seen_speaker_ids: set = set()
        self._second_speaker_announced: bool = False
        self.session_final_text_parts: List[str] = []
        self.active_draft_graph: Optional[Dict[str, str]] = None
        self.pending_draft_replacements: List[Dict[str, str]] = []
        self.pending_speaker_reconciliations: List[Dict[str, Any]] = []
        self.stt_unready_notified: bool = False
        self.stt_flush_requested: bool = False

        # Refinement audio buffer — accumulate PCM across finals for larger diarization windows
        self._refinement_pcm_buffer: bytearray = bytearray()
        self._refinement_text_parts: List[str] = []
        self._refinement_sample_rate_hz: int = 16000
        self._refinement_window_start: Optional[float] = None
        self._refinement_window_end: Optional[float] = None
        self._refinement_source_utterance_ids: set[str] = set()
        self._refinement_timer_task: Optional["asyncio.Task[Any]"] = None
        self.first_audio_chunk_logged: bool = False
        self.telemetry_state: Dict[str, Optional[int]] = {
            "audio_send_started_at_ms": None,
            "first_partial_at_ms": None,
            "first_final_at_ms": None,
        }
        # No-audio guard — halts STT forwarding once a dead/muted-mic session
        # has produced no real audio for a while, so OpenAI credits aren't
        # burned on silence. Dormant the instant any real audio is heard.
        self._no_audio_guard = NoAudioGuard()

        # Auto consumption-match (#17) — agenda-query detector wired to the
        # finalized-transcript path. Off by default (feature-flag in
        # consumption_match_runner.should_run / AGENDA_QUERY_DETECTOR_ENABLED).
        # Contact names are lazy-loaded on first final from the picker's
        # cache (services/contacts_cache.read_contacts_cache); the fallback
        # contact_ref is resolved on first final from the conversation's
        # participants list (first non-self entry).
        self._consumption_contact_names: Optional[List[str]] = None
        self._consumption_contact_ref: Optional[str] = None
        self._consumption_contact_ref_resolved: bool = False
        self._consumption_match_deduper = ConsumptionMatchDeduper()

        # Live-prayer cards (fetch / fact-check): explicit, M5-fuzzy detection on each
        # final segment → passive prayer_card WS event. Off behind LIVE_PRAYER_CARDS_ENABLED.
        # In-flight guard prevents M5-task pile-up when segments arrive faster than M5 replies.
        self._live_prayer_deduper = LivePrayerDeduper()
        self._live_prayer_in_flight: bool = False

        # Task tracking
        self.background_tasks: set = set()
        self.pending_processor_final_tasks: set = set()
        self.pending_stt_chunk_tasks: set = set()
        self.pending_refinement_tasks: set = set()
        self.graph_persist_task: Optional["asyncio.Task[Any]"] = None
        self.graph_persist_requested: bool = False
        self.first_graph_queued_at_ms: Optional[int] = None
        self.first_graph_completed_at_ms: Optional[int] = None
        self.flush_complete_sent: bool = False
        self.session_terminal_status: str = "completed"
        self.session_terminal_reason: str = "completed"
        self.session_started_committed: bool = False
        # Segment-and-stitch resume: when this WS session attaches to a
        # conversation that already has graph nodes (a prior recording
        # segment), these are that segment's node ids. They're forwarded to
        # persist_graph as protect_node_ids so the live graph-persist freezes
        # the prior segment instead of wiping it. None for a fresh recording.
        self.protected_node_ids: Optional[set] = None

        # Locks
        self.processor_lock = asyncio.Lock()
        self.stt_stream_lock = asyncio.Lock()
        self.graph_persist_lock = asyncio.Lock()

        # Processor wired to self's callbacks
        self.processor = TranscriptProcessor(
            send_update=self._processor_update,
            send_status=self._processor_status,
            llm_config=self._runtime_llm_config,
            providers=self._runtime_llm_providers,
        )

    def _reset_processor(self) -> None:
        self.processor = TranscriptProcessor(
            send_update=self._processor_update,
            send_status=self._processor_status,
            llm_config=self._runtime_llm_config,
            providers=self._runtime_llm_providers,
        )

    async def _detect_resume(self, conversation_id) -> None:
        """Segment-and-stitch resume detection.

        A WS session whose conversation_id already has graph Node rows is a
        RESUME of a prior recording segment. Capture that segment's node ids
        into ``self.protected_node_ids`` — they're forwarded to persist_graph
        as ``protect_node_ids`` so the live graph-persist freezes the prior
        segment instead of wiping it. No-op for a fresh recording.

        Deliberately NOT seeding the processor from the prior segment: that
        would require reconstructing the graph via build_graph_data_from_nodes,
        which is relationship-lossy (see scripts/verify_graph_roundtrip.py).
        Cross-segment stitch is left to the post-flush consolidation pass.
        """
        from sqlalchemy import select
        from lct_python_backend.models import Node

        conv_uuid = uuid.UUID(str(conversation_id))
        result = await self.session.execute(
            select(Node.id).where(Node.conversation_id == conv_uuid)
        )
        existing_ids = set(result.scalars().all())
        if existing_ids:
            self.protected_node_ids = existing_ids
            logger.info(
                "[WS][RESUME] session=%s conversation=%s — re-attaching; "
                "%d prior-segment node(s) frozen",
                self.state.session_id,
                conversation_id,
                len(existing_ids),
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

    def _track_refinement_task(self, task: "asyncio.Task[Any]") -> None:
        self.pending_refinement_tasks.add(task)
        self.background_tasks.add(task)
        task.add_done_callback(self.pending_refinement_tasks.discard)
        task.add_done_callback(self.background_tasks.discard)

    def _track_graph_persist_task(self, task: "asyncio.Task[Any]") -> None:
        self.graph_persist_task = task
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

        def _clear_graph_task(done_task: "asyncio.Task[Any]") -> None:
            if self.graph_persist_task is done_task:
                self.graph_persist_task = None

        task.add_done_callback(_clear_graph_task)

    # ------------------------------------------------------------------
    # Auto consumption-match (#17)
    # ------------------------------------------------------------------

    async def _ensure_consumption_contact_names(self) -> List[str]:
        """Lazy-load the known-contacts list from the picker's cache.

        Cached per session — refresh happens implicitly because the cache
        itself is stale-while-revalidate (services/contacts_cache.py).
        Empty list on failure; the detector still runs (contact-agnostic
        phrases work) but name-grounded templates can't expand.
        """
        if self._consumption_contact_names is not None:
            return self._consumption_contact_names
        names: List[str] = []
        try:
            cache = await read_contacts_cache(self.session)
            if cache and isinstance(cache.get("contacts"), list):
                names = [
                    str(c.get("display_name") or "").strip()
                    for c in cache["contacts"]
                    if isinstance(c, dict) and c.get("display_name")
                ]
        except Exception as exc:  # noqa: BLE001 — best-effort cache read
            logger.debug("[consumption-match] contact cache read failed: %s", exc)
        self._consumption_contact_names = names
        return names

    async def _ensure_consumption_contact_ref(self) -> Optional[str]:
        """Lazy-resolve the fallback contact for contact-agnostic agenda
        queries — pick the first non-self participant on the conversation.

        "Non-self" is decided by comparing each participant's contact_id to
        the configured self_contact_id (user_identity_service). When that
        identity isn't configured, fall back to the first participant; for
        a typical solo recording this is the seeded self, which makes
        "what was pending" point at the user's own list — harmless.

        Result is cached on the WS session — picker writes mid-recording
        won't re-resolve until the next session. Acceptable for MVP; the
        toolbar manual-trigger always supplies its own contact_ref so this
        only affects the auto path.
        """
        if self._consumption_contact_ref_resolved:
            return self._consumption_contact_ref

        ref: Optional[str] = None
        try:
            conversation_id = self.state.conversation_id
            if conversation_id:
                from lct_python_backend.models import Conversation as _Conversation
                try:
                    conv_uuid = uuid.UUID(str(conversation_id))
                except (ValueError, TypeError):
                    conv_uuid = None
                if conv_uuid is not None:
                    row = (
                        await self.session.execute(
                            select(_Conversation).where(_Conversation.id == conv_uuid)
                        )
                    ).scalar_one_or_none()
                    participants = []
                    if row is not None and isinstance(row.participants, list):
                        participants = [p for p in row.participants if isinstance(p, dict)]
                    if participants:
                        self_cid = await get_self_contact_id(self.session)
                        non_self = [
                            p for p in participants
                            if not self_cid or (p.get("contact_id") and p["contact_id"] != self_cid)
                        ]
                        chosen = (non_self or participants)[0]
                        ref = (chosen.get("display_name") or chosen.get("contact_id") or "").strip() or None
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug("[consumption-match] participant resolution failed: %s", exc)

        self._consumption_contact_ref = ref
        self._consumption_contact_ref_resolved = True
        if ref:
            logger.info(
                "[consumption-match] resolved fallback contact_ref=%r for conv=%s",
                ref, self.state.conversation_id,
            )
        return ref

    async def _send_consumption_match_event(self, payload: Dict[str, Any]) -> None:
        """Adapter passed to the runner so it doesn't import _safe_send_json."""
        await _safe_send_json(self.websocket, payload)

    async def _run_consumption_match(self, text: str) -> None:
        """Fire-and-forget agenda-query detector for one final segment.
        Errors are swallowed inside the runner — this wrapper just adds
        the session-level dependencies."""
        try:
            contact_names = await self._ensure_consumption_contact_names()
            fallback_ref = await self._ensure_consumption_contact_ref()
            await run_consumption_match_for_segment(
                segment_text=text,
                contact_names=contact_names,
                fallback_contact_ref=fallback_ref,
                conversation_id=self.state.conversation_id,
                deduper=self._consumption_match_deduper,
                send_ws_event=self._send_consumption_match_event,
            )
        except Exception as exc:  # noqa: BLE001 — fire-and-forget
            logger.warning("[consumption-match] runner failed: %s", exc)

    async def _send_prayer_card_event(self, payload: Dict[str, Any]) -> None:
        """Adapter passed to the live-prayer runner so it doesn't import _safe_send_json."""
        await _safe_send_json(self.websocket, payload)

    async def _run_live_prayer_cards(self, text: str) -> None:
        """Fire-and-forget live-prayer (fetch / fact-check) detection for one final
        segment. An in-flight guard drops a new segment while M5 is still working on
        the previous one — better to miss a beat than queue stale detections. Errors
        are swallowed — this must never affect the live STT path."""
        if self._live_prayer_in_flight:
            return
        self._live_prayer_in_flight = True
        try:
            await run_live_prayer_for_segment(
                segment_text=text,
                conversation_id=self.state.conversation_id,
                session_id=self.state.session_id,
                participants=None,
                deduper=self._live_prayer_deduper,
                send_ws_event=self._send_prayer_card_event,
            )
        except Exception as exc:  # noqa: BLE001 — fire-and-forget
            logger.warning("[live-prayer] runner failed: %s", exc)
        finally:
            self._live_prayer_in_flight = False

    def _merge_pending_partial_timestamps(self, timestamps: Optional[Dict[str, Any]]) -> None:
        if not isinstance(timestamps, dict):
            return
        raw_start_value = _safe_float(timestamps.get("start"), -1.0)
        raw_end_value = _safe_float(timestamps.get("end"), -1.0)
        start_value = raw_start_value if raw_start_value >= 0.0 else None
        end_value = raw_end_value if raw_end_value >= 0.0 else None
        if start_value is not None:
            existing_start = self.pending_partial_timestamps.get("start")
            self.pending_partial_timestamps["start"] = (
                start_value
                if existing_start is None
                else min(existing_start, start_value)
            )
        if end_value is not None:
            existing_end = self.pending_partial_timestamps.get("end")
            self.pending_partial_timestamps["end"] = (
                end_value
                if existing_end is None
                else max(existing_end, end_value)
            )

    def _consume_pending_partial_timestamps(self) -> Dict[str, float]:
        result = {
            key: value
            for key, value in self.pending_partial_timestamps.items()
            if value is not None
        }
        self.pending_partial_timestamps = {"start": None, "end": None}
        return result

    def _reset_pending_partial_state(self) -> None:
        self.pending_partial_parts = []
        self.pending_partial_chars = 0
        self.pending_partial_timestamps = {"start": None, "end": None}
        self.pending_speaker_segments = []

    # ------------------------------------------------------------------
    # Processor callbacks
    # ------------------------------------------------------------------

    async def _emit_graph_patch(self, patch: Optional[Dict[str, Any]]) -> None:
        await _send_graph_patch_helper(self.websocket, patch, logger)

    async def _snapshot_existing_graph(self) -> Tuple[List[Dict[str, Any]], Dict[str, List[str]]]:
        async with self.processor_lock:
            existing_json = getattr(self.processor, "existing_json", None) or []
            nodes = [
                copy.deepcopy(node)
                for node in existing_json
                if isinstance(node, dict)
            ]
            # Option B: deep-copy chunk_utterance_map so callers can mutate
            # freely without races against incremental updates.
            raw_map = getattr(self.processor, "chunk_utterance_map", None) or {}
            chunk_utt_map: Dict[str, List[str]] = {
                str(chunk_id): [str(uid) for uid in (utt_ids or [])]
                for chunk_id, utt_ids in raw_map.items()
                if utt_ids
            }
            return nodes, chunk_utt_map

    async def _run_graph_persist_loop(self, *, reason: str) -> None:
        async with self.graph_persist_lock:
            current_reason = reason
            while self.graph_persist_requested:
                self.graph_persist_requested = False
                snapshot, chunk_utt_map = await self._snapshot_existing_graph()
                if not snapshot or not self.state.conversation_id:
                    return
                started_at = time.perf_counter()
                try:
                    persisted = await persist_live_graph_snapshot(
                        conversation_id=str(self.state.conversation_id),
                        existing_json=snapshot,
                        metadata=self.state.metadata if isinstance(self.state.metadata, dict) else {},
                        source_type="live_audio",
                        utterance_chunk_map=chunk_utt_map or None,
                        protect_node_ids=self.protected_node_ids,
                    )
                    logger.info(
                        "[WS][GRAPH PERSIST] session=%s conversation=%s reason=%s persisted_nodes=%s latency_ms=%s",
                        self.state.session_id,
                        self.state.conversation_id,
                        current_reason,
                        persisted,
                        _elapsed_ms(started_at),
                    )
                    self._record_observability_event(
                        event_type="graph_persist",
                        stage="graph_persist",
                        level="info",
                        message="Persisted canonical live graph snapshot.",
                        context={"reason": current_reason, "persisted_nodes": persisted},
                        metrics={"graph_persist_ms": _elapsed_ms(started_at)},
                    )
                except Exception as exc:
                    logger.exception(
                        "[WS][GRAPH PERSIST] session=%s conversation=%s reason=%s failed: %s",
                        self.state.session_id,
                        self.state.conversation_id,
                        current_reason,
                        exc,
                    )
                    self._record_observability_event(
                        event_type="graph_persist_error",
                        stage="graph_persist",
                        level="error",
                        message="Failed to persist canonical live graph state.",
                        context={
                            "reason": current_reason,
                            "error": str(exc),
                            "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                        },
                    )
                    await _safe_send_json(
                        self.websocket,
                        {
                            "type": "processing_status",
                            "level": "warning",
                            "message": "Failed to persist canonical live graph state.",
                            "context": {
                                "stage": "graph_persist",
                                "phase": "error",
                                "reason": current_reason,
                                "error": str(exc),
                            },
                        },
                    )
                current_reason = "coalesced_update"

    def _schedule_graph_persistence(self, *, reason: str) -> None:
        if not self.state.conversation_id:
            return
        self.graph_persist_requested = True
        if self.graph_persist_task and not self.graph_persist_task.done():
            return
        self._track_graph_persist_task(
            asyncio.create_task(self._run_graph_persist_loop(reason=reason))
        )

    async def _ensure_graph_persisted(self, *, reason: str) -> None:
        if not self.state.conversation_id:
            return
        self.graph_persist_requested = True
        if self.graph_persist_task and not self.graph_persist_task.done():
            await self.graph_persist_task
            if self.graph_persist_requested:
                await self._run_graph_persist_loop(reason=reason)
            return
        await self._run_graph_persist_loop(reason=reason)

    async def _run_utterance_node_reconciliation(self) -> None:
        """Link utterances <-> nodes after the final graph persist.

        The live STT path writes Utterance rows and Node rows as two
        disconnected sets (utterances stream in before the chunk that covers
        them is emitted, so Option B's chunk_utterance_map ends up empty).
        This pass matches them after both are persisted and derives each
        node's speaker_info from the diarized utterance speaker_id.

        Non-fatal: the conversation already saved; a failure here just leaves
        the links unset (the windowed transcript rename still works without
        them — it is utterance-anchored).
        """
        if not self.state.conversation_id:
            return
        try:
            from lct_python_backend.services.utterance_node_reconciler import (
                reconcile_conversation_links,
            )

            summary = await reconcile_conversation_links(str(self.state.conversation_id))
            logger.info(
                "[WS][RECONCILE] session=%s conversation=%s linked=%s/%s "
                "nodes_with_speaker_info=%s",
                self.state.session_id,
                self.state.conversation_id,
                summary.get("linked_utterances"),
                summary.get("utterances"),
                summary.get("nodes_with_speaker_info"),
            )
            self._record_observability_event(
                event_type="utterance_node_reconciliation",
                stage="reconciliation",
                level="info",
                message="Linked utterances to nodes after final persist.",
                context=summary,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[WS][RECONCILE] non-fatal failure: %s", exc)
            self._record_observability_event(
                event_type="reconciliation_error",
                stage="reconciliation",
                level="warning",
                message="Utterance<->node reconciliation failed (non-fatal).",
                context={
                    "error": str(exc),
                    "traceback": "".join(
                        traceback.format_exception(type(exc), exc, exc.__traceback__)
                    ),
                },
            )

    async def _run_participant_speaker_inference(self) -> None:
        """Auto-name utterances when the conversation is unambiguously single-speaker.

        If diarization yields one substantive speaker and the participant
        picker recorded exactly one person, that person IS the speaker — set
        their name so the user need not rename. Non-fatal: a failure just
        leaves utterances un-named (the windowed transcript rename still works).
        """
        if not self.state.conversation_id:
            return
        try:
            from lct_python_backend.services.participant_speaker_inference import (
                infer_participant_speaker,
            )

            summary = await infer_participant_speaker(str(self.state.conversation_id))
            logger.info(
                "[WS][SPEAKER-INFER] session=%s conversation=%s assigned=%s "
                "participant=%s reason=%s",
                self.state.session_id,
                self.state.conversation_id,
                summary.get("assigned"),
                summary.get("participant"),
                summary.get("skipped_reason"),
            )
            self._record_observability_event(
                event_type="participant_speaker_inference",
                stage="reconciliation",
                level="info",
                message="Auto-assigned the participant speaker name.",
                context=summary,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[WS][SPEAKER-INFER] non-fatal failure: %s", exc)
            self._record_observability_event(
                event_type="participant_speaker_inference_error",
                stage="reconciliation",
                level="warning",
                message="Participant speaker inference failed (non-fatal).",
                context={
                    "error": str(exc),
                    "traceback": "".join(
                        traceback.format_exception(type(exc), exc, exc.__traceback__)
                    ),
                },
            )

    async def _run_hierarchy_consolidation_locked(self) -> None:
        """Run the three post-streaming consolidation passes against
        ``processor.existing_json``. Called holding ``self.processor_lock``.

        The streaming prompt is deliberately scoped to L1 (chunks) + L2 (ideas)
        only — topics, themes, and arcs come from this consolidation pass which
        sees the WHOLE conversation in one LLM call per tier. Without it the
        macro view (1-5 arc nodes the user wants to land on by default)
        stays empty for live recordings.

        Failures here are non-fatal: persist will proceed with whatever tiers
        DID materialize.
        """
        try:
            existing = list(self.processor.existing_json or [])

            def _of_level(level: int) -> List[Dict[str, Any]]:
                return [
                    n for n in existing
                    if isinstance(n, dict)
                    and int(n.get("semantic_level") or n.get("level") or 0) == level
                ]

            # Pull from constants the import path uses for symmetry.
            from lct_python_backend.services.tuning_constants import (
                MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
                MIN_TOPICS_FOR_THEME_CONSOLIDATION,
                MIN_THEMES_FOR_ARC_CONSOLIDATION,
            )

            ideas_in = _of_level(2)
            if len(ideas_in) < MIN_IDEAS_FOR_TOPIC_CONSOLIDATION:
                logger.info(
                    "[WS][CONSOLIDATE] skipped — only %d ideas (need >=%d)",
                    len(ideas_in), MIN_IDEAS_FOR_TOPIC_CONSOLIDATION,
                )
                return

            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "info",
                    "message": f"Clustering {len(ideas_in)} ideas into topics...",
                    "context": {"stage": "consolidating", "phase": "ideas_to_topics"},
                },
            )
            topics = await consolidate_ideas_to_topics(
                ideas_in, providers=self._runtime_llm_providers
            ) or []
            if topics:
                existing.extend(topics)
                logger.info("[WS][CONSOLIDATE] ideas=%d -> topics=%d", len(ideas_in), len(topics))

                if len(topics) >= MIN_TOPICS_FOR_THEME_CONSOLIDATION:
                    await _safe_send_json(
                        self.websocket,
                        {
                            "type": "processing_status",
                            "level": "info",
                            "message": f"Clustering {len(topics)} topics into themes...",
                            "context": {"stage": "consolidating", "phase": "topics_to_themes"},
                        },
                    )
                    themes = await consolidate_topics_to_themes(
                        topics, providers=self._runtime_llm_providers
                    ) or []
                    if themes:
                        existing.extend(themes)
                        logger.info("[WS][CONSOLIDATE] topics=%d -> themes=%d", len(topics), len(themes))

                        if len(themes) >= MIN_THEMES_FOR_ARC_CONSOLIDATION:
                            await _safe_send_json(
                                self.websocket,
                                {
                                    "type": "processing_status",
                                    "level": "info",
                                    "message": f"Synthesizing {len(themes)} themes into arcs...",
                                    "context": {"stage": "consolidating", "phase": "themes_to_arcs"},
                                },
                            )
                            arcs_result = await consolidate_themes_to_arcs(
                                themes, providers=self._runtime_llm_providers
                            )
                            arcs: List[Dict[str, Any]] = []
                            if isinstance(arcs_result, tuple) and len(arcs_result) == 3:
                                arcs, _title, _summary = arcs_result
                                arcs = arcs or []
                            else:
                                arcs = arcs_result or []
                            if arcs:
                                existing.extend(arcs)
                                logger.info("[WS][CONSOLIDATE] themes=%d -> arcs=%d", len(themes), len(arcs))

            # Write the augmented set back so _ensure_graph_persisted picks it up.
            self.processor.existing_json = existing
        except Exception as exc:  # noqa: BLE001
            # Same policy as import_bulk_pipeline: log + telemetry, don't fail
            # the session. The L1+L2 nodes still get persisted.
            logger.warning("[WS][CONSOLIDATE] non-fatal failure: %s", exc)
            self._record_observability_event(
                event_type="consolidation_error",
                stage="consolidation",
                level="warning",
                message="Hierarchy consolidation failed (non-fatal).",
                context={
                    "error": str(exc),
                    "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                },
            )

    async def _run_edge_enrichment_locked(self) -> None:
        """ADR-032 Part D: author semantic edges between consolidated nodes.

        Called holding ``self.processor_lock`` AFTER
        ``_run_hierarchy_consolidation_locked`` has produced the full 5-tier
        graph. Uses ``edge_enrichment.run_edge_enrichment`` which fetches
        IndrasNet retrieval context (Part E), applies the external_llm_ok
        privacy filter, and runs the ``enrich_semantic_edges`` prompt.

        Emitted edges are written ONTO each source node's ``edge_relations``
        list so ``persist_graph`` picks them up the same way it handles
        any other authored edges. Non-fatal: if enrichment fails, the
        graph still persists, just without the semantic edge layer.
        """
        try:
            from lct_python_backend.services.edge_enrichment import run_edge_enrichment

            existing = list(self.processor.existing_json or [])
            if not existing:
                logger.info("[WS][ENRICH] skipped — no nodes to enrich")
                return

            # Build a compact query for IndrasNet retrieval: title +
            # executive_summary if consolidation produced them, falling back
            # to a sample of top-tier node names.
            query_parts: List[str] = []
            metadata = self.state.metadata or {}
            title = (metadata.get("conversation_name") or "").strip()
            if title:
                query_parts.append(title)
            # source_metadata may carry title/summary from consolidation
            src_md = metadata.get("source_metadata") or {}
            if isinstance(src_md, dict):
                cs_title = (src_md.get("conversation_title") or "").strip()
                if cs_title:
                    query_parts.append(cs_title)
                cs_summary = (src_md.get("executive_summary") or "").strip()
                if cs_summary:
                    query_parts.append(cs_summary)
            # Add the top-tier node names as additional query material.
            top_tier_names = [
                (n.get("node_name") or "").strip()
                for n in existing
                if isinstance(n, dict) and int(n.get("semantic_level") or n.get("level") or 0) >= 4
            ]
            if top_tier_names:
                query_parts.extend(top_tier_names[:5])
            query_summary = "  |  ".join(p for p in query_parts if p) or "(untitled live conversation)"

            # Privacy gate set. None = no participants confirmed; we then
            # default to "drop all items with any participant attribution"
            # rather than allow leakage. The picker should populate
            # participants on conversation_metadata before flush.
            allow_set: Optional[set] = None
            participants_meta = metadata.get("participants") or []
            if isinstance(participants_meta, list) and participants_meta:
                allow_set = set()
                for p in participants_meta:
                    if not isinstance(p, dict):
                        continue
                    if p.get("external_llm_ok") is True:
                        for key in ("contact_id", "display_name", "name"):
                            val = p.get(key)
                            if val:
                                allow_set.add(str(val))

            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "info",
                    "message": "Enriching with semantic edges...",
                    "context": {"stage": "enrichment", "phase": "started"},
                },
            )

            edges, telemetry = await run_edge_enrichment(
                nodes=existing,
                query_summary=query_summary,
                participant_external_llm_ok_set=allow_set,
                providers=self._runtime_llm_providers,
            )

            # Attach edges to source nodes' edge_relations so persist_graph
            # writes them as Relationship rows. Each node's edge_relations
            # is a list; we extend with the new entries keyed by from_node_id.
            edges_by_from: Dict[str, List[Dict[str, Any]]] = {}
            for e in edges:
                edges_by_from.setdefault(str(e["from_node_id"]), []).append({
                    "related_node": str(e["to_node_id"]),
                    "relation_type": e["relation_type"],
                    "explanation": e.get("explanation") or "",
                })

            for node in existing:
                if not isinstance(node, dict):
                    continue
                nid = str(node.get("id") or "")
                if not nid or nid not in edges_by_from:
                    continue
                existing_edges = node.get("edge_relations")
                if not isinstance(existing_edges, list):
                    existing_edges = []
                # Append new edges, dedupe by (related_node, relation_type)
                seen_keys = {
                    (str(ee.get("related_node") or ""), str(ee.get("relation_type") or ""))
                    for ee in existing_edges
                    if isinstance(ee, dict)
                }
                for new_edge in edges_by_from[nid]:
                    key = (new_edge["related_node"], new_edge["relation_type"])
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    existing_edges.append(new_edge)
                node["edge_relations"] = existing_edges

            self.processor.existing_json = existing

            logger.info(
                "[WS][ENRICH] DONE: edges=%d total_ms=%.1f context_items=%d/%d (raw/filtered) error=%s",
                telemetry.get("edges_emitted", 0),
                telemetry.get("total_ms", 0),
                (telemetry.get("context_telemetry") or {}).get("raw_items", 0),
                (telemetry.get("context_telemetry") or {}).get("filtered_items", 0),
                (telemetry.get("context_telemetry") or {}).get("error"),
            )
            self._record_observability_event(
                event_type="edge_enrichment",
                stage="enrichment",
                level="info",
                message=f"Edge enrichment authored {telemetry.get('edges_emitted', 0)} edges.",
                context=telemetry,
                metrics={"enrichment_ms": telemetry.get("total_ms", 0)},
            )
        except Exception as exc:  # noqa: BLE001
            # Per ADR-032: non-fatal. Persist still proceeds.
            logger.warning("[WS][ENRICH] non-fatal failure: %s", exc)
            self._record_observability_event(
                event_type="enrichment_error",
                stage="enrichment",
                level="warning",
                message="Edge enrichment failed (non-fatal).",
                context={
                    "error": str(exc),
                    "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                },
            )

    def _last_final_node_id(self) -> Optional[str]:
        existing_json = getattr(self.processor, "existing_json", None)
        if not isinstance(existing_json, list) or not existing_json:
            return None
        latest = existing_json[-1]
        if not isinstance(latest, dict):
            return None
        candidate = str(latest.get("id") or "").strip()
        return candidate or None

    async def _maybe_emit_draft_graph_patch(
        self,
        text: str,
        *,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        clean_text = clean_transcript_text(text)
        previous_text = (self.active_draft_graph or {}).get("source_text", "")
        if not should_emit_draft_update(clean_text, previous_text):
            return

        if not self.active_draft_graph:
            self.active_draft_graph = {
                "node_id": f"draft-node::{uuid.uuid4()}",
                "chunk_id": f"draft-chunk::{uuid.uuid4()}",
                "source_text": clean_text,
            }
        else:
            self.active_draft_graph["source_text"] = clean_text

        await self._emit_graph_patch(
            build_draft_graph_patch(
                clean_text,
                node_id=self.active_draft_graph["node_id"],
                chunk_id=self.active_draft_graph["chunk_id"],
                speaker_segments=speaker_segments,
                predecessor_id=self._last_final_node_id(),
            )
        )

    def _queue_active_draft_for_replacement(self, source_text: str) -> None:
        if not self.active_draft_graph:
            return
        self.pending_draft_replacements.append(
            {
                "node_id": self.active_draft_graph["node_id"],
                "chunk_id": self.active_draft_graph["chunk_id"],
                "source_text": clean_transcript_text(source_text)
                or str(self.active_draft_graph.get("source_text") or ""),
            }
        )
        self.active_draft_graph = None

    def _consume_pending_draft_replacements(self, source_text: str) -> Dict[str, List[str]]:
        normalized_source = clean_transcript_text(source_text)
        remove_node_ids: List[str] = []
        remove_chunk_ids: List[str] = []
        matched_indices: List[int] = []

        for index, pending in enumerate(self.pending_draft_replacements):
            pending_source = str(pending.get("source_text") or "")
            if normalized_source and not source_texts_overlap(pending_source, normalized_source):
                continue
            matched_indices.append(index)
            remove_node_ids.append(str(pending.get("node_id") or ""))
            remove_chunk_ids.append(str(pending.get("chunk_id") or ""))

        if not matched_indices and normalized_source and len(self.pending_draft_replacements) == 1:
            pending = self.pending_draft_replacements[0]
            matched_indices = [0]
            remove_node_ids.append(str(pending.get("node_id") or ""))
            remove_chunk_ids.append(str(pending.get("chunk_id") or ""))

        if matched_indices:
            remaining = [
                pending
                for index, pending in enumerate(self.pending_draft_replacements)
                if index not in set(matched_indices)
            ]
            self.pending_draft_replacements = remaining

        return {
            "remove_node_ids": [value for value in remove_node_ids if value],
            "remove_chunk_ids": [value for value in remove_chunk_ids if value],
        }

    def _build_speaker_reconciliation_patch_locked(
        self,
        source_text: str,
        segments: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        patch = build_speaker_reconciliation_patch(
            getattr(self.processor, "existing_json", []) or [],
            getattr(self.processor, "chunk_dict", {}) or {},
            source_text=source_text,
            segments=segments,
        )
        if not patch:
            return None

        updated_by_id = {
            str(node.get("id") or ""): node
            for node in patch.get("nodes", [])
            if isinstance(node, dict) and str(node.get("id") or "").strip()
        }
        if updated_by_id:
            self.processor.existing_json = [
                updated_by_id.get(str(node.get("id") or ""), node)
                if isinstance(node, dict)
                else node
                for node in getattr(self.processor, "existing_json", []) or []
            ]
        for chunk_id, chunk_text in (patch.get("chunks") or {}).items():
            if not hasattr(self.processor, "chunk_dict") or not isinstance(self.processor.chunk_dict, dict):
                self.processor.chunk_dict = {}
            self.processor.chunk_dict[str(chunk_id)] = str(chunk_text)
        return patch

    async def _flush_pending_speaker_reconciliations_locked(self) -> None:
        if not self.pending_speaker_reconciliations:
            return

        remaining: List[Dict[str, Any]] = []
        patches_to_emit: List[Dict[str, Any]] = []
        for pending in self.pending_speaker_reconciliations:
            patch = self._build_speaker_reconciliation_patch_locked(
                str(pending.get("source_text") or ""),
                pending.get("segments") or [],
            )
            if patch:
                patches_to_emit.append(patch)
            else:
                remaining.append(pending)

        self.pending_speaker_reconciliations = remaining
        for patch in patches_to_emit:
            await self._emit_graph_patch(patch)

    async def _apply_or_queue_speaker_reconciliation(
        self,
        source_text: str,
        segments: List[Dict[str, Any]],
    ) -> bool:
        if not segments:
            return False

        async with self.processor_lock:
            patch = self._build_speaker_reconciliation_patch_locked(source_text, segments)
            if patch:
                await self._emit_graph_patch(patch)
                return True

        self.pending_speaker_reconciliations = [
            pending
            for pending in self.pending_speaker_reconciliations
            if not source_texts_overlap(pending.get("source_text"), source_text)
        ]
        self.pending_speaker_reconciliations.append(
            {
                "source_text": clean_transcript_text(source_text),
                "segments": [dict(segment or {}) for segment in segments],
            }
        )
        return False

    async def _clear_pending_draft_graph(self, *, reason: str) -> None:
        remove_node_ids: List[str] = []
        remove_chunk_ids: List[str] = []

        if self.active_draft_graph:
            remove_node_ids.append(str(self.active_draft_graph.get("node_id") or ""))
            remove_chunk_ids.append(str(self.active_draft_graph.get("chunk_id") or ""))
            self.active_draft_graph = None

        while self.pending_draft_replacements:
            pending = self.pending_draft_replacements.pop(0)
            remove_node_ids.append(str(pending.get("node_id") or ""))
            remove_chunk_ids.append(str(pending.get("chunk_id") or ""))

        if not any(remove_node_ids) and not any(remove_chunk_ids):
            return

        await self._emit_graph_patch(
            {
                "kind": "draft_clear",
                "nodes": [],
                "chunks": {},
                "node_count": 0,
                "chunk_count": 0,
                "remove_node_ids": [value for value in remove_node_ids if value],
                "remove_chunk_ids": [value for value in remove_chunk_ids if value],
                "reason": reason,
            }
        )

    async def _processor_update(self, existing_json, chunk_dict, patch: Optional[Dict[str, Any]] = None) -> None:
        patch_payload = dict(patch or {}) if isinstance(patch, dict) else None
        if patch_payload and str(patch_payload.get("kind") or "").strip().lower() == "finalized":
            removals = self._consume_pending_draft_replacements(str(patch_payload.get("source_text") or ""))
            patch_payload["remove_node_ids"] = [
                *list(dict.fromkeys((patch_payload.get("remove_node_ids") or []) + removals["remove_node_ids"]))
            ]
            patch_payload["remove_chunk_ids"] = [
                *list(dict.fromkeys((patch_payload.get("remove_chunk_ids") or []) + removals["remove_chunk_ids"]))
            ]
        await _send_processor_update_helper(
            self.websocket,
            existing_json,
            chunk_dict,
            logger,
            patch=patch_payload,
        )
        await self._flush_pending_speaker_reconciliations_locked()
        if patch_payload and str(patch_payload.get("kind") or "").strip().lower() == "finalized":
            self._schedule_graph_persistence(reason="finalized_patch")

    async def _processor_status(self, level: str, message: str, context: Dict[str, Any]) -> None:
        context = context or {}
        stage = str(context.get("stage") or "").strip().lower()
        phase = str(context.get("phase") or "").strip().lower()
        if stage == "graph":
            now_ms = _now_ms()
            if phase == "queued" and self.first_graph_queued_at_ms is None:
                self.first_graph_queued_at_ms = now_ms
            if phase == "completed" and self.first_graph_completed_at_ms is None:
                self.first_graph_completed_at_ms = now_ms
            logger.info(
                "[WS][GRAPH] session=%s conversation=%s phase=%s queued_finals=%s queue_wait_ms=%s generation_ms=%s total_update_ms=%s trigger=%s",
                self.state.session_id,
                self.state.conversation_id,
                phase or "-",
                context.get("queued_finals"),
                context.get("queue_wait_ms"),
                context.get("generation_ms") or context.get("latency_ms"),
                context.get("total_update_ms"),
                context.get("trigger"),
            )
            if phase == "completed" and self.telemetry_state.get("audio_send_started_at_ms"):
                logger.info(
                    "[WS][GRAPH] session=%s conversation=%s first_node_from_audio_ms=%s",
                    self.state.session_id,
                    self.state.conversation_id,
                    max(0, now_ms - int(self.telemetry_state["audio_send_started_at_ms"] or now_ms)),
                )
        self._record_observability_event(
            event_type="processing_status",
            stage=stage or "processor",
            level=str(level or "info"),
            message=str(message or ""),
            context=context,
        )
        await _safe_send_json(
            self.websocket,
            {
                "type": "processing_status",
                "level": str(level or "info"),
                "message": str(message or ""),
                "context": context,
            },
        )

    def _active_provider(self) -> Optional[str]:
        return str(
            getattr(self.stt_runtime, "provider", None)
            or self.state.provider
            or ""
        ).strip() or None

    def _active_transport(self) -> Optional[str]:
        return str(
            getattr(self.stt_runtime, "transport", None)
            or ""
        ).strip() or None

    def _record_observability_event(
        self,
        *,
        event_type: str,
        stage: str,
        level: str = "info",
        message: str = "",
        context: Optional[Dict[str, Any]] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ) -> None:
        record_observability_event(
            conversation_id=str(self.state.conversation_id or ""),
            session_id=str(self.state.session_id or ""),
            event_type=event_type,
            stage=stage,
            level=level,
            message=message,
            context=context,
            metrics=metrics,
        )

    async def _record_durable_session_event(
        self,
        *,
        event_type: str,
        stage: str,
        level: str = "info",
        message: str = "",
        code: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.state.conversation_id or not self.state.session_id:
            return
        try:
            await record_thread_event(
                self.session,
                conversation_id=self.state.conversation_id,
                session_id=self.state.session_id,
                stage=stage,
                event_type=event_type,
                level=level,
                code=code,
                message=message,
                context=context,
                metrics=metrics,
            )
        except Exception as exc:
            logger.warning("[WS][OBS] durable event write failed: %s", exc)

    def _mark_terminal_state(self, *, status: str, reason: str) -> None:
        current_status = str(self.session_terminal_status or "completed")
        if current_status == "failed":
            return
        if current_status == "abandoned" and status == "completed":
            return
        self.session_terminal_status = str(status or "completed")
        self.session_terminal_reason = str(reason or self.session_terminal_reason or "completed")

    def _classify_terminal_state(self) -> tuple[str, str]:
        status = str(self.session_terminal_status or "completed")
        reason = str(self.session_terminal_reason or "completed")
        if status == "failed":
            return status, reason
        if self.state.conversation_id and not self.flush_complete_sent:
            if self.first_audio_chunk_logged or self.telemetry_state.get("audio_send_started_at_ms"):
                return "abandoned", "client_disconnect_before_flush"
            if self.session_started_committed:
                return "abandoned", "client_disconnect_before_audio"
        return status, reason

    async def _emit_ws_error(
        self,
        *,
        message_type: str = "error",
        code: str,
        detail: str,
        stage: str,
        level: str = "error",
        fatal: bool = False,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = _build_ws_error_payload(
            message_type=message_type,
            code=code,
            detail=detail,
            stage=stage,
            level=level,
            fatal=fatal,
            session_id=self.state.session_id,
            conversation_id=self.state.conversation_id,
            provider=self._active_provider(),
            transport=self._active_transport(),
            context=context,
        )
        log_method = logger.error if str(level).lower() == "error" else logger.warning
        log_method(
            "[WS][%s] code=%s detail=%s context=%s",
            str(message_type or "error").upper(),
            payload["code"],
            payload["detail"],
            json.dumps(payload.get("context") or {}, separators=(",", ":")),
        )
        self._record_observability_event(
            event_type=str(message_type or "error"),
            stage=str(stage or "unknown"),
            level=str(level or "error"),
            message=str(detail or ""),
            context=payload.get("context") or {},
        )
        await self._record_durable_session_event(
            event_type=str(message_type or "error"),
            stage=str(stage or "unknown"),
            level=str(level or "error"),
            message=str(detail or ""),
            code=str(code or ""),
            context=payload.get("context") or {},
        )
        if fatal or str(level or "").lower() == "error":
            self._mark_terminal_state(status="failed", reason=str(code or "session_error"))
        await _safe_send_json(self.websocket, payload)
        return payload

    # ------------------------------------------------------------------
    # Internal processor helpers
    # ------------------------------------------------------------------

    async def _processor_handle_final_text(
        self,
        text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
        utterance_id: Optional[Any] = None,
    ) -> None:
        # Option B: thread the persisted utterance UUID into the LLM
        # accumulator so emitted chunks/nodes can back-link to their source
        # utterances at write time. Falls back gracefully for older processor
        # surfaces that don't accept these kwargs (tests / pipeline fakes).
        kwargs: Dict[str, Any] = {}
        if speaker_segments:
            kwargs["speaker_segments"] = speaker_segments
        if utterance_id is not None:
            kwargs["utterance_id"] = utterance_id

        if kwargs:
            try:
                await self.processor.handle_final_text(text, **kwargs)
                return
            except TypeError as exc:
                # Detect which unknown kwarg tripped us and retry without it.
                err = str(exc)
                if "utterance_id" in err and "utterance_id" in kwargs:
                    kwargs.pop("utterance_id", None)
                    try:
                        await self.processor.handle_final_text(text, **kwargs)
                        return
                    except TypeError as exc2:
                        if "speaker_segments" in str(exc2) and "speaker_segments" in kwargs:
                            kwargs.pop("speaker_segments", None)
                        else:
                            raise
                elif "speaker_segments" in err and "speaker_segments" in kwargs:
                    kwargs.pop("speaker_segments", None)
                else:
                    raise
                logger.debug(
                    "[WS] Processor handle_final_text rejected kwargs; retrying without: %s", err
                )
        await self.processor.handle_final_text(text)

    async def _run_processor_final(
        self,
        text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
        utterance_id: Optional[Any] = None,
    ) -> None:
        try:
            async with self.processor_lock:
                await self._processor_handle_final_text(
                    text,
                    speaker_segments=speaker_segments,
                    utterance_id=utterance_id,
                )
        except Exception as exc:
            logger.exception("[WS] Final transcript processing failed: %s", exc)
            self._record_observability_event(
                event_type="processor_final_error",
                stage="handle_final_text",
                level="error",
                message="Final transcript processing failed.",
                context={
                    "error": str(exc),
                    "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                },
            )
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
    ):
        normalized_text = str(text or "").strip()
        if not normalized_text:
            return

        if event_type == "partial":
            await self._maybe_emit_draft_graph_patch(
                normalized_text,
                speaker_segments=speaker_segments,
            )
        elif event_type == "final":
            self._queue_active_draft_for_replacement(normalized_text)
            self.session_final_text_parts.append(normalized_text)

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
        event = await persist_transcript_event(self.session, self.state, payload, event_type, normalized_text)
        await self.session.commit()
        self._record_observability_event(
            event_type=f"transcript_{event_type}",
            stage="transcript_event",
            level="info",
            message=f"Persisted transcript {event_type} event.",
            context={
                "text": normalized_text,
                "text_length": len(normalized_text),
                "speaker_segment_count": len(speaker_segments or []),
                "timestamps": timestamps or {},
            },
            metrics=event_metadata.get("telemetry") if isinstance(event_metadata.get("telemetry"), dict) else {},
        )
        await self._record_durable_session_event(
            event_type=f"transcript_{event_type}",
            stage="transcript_event",
            level="info",
            message=f"Persisted transcript {event_type} event.",
            context={
                "text_length": len(normalized_text),
                "speaker_segment_count": len(speaker_segments or []),
            },
            metrics=event_metadata.get("telemetry") if isinstance(event_metadata.get("telemetry"), dict) else {},
        )

        if event_type == "final" and process_final:
            # Option B: pass the persisted utterance UUID to the processor so
            # the emitted chunk/nodes can record which utterances contributed.
            # ``persist_transcript_event`` only assigns ``utterance_id`` for
            # ``event_type == "final"`` (partials don't create utterances).
            final_utterance_id = getattr(event, "utterance_id", None)
            self._track_processor_final_task(
                asyncio.create_task(
                    self._run_processor_final(
                        normalized_text,
                        speaker_segments=speaker_segments,
                        utterance_id=final_utterance_id,
                    )
                )
            )
            # Task #17 — fire-and-forget agenda-query detector. Off behind
            # AGENDA_QUERY_DETECTOR_ENABLED; gated so an unhandled error
            # here never affects the live STT path.
            if should_run_consumption_match():
                self._track_background_task(
                    asyncio.create_task(self._run_consumption_match(normalized_text))
                )

            # Live-prayer cards (fetch / fact-check) — explicit M5-fuzzy detection.
            # Off behind LIVE_PRAYER_CARDS_ENABLED; fire-and-forget so an error here
            # never affects the live STT path.
            if should_run_live_prayer():
                self._track_background_task(
                    asyncio.create_task(self._run_live_prayer_cards(normalized_text))
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
        return event

    # ------------------------------------------------------------------
    # Audio chunk processing
    # ------------------------------------------------------------------

    async def _run_background_refinement(
        self,
        wav_payload: bytes,
        source_text: str,
        *,
        source_utterance_id: Optional[str] = None,
        window_timestamps: Optional[Dict[str, Any]] = None,
        sample_rate_hz: Optional[int] = None,
    ) -> None:
        if not wav_payload or not self.refinement_candidate:
            return

        # 1. Determine sample rate for audio processing
        effective_sample_rate_hz = (
            max(8000, int(sample_rate_hz))
            if sample_rate_hz is not None
            else (self.stt_runtime.sample_rate_hz if self.stt_runtime else 16000)
        )

        # 2. Identify confirmed speakers and gather reference audio slices.
        #    Source order:
        #      (a) Conversation.participants (picker selection — durable
        #          contact_id link, gated by external_llm_ok for clips).
        #      (b) cross-session voice-library refs (legacy / fills gaps for
        #          confirmed speakers not in the picker).
        #      (c) in-conversation confirmed-speaker scan (legacy fallback).
        known_speakers: List[Dict[str, Any]] = []
        try:
            participant_speakers = await gather_known_speakers_from_participants(
                db=self.session,
                conversation_id=self.state.conversation_id,
            )
            for entry in participant_speakers:
                if entry.get("name"):
                    known_speakers.append({
                        "name": entry["name"],
                        # audio_base64 may be None when the contact is
                        # T3/external_llm_ok=False or no clip exists yet —
                        # the provider transport sends name-only in that case.
                        "audio_base64": entry.get("audio_base64"),
                    })
            if participant_speakers:
                logger.info(
                    "[WS][STT REFINE] session=%s conversation=%s using %d participant-picker speakers (%d with clips)",
                    self.state.session_id,
                    self.state.conversation_id,
                    len(participant_speakers),
                    sum(1 for s in participant_speakers if s.get("audio_base64")),
                )

            # Legacy path — only fill remaining slots if the picker hasn't
            # accounted for all 4. Names already in the participant list are
            # skipped to avoid double-counting.
            existing_names = {s["name"] for s in known_speakers if s.get("name")}
            if len(known_speakers) < 4:
                cross_session_refs = await get_speaker_audio_references(
                    db=self.session,
                    conversation_id=self.state.conversation_id,
                )
                for ref in cross_session_refs:
                    if len(known_speakers) >= 4:
                        break
                    name = ref.get("name")
                    if not name or name in existing_names:
                        continue
                    if ref.get("audio_base64"):
                        known_speakers.append({
                            "name": name,
                            "audio_base64": ref["audio_base64"],
                        })
                        existing_names.add(name)

            if known_speakers and not participant_speakers:
                logger.info(
                    "[WS][STT REFINE] session=%s conversation=%s using %s cross-session speaker references",
                    self.state.session_id,
                    self.state.conversation_id,
                    len(known_speakers),
                )

            if len(known_speakers) < 4:
                # Fall back to in-conversation confirmed speakers
                in_conversation_speaker_names = [s["name"] for s in known_speakers]
                
                utterance_stmt = (
                    select(Utterance)
                    .where(Utterance.conversation_id == self.state.conversation_id)
                    .where(Utterance.timestamp_start.is_not(None))
                    .where(Utterance.timestamp_end.is_not(None))
                    .order_by(Utterance.sequence_number.desc())
                )
                utterance_result = await self.session.execute(utterance_stmt)
                recent_utterances = list(utterance_result.scalars().all())

                confirmed_speaker_data: Dict[str, Utterance] = {}
                for u in recent_utterances:
                    if len(known_speakers) >= 4:
                        break
                    if u.speaker_id and u.speaker_name:
                        if u.speaker_name in in_conversation_speaker_names:
                            continue
                        if is_confirmed_speaker_name(speaker_id=u.speaker_id, speaker_name=u.speaker_name):
                            duration = (u.timestamp_end or 0) - (u.timestamp_start or 0)
                            if 2.0 <= duration <= 10.0:
                                if u.speaker_id not in confirmed_speaker_data:
                                    confirmed_speaker_data[u.speaker_id] = u

                for sid, u in confirmed_speaker_data.items():
                    if len(known_speakers) >= 4:
                        break
                    slice_bytes = await self.audio_storage.extract_audio_slice(
                    str(self.state.conversation_id),
                    u.timestamp_start,
                    u.timestamp_end,
                )
                if slice_bytes:
                    # Wrap raw PCM in WAV header before encoding
                    wav_header = pcm16le_to_wav(slice_bytes, effective_sample_rate_hz)
                    b64 = base64.b64encode(wav_header).decode("utf-8")
                    known_speakers.append({
                        "name": u.speaker_name,
                        "audio_base64": b64
                    })
            
            if known_speakers:
                logger.info(
                    "[WS][STT REFINE] session=%s conversation=%s adding %s known speaker references: %s",
                    self.state.session_id,
                    self.state.conversation_id,
                    len(known_speakers),
                    [s["name"] for s in known_speakers],
                )
        except Exception as exc:
            logger.warning("[WS][STT REFINE] Failed to gather known speaker references: %s", exc)

        # 3. Trigger transcription with (optional) known speakers
        timeout_seconds = getattr(self.stt_runtime, "timeout_seconds", 30.0) if self.stt_runtime else 30.0
        language = getattr(self.stt_runtime, "language", "") if self.stt_runtime else ""
        
        result = await transcribe_wav_stt_candidate(
            dict(self.refinement_candidate),
            wav_payload=wav_payload,
            sample_rate_hz=effective_sample_rate_hz,
            timeout_seconds=timeout_seconds,
            language=language,
            known_speakers=known_speakers if known_speakers else None,
        )
        if result.get("ok"):
            refinement_segments = result.get("segments") if isinstance(result.get("segments"), list) else []
            reconciliation_applied = False
            materialization_result = None
            if refinement_segments:
                materialization_result = await persist_speaker_refinement(
                    conversation_id=str(self.state.conversation_id or ""),
                    segments=refinement_segments,
                    source_text=source_text,
                    source_utterance_id=source_utterance_id,
                    window_timestamps=window_timestamps or {},
                    provider=str(result.get("provider") or "openai_audio"),
                    model=str(result.get("model") or ""),
                    transport=str(result.get("transport") or "openai_audio"),
                )
                reconciliation_applied = await self._apply_or_queue_speaker_reconciliation(
                    source_text,
                    refinement_segments,
                )
                # One-shot nudge: the first time diarization shows a 2nd
                # distinct speaker, tell the frontend so it can badge the
                # participants button. The picker no longer nags every
                # (usually solo) session — this re-surfaces it on demand.
                if not self._second_speaker_announced:
                    for _seg in refinement_segments:
                        _spk = str((_seg or {}).get("speaker") or "").strip()
                        if _spk:
                            self.seen_speaker_ids.add(_spk)
                    if len(self.seen_speaker_ids) >= 2:
                        self._second_speaker_announced = True
                        await _safe_send_json(
                            self.websocket,
                            {
                                "type": "second_speaker_detected",
                                "speaker_count": len(self.seen_speaker_ids),
                                "speaker_ids": sorted(self.seen_speaker_ids),
                            },
                        )
                        logger.info(
                            "[WS][SPEAKER] session=%s 2nd speaker detected speakers=%s",
                            self.state.session_id,
                            sorted(self.seen_speaker_ids),
                        )
            logger.info(
                "[WS][STT REFINE] session=%s conversation=%s provider=%s model=%s latency_ms=%s segments=%s reconciliation_applied=%s persisted_segments=%s updated_utterances=%s ambiguous_utterances=%s source_preview=%s",
                self.state.session_id,
                self.state.conversation_id,
                result.get("provider") or "openai_audio",
                result.get("model") or "-",
                result.get("latency_ms"),
                result.get("segments_count"),
                reconciliation_applied,
                (materialization_result or {}).get("persisted_segments"),
                (materialization_result or {}).get("updated_utterances"),
                (materialization_result or {}).get("ambiguous_utterances"),
                source_text[:160],
            )
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "info",
                    "message": "Background speaker refinement completed.",
                    "context": {
                        "stage": "stt_refinement",
                        "phase": "completed",
                        "provider": result.get("provider"),
                        "model": result.get("model"),
                        "latency_ms": result.get("latency_ms"),
                        "segments_count": result.get("segments_count"),
                        "reconciliation_applied": reconciliation_applied,
                        "persisted_segments": (materialization_result or {}).get("persisted_segments"),
                        "updated_utterances": (materialization_result or {}).get("updated_utterances"),
                        "ambiguous_utterances": (materialization_result or {}).get("ambiguous_utterances"),
                    },
                },
            )
            return

        logger.warning(
            "[WS][STT REFINE] session=%s conversation=%s provider=%s model=%s status=%s latency_ms=%s error=%s",
            self.state.session_id,
            self.state.conversation_id,
            result.get("provider") or "openai_audio",
            result.get("model") or "-",
            result.get("status") or "provider_error",
            result.get("latency_ms"),
            result.get("error") or "Unknown refinement error",
        )
        await _safe_send_json(
            self.websocket,
            {
                "type": "processing_status",
                "level": "warning",
                "message": "Background speaker refinement failed.",
                "context": {
                    "stage": "stt_refinement",
                    "phase": "error",
                    "provider": result.get("provider"),
                    "model": result.get("model"),
                    "latency_ms": result.get("latency_ms"),
                    "status": result.get("status"),
                    "error": result.get("error"),
                },
            },
        )

    async def _run_file_backed_refinement(
        self,
        wav_path: str,
        source_text: str,
    ) -> None:
        if not wav_path or not self.refinement_candidate:
            return
        try:
            wav_payload = await asyncio.to_thread(Path(wav_path).read_bytes)
        except Exception as exc:
            logger.warning(
                "[WS][STT REFINE FILE] session=%s conversation=%s wav_path=%s read failed: %s",
                self.state.session_id,
                self.state.conversation_id,
                wav_path,
                exc,
            )
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "warning",
                    "message": "Background speaker refinement could not read finalized audio.",
                    "context": {
                        "stage": "stt_refinement",
                        "phase": "read_audio_failed",
                        "wav_path": wav_path,
                        "error": str(exc),
                    },
                },
            )
            return
        await self._run_background_refinement(wav_payload, source_text)

    def _runtime_mode(self) -> str:
        return str(getattr(self.stt_runtime, "stt_mode", "backend_http") or "backend_http")

    # ------------------------------------------------------------------
    # Buffered refinement — accumulate audio for larger diarization windows
    # ------------------------------------------------------------------

    REFINEMENT_WINDOW_SECONDS = 120  # 2 minutes

    def _append_refinement_audio(
        self,
        wav_payload: bytes,
        text: str,
        sample_rate_hz: Optional[int] = None,
        window_timestamps: Optional[Dict[str, Any]] = None,
        source_utterance_id: Optional[str] = None,
    ) -> None:
        """Append a WAV chunk to the refinement buffer.

        WAV payloads have a 44-byte header; we strip it and accumulate raw
        PCM so the buffer can be wrapped in a single WAV header when flushed.
        """
        if not wav_payload or len(wav_payload) <= 44:
            return
        pcm_data = wav_payload[44:]  # strip WAV header
        self._refinement_pcm_buffer.extend(pcm_data)
        if text:
            self._refinement_text_parts.append(text)
        if sample_rate_hz:
            self._refinement_sample_rate_hz = sample_rate_hz
        if source_utterance_id:
            self._refinement_source_utterance_ids.add(str(source_utterance_id))

        timestamps = window_timestamps or {}
        start_s = timestamps.get("start")
        if start_s is None:
            start_s = timestamps.get("start_seconds")
        end_s = timestamps.get("end")
        if end_s is None:
            end_s = timestamps.get("end_seconds")
        if start_s is not None and (self._refinement_window_start is None or start_s < self._refinement_window_start):
            self._refinement_window_start = float(start_s)
        if end_s is not None and (self._refinement_window_end is None or end_s > self._refinement_window_end):
            self._refinement_window_end = float(end_s)

        self._ensure_refinement_timer()

    def _refinement_buffer_duration_seconds(self) -> float:
        """Estimate duration of buffered PCM in seconds."""
        if not self._refinement_pcm_buffer:
            return 0.0
        bytes_per_sample = 2  # int16
        return len(self._refinement_pcm_buffer) / (self._refinement_sample_rate_hz * bytes_per_sample)

    def _ensure_refinement_timer(self) -> None:
        """Start a timer to flush the refinement buffer if not already running."""
        if self._refinement_timer_task and not self._refinement_timer_task.done():
            return
        self._refinement_timer_task = asyncio.create_task(self._refinement_timer_loop())

    async def _refinement_timer_loop(self) -> None:
        """Periodically check if the refinement buffer should be flushed."""
        try:
            while True:
                await asyncio.sleep(10)  # check every 10s
                duration = self._refinement_buffer_duration_seconds()
                if duration >= self.REFINEMENT_WINDOW_SECONDS:
                    await self._flush_refinement_buffer(reason="window_full")
                    return
        except asyncio.CancelledError:
            return

    async def _flush_refinement_buffer(self, *, reason: str = "manual") -> None:
        """Convert buffered PCM to WAV and send to background refinement."""
        if not self._refinement_pcm_buffer or not self.refinement_candidate:
            return

        pcm_bytes = bytes(self._refinement_pcm_buffer)
        combined_text = " ".join(self._refinement_text_parts).strip()
        sample_rate = self._refinement_sample_rate_hz
        text_parts_count = len(self._refinement_text_parts)
        source_utterance_id = None
        if len(self._refinement_source_utterance_ids) == 1:
            source_utterance_id = next(iter(self._refinement_source_utterance_ids))
        window_timestamps = {}
        if self._refinement_window_start is not None:
            window_timestamps["start"] = self._refinement_window_start
        if self._refinement_window_end is not None:
            window_timestamps["end"] = self._refinement_window_end

        duration_s = self._refinement_buffer_duration_seconds()

        # Reset buffer
        self._refinement_pcm_buffer = bytearray()
        self._refinement_text_parts = []
        self._refinement_window_start = None
        self._refinement_window_end = None
        self._refinement_source_utterance_ids = set()
        if self._refinement_timer_task and not self._refinement_timer_task.done():
            self._refinement_timer_task.cancel()
        self._refinement_timer_task = None

        wav_payload = pcm16le_to_wav(pcm_bytes, sample_rate_hz=sample_rate)

        logger.info(
            "[WS][STT REFINE BUFFER] session=%s conversation=%s reason=%s duration_s=%.1f text_parts=%s pcm_bytes=%s",
            self.state.session_id,
            self.state.conversation_id,
            reason,
            duration_s,
            text_parts_count,
            len(pcm_bytes),
        )

        self._track_refinement_task(
            asyncio.create_task(
                self._run_background_refinement(
                    wav_payload,
                    combined_text,
                    source_utterance_id=source_utterance_id,
                    window_timestamps=window_timestamps,
                    sample_rate_hz=sample_rate,
                )
            )
        )

    async def _process_http_runtime_event(
        self,
        event: Dict[str, Any],
        *,
        audio_decode_ms: float,
    ) -> None:
        partial_text = str(event.get("text") or "").strip()
        if not partial_text:
            return

        partial_metadata = (
            event.get("metadata")
            if isinstance(event.get("metadata"), dict)
            else {}
        )
        refinement_wav = event.get("_wav_payload")
        event_timestamps = event.get("timestamps") if isinstance(event.get("timestamps"), dict) else {}
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
            timestamps=event_timestamps,
            emit_to_client=True,
        )
        self._merge_pending_partial_timestamps(event_timestamps)
        # Background refinement is intentionally skipped for partials — no utterance
        # exists yet, so persist_speaker_refinement would create orphaned segments.
        # Refinement fires on the final event (line ~970) which has a committed
        # utterance ID and complete audio window.
        self.pending_partial_parts.append(partial_text)
        self.pending_partial_chars += len(partial_text)

        chunk_segments = event.get("segments")
        if isinstance(chunk_segments, list):
            self.pending_speaker_segments.extend(chunk_segments)

        if _should_emit_final_segment(
            partial_text,
            self.pending_partial_parts,
            self.pending_partial_chars,
        ):
            final_text = " ".join(self.pending_partial_parts).strip()
            final_segments = self.pending_speaker_segments if self.pending_speaker_segments else None
            final_timestamps = self._consume_pending_partial_timestamps()
            await self._persist_event(
                "final",
                final_text,
                metadata={
                    **partial_metadata,
                    "aggregated_parts": len(self.pending_partial_parts),
                    "transport": "backend_http_stt",
                },
                timestamps=final_timestamps,
                emit_to_client=True,
                speaker_segments=final_segments,
            )
            self._reset_pending_partial_state()

    async def _process_streaming_runtime_event(
        self,
        event: Dict[str, Any],
        *,
        audio_decode_ms: float,
        process_final: bool,
    ) -> None:
        event_type = str(event.get("event_type") or "").strip().lower()
        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}

        if event_type == "status":
            self._record_observability_event(
                event_type="stt_runtime_status",
                stage="stt_realtime",
                level="info",
                message=str(event.get("message") or "Realtime STT status").strip(),
                context=metadata,
            )
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "info",
                    "message": str(event.get("message") or "Realtime STT status").strip(),
                    "context": {
                        "stage": "stt_realtime",
                        **metadata,
                    },
                },
            )
            return

        if event_type == "error":
            detail = str(event.get("detail") or "Realtime STT provider error").strip()
            await self._emit_ws_error(
                message_type="stt_provider_error",
                code=str(metadata.get("error_type") or "stt_realtime_provider_error"),
                detail=detail,
                stage="stt_realtime",
                level=str(metadata.get("level") or "error"),
                context=metadata,
            )
            return

        text_value = str(event.get("text") or "").strip()
        if not text_value:
            return

        decoded_ms = _coerce_latency_ms(audio_decode_ms)
        if decoded_ms is not None:
            existing_telemetry = (
                metadata.get("telemetry")
                if isinstance(metadata.get("telemetry"), dict)
                else {}
            )
            metadata["telemetry"] = {
                **existing_telemetry,
                "audio_decode_ms": decoded_ms,
            }

        if event_type == "partial":
            await self._persist_event(
                "partial",
                text_value,
                metadata=metadata,
                timestamps=event.get("timestamps") if isinstance(event.get("timestamps"), dict) else {},
                emit_to_client=True,
                process_final=False,
            )
            return

        if event_type == "final":
            speaker_segments = event.get("segments") if isinstance(event.get("segments"), list) else None
            event_timestamps = event.get("timestamps") if isinstance(event.get("timestamps"), dict) else {}
            persisted_event = await self._persist_event(
                "final",
                text_value,
                metadata=metadata,
                timestamps=event_timestamps,
                emit_to_client=True,
                process_final=process_final,
                speaker_segments=speaker_segments,
            )
            refinement_wav = event.get("_wav_payload")
            if isinstance(refinement_wav, (bytes, bytearray)) and self.refinement_candidate:
                self._append_refinement_audio(
                    bytes(refinement_wav),
                    text_value,
                    sample_rate_hz=metadata.get("sample_rate_hz"),
                    window_timestamps=event_timestamps,
                    source_utterance_id=str(getattr(persisted_event, "utterance_id", "") or "") or None,
                )
            return

    async def _process_audio_chunk(self, chunk_bytes: bytes, audio_decode_ms: float) -> None:
        if not chunk_bytes:
            logger.warning("[WS][AUDIO] session=%s conversation=%s empty chunk received, skipping", 
                        self.state.session_id, self.state.conversation_id)
            return

        logger.info("[WS][AUDIO] session=%s conversation=%s processing chunk bytes=%s store_audio=%s",
                  self.state.session_id, self.state.conversation_id, len(chunk_bytes), self.state.store_audio)

        if self.state.store_audio and self.state.conversation_id:
            logger.info("[WS][AUDIO] session=%s conversation=%s appending to PCM store bytes=%s",
                      self.state.session_id, self.state.conversation_id, len(chunk_bytes))
            try:
                await self.audio_storage.append_chunk(self.state.conversation_id, chunk_bytes)
            except Exception as exc:
                await self._emit_ws_error(
                    message_type="stt_provider_error",
                    code="audio_storage_append_failed",
                    detail=f"Audio storage append failed: {exc}",
                    stage="audio_storage",
                    level="error",
                    context={
                        "chunk_bytes": len(chunk_bytes),
                        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                    },
                )
                return
            logger.info("[WS][AUDIO] session=%s conversation=%s append complete, total stored so far=%s",
                      self.state.session_id, self.state.conversation_id,
                      self.audio_storage.get_status(self.state.conversation_id).get("bytes_written", 0))
            self._record_observability_event(
                event_type="audio_chunk_stored",
                stage="audio_storage",
                level="info",
                message="Stored audio chunk for session recording.",
                context={"chunk_bytes": len(chunk_bytes)},
                metrics={
                    "audio_decode_ms": audio_decode_ms,
                    "bytes_written": self.audio_storage.get_status(self.state.conversation_id).get("bytes_written", 0),
                },
            )

        if not self.stt_runtime or not self.stt_runtime.is_ready():
            if not self.stt_unready_notified:
                self.stt_unready_notified = True
                await self._emit_ws_error(
                    message_type="stt_provider_error",
                    code="stt_runtime_not_ready",
                    detail=(
                        f"Live STT runtime is not ready for provider '{self.state.provider}'. "
                        "Check runtime settings and provider connectivity."
                    ),
                    stage="stt_runtime",
                    level="error",
                    context={"stt_mode": self._runtime_mode()},
                )
            return

        # No-audio guard: a dead/muted mic streams silence to OpenAI exactly
        # like speech, and OpenAI bills every uploaded second. Stop forwarding
        # once a session is judged dead-silent; dormant the instant real audio
        # is heard, so genuine recordings (and their timestamps) are untouched.
        guard = self._no_audio_guard.observe(
            chunk_bytes,
            getattr(self.stt_runtime, "sample_rate_hz", 16000) or 16000,
        )
        if guard["warn"]:
            await self._emit_ws_error(
                message_type="stt_no_audio",
                code="no_audio_detected",
                detail="No audio detected — check that your microphone is working.",
                stage="audio_guard",
                level="warning",
                context={"silent_seconds": round(float(guard["silent_run_s"]), 1)},
            )
        if guard["stop"]:
            logger.warning(
                "[WS][AUDIO-GUARD] session=%s conversation=%s — no audio for %.0fs; "
                "halting STT forwarding to stop credit spend",
                self.state.session_id,
                self.state.conversation_id,
                float(guard["silent_run_s"]),
            )
            await self._emit_ws_error(
                message_type="stt_no_audio",
                code="no_audio_halted",
                detail=(
                    "No audio for an extended period — transcription paused so "
                    "credits aren't spent on silence. Speak or restart to resume."
                ),
                stage="audio_guard",
                level="warning",
                context={"silent_seconds": round(float(guard["silent_run_s"]), 1)},
            )
        if guard["auto_pause"]:
            logger.info(
                "[WS][AUDIO-GUARD] session=%s conversation=%s — %.0fs trailing silence "
                "after speech; signalling auto-pause to the client",
                self.state.session_id,
                self.state.conversation_id,
                float(guard["silent_run_s"]),
            )
            await _safe_send_json(
                self.websocket,
                {
                    "type": "auto_pause",
                    "reason": "trailing_silence",
                    "silent_seconds": round(float(guard["silent_run_s"]), 1),
                },
            )
        if not guard["forward"]:
            return

        async with self.stt_stream_lock:
            try:
                runtime_events = await self.stt_runtime.push_audio_chunk(chunk_bytes)
            except Exception as exc:
                runtime_metadata = (
                    self.stt_runtime.get_last_runtime_metadata()
                    if self.stt_runtime
                    else {}
                )
                attempt_log = runtime_metadata.get("attempts")
                logger.warning(
                    "[WS][STT] session=%s conversation=%s request failed provider=%s flow_ms=%s attempts=%s error=%s",
                    self.state.session_id,
                    self.state.conversation_id,
                    runtime_metadata.get("provider") or self.state.provider,
                    runtime_metadata.get("stt_flow_ms"),
                    json.dumps(attempt_log, separators=(",", ":")) if attempt_log else "[]",
                    exc,
                )
                await self._emit_ws_error(
                    message_type="stt_provider_error",
                    code="stt_request_failed",
                    detail=f"STT provider request failed: {exc}",
                    stage="stt_request",
                    level="error",
                    context={
                        "flow_ms": runtime_metadata.get("stt_flow_ms"),
                        "attempts": attempt_log or [],
                    },
                )
                return
            if not runtime_events:
                return

            for runtime_event in runtime_events:
                if self._runtime_mode() == "backend_http":
                    await self._process_http_runtime_event(runtime_event, audio_decode_ms=audio_decode_ms)
                else:
                    await self._process_streaming_runtime_event(
                        runtime_event,
                        audio_decode_ms=audio_decode_ms,
                        process_final=True,
                    )

    # ------------------------------------------------------------------
    # Post-flush background processing
    # ------------------------------------------------------------------

    async def _run_post_flush_processing(self) -> None:
        flush_started_at = time.perf_counter()
        flush_complete_sent = False
        try:
            if self.pending_stt_chunk_tasks:
                await asyncio.gather(
                    *list(self.pending_stt_chunk_tasks),
                    return_exceptions=True,
                )

            flush_final_metadata: Dict[str, Any] = {}
            final_text_for_post_flush: Optional[str] = None
            final_segments_for_post_flush: Optional[List[Dict[str, Any]]] = None
            final_utterance_id_for_post_flush: Optional[Any] = None

            if self.stt_runtime and self.stt_runtime.is_ready():
                async with self.stt_stream_lock:
                    stt_flush_started_at = time.perf_counter()
                    try:
                        final_events = await self.stt_runtime.flush()
                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                    except Exception as exc:
                        runtime_metadata = self.stt_runtime.get_last_runtime_metadata()
                        attempt_log = runtime_metadata.get("attempts")
                        logger.warning(
                            "[WS][STT] session=%s conversation=%s flush failed provider=%s flow_ms=%s attempts=%s error=%s",
                            self.state.session_id,
                            self.state.conversation_id,
                            runtime_metadata.get("provider") or self.state.provider,
                            runtime_metadata.get("stt_flow_ms"),
                            json.dumps(attempt_log, separators=(",", ":")) if attempt_log else "[]",
                            exc,
                        )
                        stt_flush_ms = _elapsed_ms(stt_flush_started_at)
                        await self._emit_ws_error(
                            message_type="stt_provider_error",
                            code="stt_flush_failed",
                            detail=f"STT flush failed: {exc}",
                            stage="stt_flush",
                            level="error",
                            context={
                                "flow_ms": runtime_metadata.get("stt_flow_ms"),
                                "attempts": attempt_log or [],
                            },
                        )
                        final_events = []

                    if self._runtime_mode() == "backend_http":
                        final_result = final_events[0] if final_events else None
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
                                flush_timestamps = (
                                    final_result.get("timestamps")
                                    if isinstance(final_result.get("timestamps"), dict)
                                    else {}
                                )
                                self.pending_partial_parts.append(final_text_piece)
                                self.pending_partial_chars += len(final_text_piece)
                                self._merge_pending_partial_timestamps(flush_timestamps)
                                flush_segments = final_result.get("segments")
                                if isinstance(flush_segments, list):
                                    self.pending_speaker_segments.extend(flush_segments)
                    else:
                        for runtime_event in final_events:
                            await self._process_streaming_runtime_event(
                                runtime_event,
                                audio_decode_ms=0.0,
                                process_final=True,
                            )

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
                final_timestamps = self._consume_pending_partial_timestamps()
                final_persist_event = await self._persist_event(
                    "final",
                    final_text,
                    metadata=final_event_metadata,
                    timestamps=final_timestamps,
                    emit_to_client=True,
                    process_final=False,
                    speaker_segments=flush_speaker_segments,
                )
                final_text_for_post_flush = final_text
                final_segments_for_post_flush = flush_speaker_segments
                # Option B: thread the persisted utterance UUID into the
                # post-flush processor call so the very last chunk also
                # links its utterances correctly.
                final_utterance_id_for_post_flush = getattr(
                    final_persist_event, "utterance_id", None
                )
                self._reset_pending_partial_state()

            if self.state.store_audio and self.state.conversation_id:
                logger.info("[WS][AUDIO] session=%s conversation=%s finalizing audio storage",
                          self.state.session_id, self.state.conversation_id)
                finalized = await self.audio_storage.finalize(self.state.conversation_id)
                logger.info("[WS][AUDIO] session=%s conversation=%s finalize result: %s",
                          self.state.session_id, self.state.conversation_id, finalized)
                self._record_observability_event(
                    event_type="audio_finalize",
                    stage="audio_storage",
                    level="info",
                    message="Finalized conversation audio artifacts.",
                    context=finalized,
                )
                audio_ready_payload: Dict[str, Any] = {
                    "type": "audio_ready",
                    "audio_paths": finalized,
                }
                if finalized.get("wav_path"):
                    if self.download_token:
                        audio_ready_payload["download_url"] = (
                            f"/api/conversations/{self.state.conversation_id}/audio?token={self.download_token}"
                        )
                    else:
                        audio_ready_payload["download_url"] = (
                            f"/api/conversations/{self.state.conversation_id}/audio"
                        )
                logger.info("[WS][AUDIO] session=%s conversation=%s sending audio_ready to client download_url=%s",
                          self.state.session_id, self.state.conversation_id, 
                          audio_ready_payload.get("download_url"))
                await _safe_send_json(self.websocket, audio_ready_payload)
                self._record_observability_event(
                    event_type="audio_ready",
                    stage="audio_storage",
                    level="info",
                    message="Sent audio_ready payload to client.",
                    context=audio_ready_payload,
                )
                finalized_wav_path = str(finalized.get("wav_path") or "").strip()
                source_text_for_file_refinement = (
                    final_text_for_post_flush or " ".join(self.session_final_text_parts).strip()
                )
                if (
                    finalized_wav_path
                    and source_text_for_file_refinement
                    and self.refinement_candidate
                    and self._runtime_mode() == "backend_ws"
                ):
                    self._track_refinement_task(
                        asyncio.create_task(
                            self._run_file_backed_refinement(
                                finalized_wav_path,
                                source_text_for_file_refinement,
                            )
                        )
                    )

            # Transcript delivery is complete at this point. Downstream graph
            # generation and persistence may continue in the background, but the
            # client can safely stop waiting for more transcript events.
            flush_complete_sent = await _safe_send_json(
                self.websocket,
                {
                    "type": "flush_complete",
                    "telemetry": {
                        "final_flush_total_ms": _elapsed_ms(flush_started_at),
                    },
                },
            )
            self._record_observability_event(
                event_type="flush_complete",
                stage="flush",
                level="info",
                message="Sent flush_complete to client.",
                metrics={"final_flush_total_ms": _elapsed_ms(flush_started_at)},
            )
            await self._record_durable_session_event(
                event_type="flush_complete",
                stage="flush",
                level="info",
                message="Sent flush_complete to client.",
                metrics={"final_flush_total_ms": _elapsed_ms(flush_started_at)},
            )
            self.flush_complete_sent = True

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
                        utterance_id=final_utterance_id_for_post_flush,
                    )
                await self.processor.flush()
                await self._clear_pending_draft_graph(reason="flush")
                # Post-streaming hierarchy consolidation (matches the import path
                # at import_bulk_pipeline.py:1145+). The streaming LLM authors
                # chunks (L1) + ideas (L2) only; this pass adds topics (L3),
                # themes (L4), and arcs (L5) so the macro view has content.
                # Failures are non-fatal — persist proceeds with whatever
                # tiers did materialize.
                await self._run_hierarchy_consolidation_locked()
                # ADR-032 Part D: semantic edge enrichment via the new
                # enrich_semantic_edges prompt, with IndrasNet retrieval
                # injecting cross-conversation context (Part E). Runs after
                # consolidation so it sees the full 5-tier graph. Failures
                # are non-fatal — without semantic edges, the conversation
                # still saves; edges just won't be there to author.
                await self._run_edge_enrichment_locked()
            await self._ensure_graph_persisted(reason="final_flush")
            # Live-linkage fix: nodes + utterances are now both persisted but
            # unlinked — reconcile them so speaker rollup / rename / audio-seek
            # work. Runs last; nothing re-persists after this.
            await self._run_utterance_node_reconciliation()
            # Single-speaker convenience: if diarization + the participant
            # picker agree there is exactly one person, name the utterances
            # automatically. Independent of the reconciler; neither re-persists.
            await self._run_participant_speaker_inference()

        except Exception as exc:
            logger.exception("[WS] Processor flush failed: %s", exc)
            self._record_observability_event(
                event_type="flush_error",
                stage="flush",
                level="error",
                message="Final flush failed while generating graph updates.",
                context={
                    "error": str(exc),
                    "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                },
            )
            await self._record_durable_session_event(
                event_type="flush_error",
                stage="flush",
                level="error",
                message="Final flush failed while generating graph updates.",
                code="flush_error",
                context={
                    "error": str(exc),
                },
            )
            self._mark_terminal_state(status="failed", reason="flush_error")
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "error",
                    "message": "Final flush failed while generating graph updates.",
                    "context": {"error": str(exc), "stage": "flush"},
                },
            )
        finally:
            if not flush_complete_sent:
                await _safe_send_json(
                    self.websocket,
                    {
                        "type": "flush_complete",
                        "telemetry": {
                            "final_flush_total_ms": _elapsed_ms(flush_started_at),
                        },
                    },
                )
            # Debit the STT quota for the audio this segment actually forwarded
            # to the provider (the no-audio guard halts forwarding on silence,
            # so silent stretches aren't charged).
            await self._record_stt_quota_usage()

    async def _record_stt_quota_usage(self) -> None:
        """Debit this segment's forwarded-audio time against the STT quota.

        QuotaService.check_quota runs at session start, but until now nothing
        debited usage — so the daily free limit never actually bit. BYOK
        sessions have unlimited quota and are skipped. Non-fatal.
        """
        if getattr(self, "_quota_is_byok", False):
            return
        forwarded_s = getattr(self._no_audio_guard, "forwarded_audio_s", 0.0)
        if forwarded_s <= 0:
            return
        minutes = forwarded_s / 60.0
        owner_id = getattr(self, "_quota_owner_id", "anonymous")
        try:
            await QuotaService(self.session).record_usage(
                owner_id=owner_id,
                quota_type="stt_live",
                minutes=minutes,
            )
            logger.info(
                "[WS][QUOTA] session=%s owner=%s — debited %.2f STT minutes (%.0fs forwarded)",
                self.state.session_id,
                owner_id,
                minutes,
                forwarded_s,
            )
        except Exception as quota_exc:
            logger.warning(
                "[WS][QUOTA] session=%s — record_usage failed: %s",
                self.state.session_id,
                quota_exc,
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
        if self.pending_refinement_tasks:
            for task in list(self.pending_refinement_tasks):
                task.cancel()
            await asyncio.gather(*list(self.pending_refinement_tasks), return_exceptions=True)
        self._reset_pending_partial_state()
        self.active_draft_graph = None
        self.pending_draft_replacements = []
        self.pending_speaker_reconciliations = []
        self.stt_unready_notified = False
        self.first_audio_chunk_logged = False
        self.refinement_candidate = None
        self.session_final_text_parts = []
        # Reset refinement buffer
        self._refinement_pcm_buffer = bytearray()
        self._refinement_text_parts = []
        self._refinement_window_start = None
        self._refinement_window_end = None
        self._refinement_source_utterance_ids = set()
        if self._refinement_timer_task and not self._refinement_timer_task.done():
            self._refinement_timer_task.cancel()
        self._refinement_timer_task = None
        self.first_graph_queued_at_ms = None
        self.first_graph_completed_at_ms = None
        self.flush_complete_sent = False
        self.session_terminal_status = "completed"
        self.session_terminal_reason = "completed"
        self.session_started_committed = False
        self.telemetry_state = {
            "audio_send_started_at_ms": None,
            "first_partial_at_ms": None,
            "first_final_at_ms": None,
        }

        conversation_id = payload.get("conversation_id")
        if not conversation_id:
            await self._emit_ws_error(
                code="protocol_missing_conversation_id",
                detail="Missing conversation_id",
                stage="session_meta",
                level="error",
                context={"required_field": "conversation_id"},
            )
            return

        stt_settings: Dict[str, Any] = {}
        try:
            stt_settings = await self._load_stt_settings(self.session)
        except Exception as exc:
            logger.warning("Unable to load STT settings during session setup: %s", exc)
            await _safe_send_json(
                self.websocket,
                {
                    "type": "processing_status",
                    "level": "warning",
                    "message": "Failed to load saved STT settings; continuing with runtime defaults.",
                    "context": {
                        "stage": "stt_setup",
                        "phase": "settings_load",
                        "error": str(exc),
                    },
                },
            )

        byok_session = None
        byok_session_token = str(payload.get("byok_session_token") or "").strip()
        if byok_session_token:
            try:
                byok_session = resolve_byok_session(
                    byok_session_token,
                    required_scope=BYOK_SCOPE_STT_LIVE,
                )
            except ByokSessionLookupError as exc:
                await self._emit_ws_error(
                    code="invalid_byok_session",
                    detail=str(exc),
                    stage="session_meta",
                    level="error",
                    context={"required_scope": BYOK_SCOPE_STT_LIVE},
                )
                return

        runtime_stt_settings = build_runtime_stt_settings_for_byok(
            stt_settings,
            byok_session,
        )
        self._runtime_llm_config = build_runtime_llm_config_for_byok(
            self._base_llm_config,
            byok_session,
            required_scope=BYOK_SCOPE_LLM_LIVE,
        )
        self._runtime_llm_providers = build_runtime_llm_providers_for_byok(
            self._base_llm_providers,
            byok_session,
            required_scope=BYOK_SCOPE_LLM_LIVE,
        )
        self._reset_processor()
        requested_provider = str(payload.get("provider") or "").strip().lower()
        if requested_provider in {"openai_audio", "openrouter_audio"}:
            normalized_provider = requested_provider
        else:
            normalized_provider = _normalize_provider(
                payload.get("provider"),
                runtime_stt_settings.get("provider"),
            )
        provider_http_urls = (
            runtime_stt_settings.get("provider_http_urls")
            if isinstance(runtime_stt_settings.get("provider_http_urls"), dict)
            else {}
        )
        provider_http_url = str(
            payload.get("provider_http_url")
            or provider_http_urls.get(normalized_provider)
            or runtime_stt_settings.get("http_url")
            or ""
        ).strip()
        stt_candidates = resolve_live_stt_candidates(
            settings=runtime_stt_settings,
            provider_override=requested_provider or payload.get("provider"),
        )
        primary_candidate = stt_candidates[0] if stt_candidates else {}
        self.refinement_candidate = build_live_stt_background_refinement_candidate(
            settings=runtime_stt_settings,
            primary_candidate=primary_candidate,
        )
        active_provider = str(primary_candidate.get("provider") or normalized_provider).strip() or normalized_provider
        active_transport = str(primary_candidate.get("transport") or "backend_http").strip() or "backend_http"
        active_model = str(
            primary_candidate.get("model")
            or runtime_stt_settings.get("http_model")
            or ""
        ).strip()
        active_supports_diarization = bool(
            primary_candidate.get("supports_diarization")
            if primary_candidate.get("supports_diarization") is not None
            else active_provider == "whisper"
        )
        provider_http_url = str(
            primary_candidate.get("http_url")
            or primary_candidate.get("base_url")
            or provider_http_url
        ).strip()

        self.state.conversation_id = conversation_id
        self.state.session_id = payload.get("session_id") or str(uuid.uuid4())
        self.state.provider = active_provider
        default_store_audio = bool(runtime_stt_settings.get("store_audio")) or bool(self.refinement_candidate)
        force_store_audio_for_backend_refinement = bool(
            self.refinement_candidate
            and str(primary_candidate.get("provider") or "").strip().lower() == "whisper"
            and str(primary_candidate.get("ws_url") or "").strip()
        )
        self.state.store_audio = bool(payload.get("store_audio", default_store_audio)) or (
            force_store_audio_for_backend_refinement
        )
        logger.info("[WS][SESSION] session=%s conversation=%s store_audio decision: payload=%s default=%s force=%s final=%s",
                  self.state.session_id, self.state.conversation_id,
                  payload.get("store_audio"), default_store_audio, 
                  force_store_audio_for_backend_refinement, self.state.store_audio)
        self.state.speaker_id = payload.get("speaker_id", self.state.speaker_id)
        self.state.metadata = payload.get("metadata") or {}
        if byok_session:
            self.state.metadata = {
                **(self.state.metadata if isinstance(self.state.metadata, dict) else {}),
                "byok_provider": str(byok_session.get("provider") or ""),
                "byok_llm_enabled": BYOK_SCOPE_LLM_LIVE in set(byok_session.get("scopes") or set()),
            }
        await ensure_conversation(self.session, conversation_id, self.state.metadata or {})
        # Segment-and-stitch resume detection: if this conversation already
        # has graph nodes, a prior recording segment was persisted here and
        # this WS session is a RESUME. Freeze that segment so the live
        # graph-persist scopes its destructive delete around it.
        await self._detect_resume(conversation_id)
        # Tell the client the conversation row exists. The participant
        # picker waits for this before opening so its PUT can't 404 on
        # a row that doesn't exist yet.
        await _safe_send_json(
            self.websocket,
            {
                "type": "session_started",
                "conversation_id": str(conversation_id),
                "session_id": str(self.state.session_id),
            },
        )
        start_observed_session(
            conversation_id=str(self.state.conversation_id),
            session_id=str(self.state.session_id),
            metadata={
                "requested_provider": requested_provider,
                "store_audio_requested": bool(payload.get("store_audio")),
                "metadata": self.state.metadata,
            },
        )

        requested_sample_rate_hz = _safe_int(
            payload.get("sample_rate_hz") or runtime_stt_settings.get("sample_rate_hz"),
            16000,
        )
        chunk_seconds = _safe_float(
            payload.get("http_chunk_seconds") or runtime_stt_settings.get("http_chunk_seconds"),
            1.2,
        )
        timeout_seconds = _safe_float(runtime_stt_settings.get("http_timeout_seconds"), 30.0)
        http_model = str(runtime_stt_settings.get("http_model") or "")
        http_language = str(payload.get("http_language") or runtime_stt_settings.get("http_language") or "")

        self.stt_runtime = build_live_stt_runtime(
            provider=active_provider,
            http_url=provider_http_url,
            sample_rate_hz=requested_sample_rate_hz,
            chunk_seconds=chunk_seconds,
            timeout_seconds=timeout_seconds,
            model=http_model,
            language=http_language,
            candidates=stt_candidates,
            session_id=self.state.session_id,
            conversation_id=conversation_id,
            prefer_streaming=True,
        )

        runtime_start_error: Optional[str] = None
        try:
            await self.stt_runtime.start()
        except Exception as exc:
            runtime_start_error = str(exc)
            logger.warning(
                "[WS][STT SETUP] session=%s conversation=%s realtime runtime start failed: %s",
                self.state.session_id,
                conversation_id,
                exc,
            )
            self.stt_runtime = build_live_stt_runtime(
                provider=active_provider,
                http_url=provider_http_url,
                sample_rate_hz=requested_sample_rate_hz,
                chunk_seconds=chunk_seconds,
                timeout_seconds=timeout_seconds,
                model=http_model,
                language=http_language,
                candidates=stt_candidates,
                session_id=self.state.session_id,
                conversation_id=conversation_id,
                prefer_streaming=False,
            )
            try:
                await self.stt_runtime.start()
            except Exception as fallback_exc:
                runtime_start_error = f"{runtime_start_error}; http_fallback_failed={fallback_exc}"

        logger.info(
            "[WS][STT SETUP] session=%s conversation=%s provider=%s transport=%s mode=%s ready=%s sample_rate_hz=%s refinement=%s candidates=%s runtime_error=%s",
            self.state.session_id,
            conversation_id,
            getattr(self.stt_runtime, "provider", active_provider),
            getattr(self.stt_runtime, "transport", active_transport),
            self._runtime_mode(),
            bool(self.stt_runtime.is_ready()),
            getattr(self.stt_runtime, "sample_rate_hz", requested_sample_rate_hz),
            json.dumps(
                {
                    "enabled": bool(self.refinement_candidate),
                    "provider": str((self.refinement_candidate or {}).get("provider") or ""),
                    "model": str((self.refinement_candidate or {}).get("model") or ""),
                },
                separators=(",", ":"),
            ),
            json.dumps(
                [
                    {
                        "route_id": str(candidate.get("route_id") or ""),
                        "provider": str(candidate.get("provider") or ""),
                        "transport": str(candidate.get("transport") or ""),
                        "endpoint": str(candidate.get("http_url") or candidate.get("base_url") or ""),
                        "reason": str(candidate.get("reason") or ""),
                        "degraded": bool(candidate.get("degraded")),
                    }
                    for candidate in stt_candidates
                ],
                separators=(",", ":"),
            ),
            runtime_start_error or "-",
        )

        # Check quota before allowing session
        quota_info = {}
        # ADR-034 §F hazard #2: owner from the authenticated session, not the
        # client-supplied WS metadata (spoofable). resolve_owner_id ignores the
        # passed value today; post-OAuth it returns the session owner.
        owner_id = resolve_owner_id((self.state.metadata or {}).get("owner_id"))
        is_byok = bool(byok_session and byok_session.get("api_key"))
        # Remembered for the post-flush quota debit (see _record_stt_quota_usage).
        self._quota_owner_id = owner_id
        self._quota_is_byok = is_byok
        
        try:
            quota_service = QuotaService(self.session)
            quota_result = await quota_service.check_quota(
                owner_id=owner_id,
                quota_type="stt_live",
                is_byok=is_byok,
            )
            quota_info = {
                "quota_allowed": quota_result.allowed,
                "quota_remaining_minutes": quota_result.remaining_minutes,
                "quota_limit_minutes": quota_result.limit_minutes,
                "quota_percent_used": quota_result.percent_used,
                "quota_warning": quota_result.warning,
                "quota_message": quota_result.message,
            }
            if not quota_result.allowed:
                logger.warning("[WS][QUOTA] session=%s owner=%s quota exceeded - blocking session", 
                    self.state.session_id, owner_id)
        except Exception as quota_exc:
            logger.warning("[WS][QUOTA] session=%s quota check failed: %s", self.state.session_id, quota_exc)

        await self.websocket.send_json({
            "type": "session_ack",
            "conversation_id": conversation_id,
            "session_id": self.state.session_id,
            "store_audio": self.state.store_audio,
            "provider": getattr(self.stt_runtime, "provider", active_provider),
            "transport": getattr(self.stt_runtime, "transport", active_transport),
            "model": getattr(self.stt_runtime, "model", active_model) or active_model or None,
            "model_source": "configured_override" if active_model else "server_default",
            "supports_diarization": bool(getattr(self.stt_runtime, "supports_diarization", active_supports_diarization)),
            "degraded": bool(primary_candidate.get("degraded")),
            "provider_http_url": provider_http_url or None,
            "stt_mode": self._runtime_mode(),
            "stt_ready": bool(self.stt_runtime.is_ready()),
            "runtime_error": runtime_start_error,
            "quota": quota_info,
            "background_refinement": {
                "enabled": bool(self.refinement_candidate),
                "provider": str((self.refinement_candidate or {}).get("provider") or "") or None,
                "model": str((self.refinement_candidate or {}).get("model") or "") or None,
            },
            "fallback_candidates": [
                {
                    "route_id": str(candidate.get("route_id") or ""),
                    "provider": str(candidate.get("provider") or ""),
                    "transport": str(candidate.get("transport") or ""),
                    "reason": str(candidate.get("reason") or ""),
                    "degraded": bool(candidate.get("degraded")),
                }
                for candidate in stt_candidates[1:]
            ],
        })
        self._record_observability_event(
            event_type="session_ack",
            stage="stt_setup",
            level="warning" if runtime_start_error else "info",
            message="Live STT session initialized.",
            context={
                "provider": getattr(self.stt_runtime, "provider", active_provider),
                "transport": getattr(self.stt_runtime, "transport", active_transport),
                "stt_mode": self._runtime_mode(),
                "stt_ready": bool(self.stt_runtime.is_ready()),
                "runtime_error": runtime_start_error,
                "background_refinement_enabled": bool(self.refinement_candidate),
                "fallback_candidates": [
                    {
                        "route_id": str(candidate.get("route_id") or ""),
                        "provider": str(candidate.get("provider") or ""),
                        "transport": str(candidate.get("transport") or ""),
                        "degraded": bool(candidate.get("degraded")),
                    }
                    for candidate in stt_candidates
                ],
            },
)
        await start_thread_session(
            self.session,
            conversation_id=self.state.conversation_id,
            session_id=self.state.session_id,
            owner_id=resolve_owner_id((self.state.metadata or {}).get("owner_id")),
            entrypoint="live_threads",
            client_metadata={
                "visibility": str((self.state.metadata or {}).get("visibility") or "private"),
            },
            session_metadata={
                "store_audio": self.state.store_audio,
                "background_refinement_enabled": bool(self.refinement_candidate),
            },
            stt_provider=getattr(self.stt_runtime, "provider", active_provider),
            stt_transport=getattr(self.stt_runtime, "transport", active_transport),
            runtime_mode=self._runtime_mode(),
        )
        await self._record_durable_session_event(
            event_type="session_ack",
            stage="stt_setup",
            level="warning" if runtime_start_error else "info",
            message="Live STT session initialized.",
            code="runtime_start_warning" if runtime_start_error else "session_started",
            context={
                "stt_ready": bool(self.stt_runtime.is_ready()),
                "runtime_error": runtime_start_error,
            },
        )
        await self.session.commit()
        self.session_started_committed = True

        if runtime_start_error:
            await self._emit_ws_error(
                message_type="stt_provider_error",
                code="stt_runtime_start_failed",
                detail=runtime_start_error,
                stage="stt_setup",
                level="warning" if self.stt_runtime and self.stt_runtime.is_ready() else "error",
                context={
                    "stt_mode": self._runtime_mode(),
                    "fallback_ready": bool(self.stt_runtime and self.stt_runtime.is_ready()),
                },
            )

    async def handle_audio_chunk(self, payload: Dict[str, Any]) -> None:
        """Handle ``audio_chunk`` message."""
        if not self.state.conversation_id:
            await self._emit_ws_error(
                code="protocol_missing_session_meta",
                detail="session_meta must be sent first",
                stage="audio_chunk",
                level="error",
                context={"expected_message_type": "session_meta"},
            )
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
            await self._emit_ws_error(
                code="invalid_audio_chunk",
                detail=str(exc),
                stage="audio_chunk",
                level="error",
            )
            return

        audio_decode_ms = _elapsed_ms(decode_started_at)
        if not chunk_bytes:
            return

        if not self.first_audio_chunk_logged:
            self.first_audio_chunk_logged = True
            logger.info(
                "[WS][AUDIO] session=%s conversation=%s first_chunk_received_at_ms=%s chunk_bytes=%s audio_decode_ms=%s",
                self.state.session_id,
                self.state.conversation_id,
                _now_ms(),
                len(chunk_bytes),
                audio_decode_ms,
            )
            self._record_observability_event(
                event_type="first_audio_chunk",
                stage="audio_chunk",
                level="info",
                message="Received first audio chunk for live session.",
                context={"chunk_bytes": len(chunk_bytes)},
                metrics={"audio_decode_ms": audio_decode_ms},
            )
            await self._record_durable_session_event(
                event_type="first_audio_chunk",
                stage="audio_chunk",
                level="info",
                message="Received first audio chunk for live session.",
                context={"chunk_bytes": len(chunk_bytes)},
                metrics={"audio_decode_ms": audio_decode_ms},
            )

        self._track_stt_chunk_task(
            asyncio.create_task(self._process_audio_chunk(chunk_bytes, audio_decode_ms))
        )

    async def handle_transcript_event(self, payload: Dict[str, Any], msg_type: str) -> None:
        """Handle ``transcript_partial`` / ``transcript_final`` messages."""
        if not self.state.conversation_id:
            await self._emit_ws_error(
                code="protocol_missing_session_meta",
                detail="session_meta must be sent first",
                stage="transcript_event",
                level="error",
                context={"expected_message_type": "session_meta", "received_message_type": msg_type},
            )
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
            speaker_segments=payload.get("segments") if isinstance(payload.get("segments"), list) else None,
        )

    async def handle_final_flush(self, payload: Dict[str, Any]) -> None:
        """Handle ``final_flush`` message — drain STT, persist, run processor."""
        if not self.state.conversation_id:
            await self._emit_ws_error(
                code="protocol_missing_session_meta",
                detail="session_meta must be sent first",
                stage="final_flush",
                level="error",
                context={"expected_message_type": "session_meta"},
            )
            return
        self.stt_flush_requested = True
        # Flush any buffered refinement audio before closing
        await self._flush_refinement_buffer(reason="session_flush")
        logger.info(
            "[WS][FLUSH] session=%s conversation=%s pending_stt_chunks=%s pending_partial_parts=%s",
            self.state.session_id,
            self.state.conversation_id,
            len(self.pending_stt_chunk_tasks),
            len(self.pending_partial_parts),
        )
        flush_stage_metrics: Dict[str, Any] = {
            "pending_stt_chunks": len(self.pending_stt_chunk_tasks),
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
        self._record_observability_event(
            event_type="flush_ack",
            stage="flush",
            level="info",
            message="Acknowledged final flush request.",
            context={"pending_stt_chunks": len(self.pending_stt_chunk_tasks)},
        )
        self._track_background_task(asyncio.create_task(self._run_post_flush_processing()))

    # ------------------------------------------------------------------
    # Main message loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Receive and dispatch WebSocket messages until disconnection."""
        try:
            while True:
                message = await self.websocket.receive_text()
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError as exc:
                    await self._emit_ws_error(
                        code="invalid_json",
                        detail=f"Malformed JSON websocket payload: {exc.msg}",
                        stage="websocket_message",
                        level="error",
                        context={"payload_preview": message[:160]},
                    )
                    continue
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
                    self._record_observability_event(
                        event_type="client_log",
                        stage="client",
                        level="info",
                        message=str(payload.get("message") or ""),
                    )
                    await self._record_durable_session_event(
                        event_type="client_log",
                        stage="client",
                        level="info",
                        message=str(payload.get("message") or ""),
                    )
                elif msg_type == "ping":
                    await self.websocket.send_json(
                        {
                            "type": "pong",
                            "client_ts_ms": payload.get("client_ts_ms"),
                            "server_ts_ms": _now_ms(),
                        }
                    )
                elif msg_type == "graph_data_update":
                    pass  # client-side graph sync — acknowledged, no action needed
                else:
                    await self._emit_ws_error(
                        code="unsupported_message_type",
                        detail=f"Unsupported websocket message type: {msg_type}",
                        stage="websocket_message",
                        level="error",
                        context={"received_message_type": msg_type},
                    )

        except WebSocketDisconnect:
            logger.info("[WS] Client disconnected")
            self._mark_terminal_state(status="abandoned", reason="client_disconnect")
        except RuntimeError as exc:
            if "WebSocket is not connected" in str(exc):
                logger.info("[WS] Client disconnected")
                self._mark_terminal_state(status="abandoned", reason="websocket_not_connected")
            else:
                logger.exception("[WS] Runtime error in transcript websocket: %s", exc)
                self._mark_terminal_state(status="failed", reason="internal_runtime_error")
                await self._emit_ws_error(
                    code="internal_runtime_error",
                    detail="Internal server error",
                    stage="websocket_loop",
                    level="error",
                    fatal=True,
                )
                if _ws_is_connected(self.websocket):
                    try:
                        await self.websocket.close(code=1011)
                    except RuntimeError:
                        pass
        except Exception as exc:
            logger.exception("[WS] Error processing transcript websocket: %s", exc)
            self._mark_terminal_state(status="failed", reason="internal_server_error")
            await self._emit_ws_error(
                code="internal_server_error",
                detail="Internal server error",
                stage="websocket_loop",
                level="error",
                fatal=True,
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
            if self.pending_refinement_tasks:
                # Let committed refinement windows finish so disconnecting after
                # final_flush does not discard diarization evidence.
                await asyncio.gather(*list(self.pending_refinement_tasks), return_exceptions=True)
            if self.graph_persist_task and not self.graph_persist_task.done():
                await asyncio.gather(self.graph_persist_task, return_exceptions=True)
            if self.stt_runtime:
                try:
                    await self.stt_runtime.close()
                except Exception as exc:
                    logger.debug("[WS] stt_runtime.close() failed: %s", exc)
                    self._record_observability_event(
                        event_type="runtime_close_error",
                        stage="stt_runtime",
                        level="warning",
                        message="Failed closing STT runtime.",
                        context={"error": str(exc)},
                    )
            finish_observed_session(
                conversation_id=str(self.state.conversation_id or ""),
                session_id=str(self.state.session_id or ""),
                status=self._classify_terminal_state()[0],
                metadata={
                    "provider": self._active_provider(),
                    "transport": self._active_transport(),
                    "runtime_mode": self._runtime_mode(),
                    "first_graph_queued_at_ms": self.first_graph_queued_at_ms,
                    "first_graph_completed_at_ms": self.first_graph_completed_at_ms,
                    "audio_send_started_at_ms": self.telemetry_state.get("audio_send_started_at_ms"),
                    "first_partial_at_ms": self.telemetry_state.get("first_partial_at_ms"),
                    "first_final_at_ms": self.telemetry_state.get("first_final_at_ms"),
                },
            )
            if self.state.conversation_id and self.state.session_id:
                final_status, final_reason = self._classify_terminal_state()
                await self._record_durable_session_event(
                    event_type="session_ended",
                    stage="disconnect",
                    level="error" if final_status == "failed" else "info",
                    message="Live Threads session ended.",
                    code=final_reason,
                    context={
                        "status": final_status,
                        "reason": final_reason,
                        "flush_complete_sent": self.flush_complete_sent,
                    },
                )
                await finish_thread_session(
                    self.session,
                    conversation_id=self.state.conversation_id,
                    session_id=self.state.session_id,
                    status=final_status,
                    terminal_reason=final_reason,
                    session_metadata={
                        "provider": self._active_provider(),
                        "transport": self._active_transport(),
                        "runtime_mode": self._runtime_mode(),
                        "first_graph_queued_at_ms": self.first_graph_queued_at_ms,
                        "first_graph_completed_at_ms": self.first_graph_completed_at_ms,
                        "audio_send_started_at_ms": self.telemetry_state.get("audio_send_started_at_ms"),
                        "first_partial_at_ms": self.telemetry_state.get("first_partial_at_ms"),
                        "first_final_at_ms": self.telemetry_state.get("first_final_at_ms"),
                        "flush_complete_sent": self.flush_complete_sent,
                    },
                    stt_provider=self._active_provider(),
                    stt_transport=self._active_transport(),
                    runtime_mode=self._runtime_mode(),
                )
                await self.session.commit()

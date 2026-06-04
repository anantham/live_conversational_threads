"""Transcript processing facade — public API surface.

This module re-exports symbols from the decomposed sub-modules so that all
existing ``from lct_python_backend.services.transcript_processing import X``
statements continue to work unchanged.

Sub-modules:
  transcript_prompts      — prompt constants
  transcript_normalizer   — output normalization helpers
  transcript_llm_callers  — LLM API call functions
"""

import asyncio
import inspect
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Re-exports: prompts
# ---------------------------------------------------------------------------
from lct_python_backend.services.transcript_prompts import (  # noqa: F401
    ACCUMULATE_SYSTEM_PROMPT,
    GENERATE_LCT_PROMPT,
    LOCAL_GENERATE_LCT_PROMPT,
)

# ---------------------------------------------------------------------------
# Re-exports: normalizer
# ---------------------------------------------------------------------------
from lct_python_backend.services.transcript_normalizer import (  # noqa: F401
    _normalize_generated_output,
    format_speaker_prefixed_transcript,
)

# ---------------------------------------------------------------------------
# Re-exports: LLM callers (+ config helpers used by tests)
# ---------------------------------------------------------------------------
from lct_python_backend.services.transcript_llm_callers import (  # noqa: F401
    _resolve_gemini_api_key,
    _resolve_llm_config,
    _resolve_online_gemini_model,
    accumulate_text_json,
    accumulate_text_json_local_indexed,
    generate_lct_json,
)

logger = logging.getLogger("lct_backend")


class TranscriptProcessor:
    def __init__(
        self,
        send_update,
        send_status: Optional[Callable[[str, str, Dict[str, Any]], Awaitable[None]]] = None,
        batch_size: int = 4,
        initial_batch_size: int = 1,
        max_batch_size: int = 12,
        graph_first_update_max_wait_ms: int = 3000,
        graph_steady_update_max_wait_ms: int = 5000,
        graph_min_flush_chars: int = 80,
        early_batch_targets: Optional[List[int]] = None,
        llm_config: Optional[Dict[str, Any]] = None,
        providers: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.accumulator: List[str] = []
        self.accumulator_segments: List[List[Dict[str, Any]]] = []
        # Parallel to ``accumulator``: each slot holds the utterance UUIDs whose
        # text contributed to that accumulator entry. A slot may be empty if the
        # caller didn't supply an utterance_id (e.g. bulk-import path which
        # writes utterances *after* chunking). On chunk emission, all ids from
        # the batch flow into ``chunk_utterance_map`` and each emitted node's
        # ``utterance_ids`` field — this is the canonical link the live STT path
        # was missing pre-Option-B.
        self.accumulator_utterance_ids: List[List[Any]] = []
        self.existing_json: List[Dict[str, Any]] = []
        self.chunk_dict: Dict[str, str] = {}
        # chunk_id (str) -> list of utterance UUID strings that contributed.
        # Snapshot of this mapping is passed to ``persist_graph`` so the live
        # path can UPDATE utterances.chunk_id and populate node.utterance_ids
        # the same way the bulk-import path does (see ADR-030 §P5).
        self.chunk_utterance_map: Dict[str, List[str]] = {}
        self.base_batch_size = batch_size
        self.initial_batch_size = max(1, min(initial_batch_size, batch_size))
        self.max_batch_size = max_batch_size
        self._current_batch_size = self.initial_batch_size
        self.graph_first_update_max_wait_ms = max(0, int(graph_first_update_max_wait_ms))
        self.graph_steady_update_max_wait_ms = max(0, int(graph_steady_update_max_wait_ms))
        self.graph_min_flush_chars = max(0, int(graph_min_flush_chars))
        configured_targets = early_batch_targets or [
            self.initial_batch_size,
            self.initial_batch_size,
            min(2, self.base_batch_size),
            min(2, self.base_batch_size),
        ]
        self._early_batch_targets = [
            max(1, min(int(target), self.base_batch_size))
            for target in configured_targets
        ] or [self.initial_batch_size]
        self._continue_accumulating = True
        self._send_update = send_update
        self._send_update_accepts_patch = False
        if send_update is not None:
            try:
                self._send_update_accepts_patch = "patch" in inspect.signature(send_update).parameters
            except (TypeError, ValueError):
                self._send_update_accepts_patch = False
        self._send_status = send_status
        self._llm_config = _resolve_llm_config(llm_config)
        self._providers = providers
        self._last_llm_backend: Optional[str] = None
        self._graph_update_count = 0
        self._pending_since_perf: Optional[float] = None
        self._batch_timer_task: Optional["asyncio.Task[None]"] = None
        self._state_lock = asyncio.Lock()

    @property
    def last_llm_backend(self) -> Optional[str]:
        """Return the backend label of the last successful LLM call."""
        return self._last_llm_backend

    @staticmethod
    def _split_segments_for_completed_chunk(
        text_batch: List[str],
        segment_batch: List[List[Dict[str, Any]]],
        completed_text: str,
        incomplete_text: str,
        stop_accumulating_flag: bool,
    ) -> Tuple[List[Dict[str, Any]], List[List[Dict[str, Any]]]]:
        if not segment_batch:
            return [], []

        flattened_segments: List[Dict[str, Any]] = []
        for seg_list in segment_batch:
            if isinstance(seg_list, list):
                flattened_segments.extend(seg_list)

        if not flattened_segments:
            return [], []

        if stop_accumulating_flag or not str(incomplete_text or "").strip():
            return flattened_segments, []

        input_text = " ".join(text_batch)
        completed_chars = max(0, len(input_text) - len(str(incomplete_text or "")))
        if completed_chars <= 0:
            return [], [flattened_segments]

        completed_segments: List[Dict[str, Any]] = []
        carryover_segments: List[Dict[str, Any]] = []
        consumed_chars = 0

        for segment in flattened_segments:
            segment_text = str(segment.get("text", "")).strip()
            segment_len = len(segment_text)
            segment_cost = segment_len + (1 if segment_len > 0 else 0)

            if consumed_chars + segment_len <= completed_chars:
                completed_segments.append(segment)
            else:
                carryover_segments.append(segment)
            consumed_chars += segment_cost

        if completed_segments:
            return completed_segments, [carryover_segments] if carryover_segments else []

        return [], [flattened_segments]

    async def _emit_status(self, level: str, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        if not self._send_status:
            return
        payload = context or {}
        try:
            await self._send_status(level, message, payload)
        except Exception as exc:
            logger.debug("[PROCESSOR STATUS] failed to send status update: %s", exc)

    async def _emit_graph_update(
        self,
        *,
        patch: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self._send_update:
            return
        if self._send_update_accepts_patch:
            await self._send_update(self.existing_json, self.chunk_dict, patch=patch)
            return
        await self._send_update(self.existing_json, self.chunk_dict)

    def _current_queue_wait_ms(self) -> Optional[float]:
        if self._pending_since_perf is None:
            return None
        return round(max(0.0, (time.perf_counter() - self._pending_since_perf) * 1000.0), 2)

    def _current_batch_target(self) -> int:
        if self._graph_update_count < len(self._early_batch_targets):
            return self._early_batch_targets[self._graph_update_count]
        return min(self.base_batch_size, self.max_batch_size)

    def _current_graph_wait_budget_ms(self) -> int:
        return (
            self.graph_first_update_max_wait_ms
            if self._graph_update_count == 0
            else self.graph_steady_update_max_wait_ms
        )

    def _cancel_batch_timer_locked(self) -> None:
        if self._batch_timer_task and not self._batch_timer_task.done():
            self._batch_timer_task.cancel()
        self._batch_timer_task = None

    def _ensure_batch_timer_locked(self) -> None:
        if self._batch_timer_task or not self.accumulator or not self._continue_accumulating:
            return
        timeout_ms = self._current_graph_wait_budget_ms()
        if timeout_ms <= 0:
            return
        pending_started_at = self._pending_since_perf
        elapsed_ms = self._current_queue_wait_ms() or 0.0
        remaining_ms = max(0.0, float(timeout_ms) - float(elapsed_ms))
        self._batch_timer_task = asyncio.create_task(
            self._run_batch_timer(remaining_ms, timeout_ms, pending_started_at)
        )

    async def _run_batch_timer(
        self,
        sleep_ms: float,
        timeout_ms: int,
        pending_started_at: Optional[float],
    ) -> None:
        try:
            await asyncio.sleep(max(0.0, sleep_ms) / 1000.0)
        except asyncio.CancelledError:
            return

        async with self._state_lock:
            if self._batch_timer_task is not asyncio.current_task():
                return
            self._batch_timer_task = None
            if (
                not self.accumulator
                or not self._continue_accumulating
                or pending_started_at is None
                or self._pending_since_perf != pending_started_at
            ):
                return

            pending_chars = sum(len(str(item or "")) for item in self.accumulator)

            # Don't force-flush tiny fragments — wait for more speech
            if pending_chars < self.graph_min_flush_chars:
                await self._emit_status(
                    "info",
                    "Timer fired but text too short; waiting for more speech.",
                    {
                        "stage": "graph",
                        "phase": "waiting",
                        "pending_chars": pending_chars,
                        "min_flush_chars": self.graph_min_flush_chars,
                        "queue_wait_ms": self._current_queue_wait_ms(),
                        "trigger": "timer_deferred",
                    },
                )
                # Schedule a fresh retry with a fixed backoff (2s) instead of
                # re-using _ensure_batch_timer_locked which computes remaining_ms=0
                # when the original budget is exhausted, causing a tight spin loop.
                if not self._batch_timer_task or self._batch_timer_task.done():
                    self._batch_timer_task = asyncio.create_task(
                        self._run_batch_timer(2000.0, timeout_ms, pending_started_at)
                    )
                return

            await self._emit_status(
                "info",
                "Graph batch waited long enough; forcing an incremental update.",
                {
                    "stage": "graph",
                    "phase": "queued",
                    "queued_finals": len(self.accumulator),
                    "batch_target": self._current_batch_size,
                    "pending_chars": pending_chars,
                    "queue_wait_ms": self._current_queue_wait_ms(),
                    "max_wait_ms": timeout_ms,
                    "trigger": "timer",
                },
            )
            await self._process_batches_locked(trigger="timer", force_flush=True)
            if self.accumulator and self._continue_accumulating:
                self._ensure_batch_timer_locked()

    async def handle_final_text(
        self,
        final_text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
        utterance_id: Optional[Any] = None,
    ) -> None:
        if not final_text:
            return
        async with self._state_lock:
            if not self.accumulator:
                self._pending_since_perf = time.perf_counter()
            self.accumulator.append(final_text)
            self.accumulator_segments.append(speaker_segments or [])
            self.accumulator_utterance_ids.append(
                [utterance_id] if utterance_id else []
            )
            self._current_batch_size = self._current_batch_target()
            await self._emit_status(
                "info",
                "Queued finalized transcript for graph processing.",
                {
                    "stage": "graph",
                    "phase": "queued",
                    "queued_finals": len(self.accumulator),
                    "batch_target": self._current_batch_size,
                    "pending_chars": sum(len(str(item or "")) for item in self.accumulator),
                    "queue_wait_ms": self._current_queue_wait_ms(),
                    "max_wait_ms": self._current_graph_wait_budget_ms(),
                },
            )
            if len(self.accumulator) >= self._current_batch_size and self._continue_accumulating:
                self._cancel_batch_timer_locked()
                await self._process_batches_locked(trigger="count_threshold")
            if self.accumulator and self._continue_accumulating:
                self._ensure_batch_timer_locked()

    async def flush(self) -> None:
        async with self._state_lock:
            self._cancel_batch_timer_locked()
            if not self.accumulator:
                return
            graph_emitted, _continue_accumulating, _incomplete_seg, _carryover_segments = await self._process_batch(
                self.accumulator,
                self.accumulator_segments,
                self.accumulator_utterance_ids,
                stop_accumulating_flag=True,
                trigger="flush",
            )
            if graph_emitted:
                self._graph_update_count += 1
            self.accumulator = []
            self.accumulator_segments = []
            self.accumulator_utterance_ids = []
            self._current_batch_size = self._current_batch_target()
            self._continue_accumulating = True
            self._pending_since_perf = None

    async def flush_segment(self) -> int:
        """Flush pending text for current segment without resetting existing_json.

        Used in interleaved pipeline to process each audio segment's transcript
        through the LLM while preserving cross-segment context (nodes already
        generated from earlier segments).

        Returns:
            Number of nodes in existing_json after flush.
        """
        async with self._state_lock:
            self._cancel_batch_timer_locked()
            if self.accumulator:
                graph_emitted, _continue_accumulating, _incomplete_seg, _carryover_segments = await self._process_batch(
                    self.accumulator,
                    self.accumulator_segments,
                    self.accumulator_utterance_ids,
                    stop_accumulating_flag=True,
                    trigger="flush_segment",
                )
                if graph_emitted:
                    self._graph_update_count += 1
            # Reset accumulator but keep existing_json for cross-segment context
            self.accumulator = []
            self.accumulator_segments = []
            self.accumulator_utterance_ids = []
            self._current_batch_size = self._current_batch_target()
            self._continue_accumulating = True
            self._pending_since_perf = None
            return len(self.existing_json)

    async def _process_batches_locked(self, *, trigger: str, force_flush: bool = False) -> None:
        # Snapshot the utterance_ids batch so we can carry the over-link set
        # forward verbatim if the LLM emits an Incomplete_segment. The
        # carryover text is a substring of these utterances' audio, so any
        # node materialized from the *next* chunk should also link to them
        # (over-linking is correct here — better to associate too widely
        # than to drop the link entirely).
        carryover_utt_ids: List[Any] = []
        if self.accumulator_utterance_ids:
            for slot in self.accumulator_utterance_ids:
                carryover_utt_ids.extend(slot or [])

        graph_emitted, continue_accumulating, incomplete_seg, carryover_segments = await self._process_batch(
            self.accumulator,
            self.accumulator_segments,
            self.accumulator_utterance_ids,
            stop_accumulating_flag=force_flush,
            trigger=trigger,
        )

        if graph_emitted:
            self._graph_update_count += 1

        if graph_emitted or not continue_accumulating:
            self.accumulator = [incomplete_seg] if incomplete_seg else []
            self.accumulator_segments = carryover_segments if incomplete_seg else []
            self.accumulator_utterance_ids = (
                [carryover_utt_ids] if incomplete_seg and carryover_utt_ids else []
            )
            self._current_batch_size = self._current_batch_target()
            self._continue_accumulating = True
            self._pending_since_perf = time.perf_counter() if self.accumulator else None
        else:
            self._current_batch_size = self._current_batch_target()
            self._continue_accumulating = True

        if not self.accumulator:
            self._cancel_batch_timer_locked()
            self._pending_since_perf = None

    async def _process_batch(
        self,
        text_batch: List[str],
        segment_batch: List[List[Dict[str, Any]]],
        utterance_ids_batch: Optional[List[List[Any]]] = None,
        stop_accumulating_flag: bool = False,
        trigger: str = "count_threshold",
    ) -> Tuple[bool, bool, str, List[List[Dict[str, Any]]]]:
        input_text = " ".join(text_batch)

        # Local models choke on the legacy "echo the transcript back" accumulate
        # prompt: output scales with input -> truncation -> every batch silently
        # dropped (qwen3.6 AND gemma4 fail identically; proven by the
        # .tmp_accumulate_experiment matrix). For local mode use the boundary-
        # index prompt: feed NUMBERED text fragments, get back a single
        # completed_through_index, split the batch on that index. We number the
        # TEXT fragments (not speaker segments) so this also works on the
        # bulk-import path, which passes no per-utterance diarization. Online
        # (Gemini) keeps the echo path untouched.
        use_index_mode = (
            str(self._llm_config.get("mode", "")).lower() == "local"
            and bool(text_batch)
        )

        if use_index_mode:
            numbered_input = "\n".join(
                f"[{i}] {str(frag).strip()}" for i, frag in enumerate(text_batch)
            )
            accumulated_output, acc_backend = await asyncio.to_thread(
                accumulate_text_json_local_indexed,
                numbered_input,
                providers=self._providers,
            )
        else:
            accumulated_output, acc_backend = await asyncio.to_thread(
                accumulate_text_json,
                input_text,
                llm_config=self._llm_config,
                providers=self._providers,
            )
        if acc_backend:
            self._last_llm_backend = acc_backend
        if not accumulated_output:
            logger.info("[ACCUMULATE] Empty result; continuing accumulation.")
            await self._emit_status(
                "warning",
                "Accumulator returned empty output; continuing accumulation.",
                {"stage": "accumulate", "trigger": trigger},
            )
            return False, True, input_text, segment_batch

        errors = []
        if isinstance(accumulated_output, dict):
            raw_errors = accumulated_output.get("_errors") or accumulated_output.get("_warnings")
            if isinstance(raw_errors, list):
                errors = [str(item) for item in raw_errors if str(item).strip()]

        if errors:
            summary = errors[0]
            if len(errors) > 1:
                summary = f"{summary} (+{len(errors) - 1} more)"
            await self._emit_status(
                "warning",
                summary,
                {
                    "stage": "accumulate",
                    "attempt_errors": errors,
                    "trigger": trigger,
                },
            )

        # Decision flag — tolerate both "decision" and legacy "Decision" casing.
        # The old prompt emits "Decision" but the reader only checked "decision",
        # so the model's stop/continue judgment was never honored (B2). Reading
        # both fixes it for the online path too without changing its prompt.
        decision_flag = (
            accumulated_output.get("decision")
            or accumulated_output.get("Decision")
            or "continue_accumulating"
        )
        if decision_flag == "continue_accumulating":
            decision = True
        elif decision_flag == "stop_accumulating":
            decision = False
        else:
            logger.info("[ACCUMULATE] Unexpected decision flag: %s", decision_flag)
            decision = True

        if use_index_mode:
            # Index split over text_batch fragments: completed_through_index is
            # the last completed fragment; everything after carries forward. No
            # fuzzy text matching, no transcript echo. Carried fragments are
            # collapsed back into the single-slot accumulator shape the caller
            # expects (one joined string + one flattened segment slot).
            def _flatten_slots(slots: Any) -> List[Dict[str, Any]]:
                return [
                    seg
                    for slot in (slots or [])
                    if isinstance(slot, list)
                    for seg in slot
                    if isinstance(seg, dict)
                ]

            raw_idx = accumulated_output.get("completed_through_index", -1)
            try:
                idx = int(raw_idx)
            except (TypeError, ValueError):
                idx = -1

            if stop_accumulating_flag:
                # Force-flush: take everything regardless of the model's split.
                completed_segments = _flatten_slots(segment_batch)
                carryover_segments = []
                segmented_input_chunk = input_text
                incomplete_seg = ""
                decision = False
            elif decision or idx < 0:
                # Nothing complete yet — keep accumulating (caller leaves the
                # accumulator intact in this branch, so carry values are moot).
                completed_segments = []
                carryover_segments = []
                segmented_input_chunk = ""
                incomplete_seg = input_text
                decision = True
            else:
                idx = min(idx, len(text_batch) - 1)
                completed_segments = _flatten_slots(segment_batch[: idx + 1]) if segment_batch else []
                carry_segs = _flatten_slots(segment_batch[idx + 1 :]) if segment_batch else []
                carryover_segments = [carry_segs] if carry_segs else []
                segmented_input_chunk = " ".join(
                    str(frag).strip() for frag in text_batch[: idx + 1]
                ).strip()
                incomplete_seg = " ".join(
                    str(frag).strip() for frag in text_batch[idx + 1 :]
                ).strip()
                # Continue accumulating only if a leftover tail remains.
                decision = bool(text_batch[idx + 1 :])
        else:
            segmented_input_chunk = accumulated_output.get("Completed_segment", "")
            incomplete_seg = accumulated_output.get("Incomplete_segment", "")

            if stop_accumulating_flag:
                decision = False
                segmented_input_chunk = input_text
                incomplete_seg = ""

            completed_segments, carryover_segments = self._split_segments_for_completed_chunk(
                text_batch=text_batch,
                segment_batch=segment_batch,
                completed_text=segmented_input_chunk,
                incomplete_text=incomplete_seg,
                stop_accumulating_flag=stop_accumulating_flag,
            )

        output_json: List[Dict[str, Any]] = []
        if segmented_input_chunk.strip():
            transcript_for_llm = format_speaker_prefixed_transcript(
                segmented_input_chunk,
                completed_segments if completed_segments else None,
            )

            from lct_python_backend.services.tuning_constants import (
                STREAMING_CONTEXT_FIELDS,
                STREAMING_CONTEXT_WINDOW_SIZE,
            )
            recent_nodes = self.existing_json[-STREAMING_CONTEXT_WINDOW_SIZE:]
            trimmed_context = [
                {k: n.get(k) for k in STREAMING_CONTEXT_FIELDS if n.get(k) is not None}
                for n in recent_nodes
            ]
            mod_input = (
                f"Existing JSON (last {len(trimmed_context)} of {len(self.existing_json)} nodes) : \n"
                f" {repr(trimmed_context)} "
                f"\n\n Transcript Input: \n {transcript_for_llm}"
            )
            generation_status_messages: List[str] = []
            queue_wait_ms = self._current_queue_wait_ms()
            generation_started_at = time.perf_counter()
            await self._emit_status(
                "info",
                "Generating graph update from finalized transcript.",
                {
                    "stage": "graph",
                    "phase": "generating",
                    "queued_finals": len(text_batch),
                    "segment_chars": len(segmented_input_chunk),
                    "existing_node_count": len(self.existing_json),
                    "llm_backend": self._llm_config.get("backend"),
                    "queue_wait_ms": queue_wait_ms,
                    "generation_started_at_ms": round(time.time() * 1000),
                    "trigger": trigger,
                },
            )
            output_json, gen_backend = await asyncio.to_thread(
                generate_lct_json,
                mod_input,
                llm_config=self._llm_config,
                providers=self._providers,
                status_messages=generation_status_messages,
            )
            if gen_backend:
                self._last_llm_backend = gen_backend
            for status_message in generation_status_messages:
                await self._emit_status(
                    "warning",
                    status_message,
                    {"stage": "generate_lct_json", "trigger": trigger},
                )

            if output_json:
                generation_ms = round(
                    max(0.0, (time.perf_counter() - generation_started_at) * 1000.0),
                    2,
                )
                total_update_ms = round(
                    max(0.0, (queue_wait_ms or 0.0) + generation_ms),
                    2,
                )
                chunk_id = str(uuid.uuid4())
                self.chunk_dict[chunk_id] = segmented_input_chunk

                # Option B: capture which utterance UUIDs flowed into this
                # batch. Live STT supplies one id per text fragment; the
                # bulk-import path passes None (it writes utterances *after*
                # LLM chunking). Deduplicate while preserving order so the
                # downstream UPDATE skips redundant rows.
                flat_utt_ids: List[str] = []
                if utterance_ids_batch:
                    seen_ids: set = set()
                    for slot in utterance_ids_batch:
                        for raw_id in slot or []:
                            if raw_id is None:
                                continue
                            id_str = str(raw_id)
                            if id_str in seen_ids:
                                continue
                            seen_ids.add(id_str)
                            flat_utt_ids.append(id_str)

                if flat_utt_ids:
                    self.chunk_utterance_map[chunk_id] = flat_utt_ids

                for item in output_json:
                    item["chunk_id"] = chunk_id
                    if flat_utt_ids and not item.get("utterance_ids"):
                        item["utterance_ids"] = list(flat_utt_ids)

                self.existing_json.extend(output_json)
                await self._emit_graph_update(
                    patch={
                        "kind": "finalized",
                        "nodes": output_json,
                        "chunks": {chunk_id: segmented_input_chunk},
                        "node_count": len(self.existing_json),
                        "chunk_count": len(self.chunk_dict),
                        "remove_node_ids": [],
                        "remove_chunk_ids": [],
                        "source_text": segmented_input_chunk,
                        "utterance_chunk_map": {chunk_id: flat_utt_ids} if flat_utt_ids else {},
                        "trigger": trigger,
                    }
                )
                await self._emit_status(
                    "info",
                    "Graph update ready.",
                    {
                        "stage": "graph",
                        "phase": "completed",
                        "chunk_id": chunk_id,
                        "latency_ms": generation_ms,
                        "generation_ms": generation_ms,
                        "queue_wait_ms": queue_wait_ms,
                        "total_update_ms": total_update_ms,
                        "node_delta": len(output_json),
                        "total_nodes": len(self.existing_json),
                        "llm_backend": gen_backend or self._last_llm_backend,
                        "queued_finals": len(text_batch),
                        "segment_chars": len(segmented_input_chunk),
                        "trigger": trigger,
                    },
                )
                logger.info(
                    "[GRAPH] trigger=%s queued_finals=%s queue_wait_ms=%s generation_ms=%s total_update_ms=%s node_delta=%s total_nodes=%s",
                    trigger,
                    len(text_batch),
                    queue_wait_ms,
                    generation_ms,
                    total_update_ms,
                    len(output_json),
                    len(self.existing_json),
                )
            else:
                generation_ms = round(
                    max(0.0, (time.perf_counter() - generation_started_at) * 1000.0),
                    2,
                )
                await self._emit_status(
                    "error",
                    "LLM returned no structured graph output for a completed transcript segment.",
                    {
                        "stage": "graph",
                        "phase": "empty",
                        "generation_stage": "generate_lct_json",
                        "segment_chars": len(segmented_input_chunk),
                        "latency_ms": generation_ms,
                        "generation_ms": generation_ms,
                        "queue_wait_ms": queue_wait_ms,
                        "total_update_ms": round(
                            max(0.0, (queue_wait_ms or 0.0) + generation_ms),
                            2,
                        ),
                        "trigger": trigger,
                    },
                )

        logger.info("[ACCUMULATE] Evaluated batch of %s transcripts", len(text_batch))
        return bool(segmented_input_chunk.strip() and output_json), decision, incomplete_seg, carryover_segments

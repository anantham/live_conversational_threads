"""Transcript processing facade — public API surface.

This module re-exports symbols from the decomposed sub-modules so that all
existing ``from lct_python_backend.services.transcript_processing import X``
statements continue to work unchanged.

Sub-modules:
  transcript_prompts      — prompt constants
  transcript_normalizer   — output normalization helpers
  transcript_llm_callers  — LLM API call functions
"""

import logging
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
    generate_lct_json,
)

logger = logging.getLogger("lct_backend")


class TranscriptProcessor:
    def __init__(
        self,
        send_update,
        send_status: Optional[Callable[[str, str, Dict[str, Any]], Awaitable[None]]] = None,
        batch_size: int = 4,
        max_batch_size: int = 12,
        llm_config: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.accumulator: List[str] = []
        self.accumulator_segments: List[List[Dict[str, Any]]] = []
        self.existing_json: List[Dict[str, Any]] = []
        self.chunk_dict: Dict[str, str] = {}
        self.base_batch_size = batch_size
        self.max_batch_size = max_batch_size
        self._current_batch_size = batch_size
        self._continue_accumulating = True
        self._send_update = send_update
        self._send_status = send_status
        self._llm_config = _resolve_llm_config(llm_config)

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

    async def handle_final_text(
        self,
        final_text: str,
        speaker_segments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if not final_text:
            return
        self.accumulator.append(final_text)
        self.accumulator_segments.append(speaker_segments or [])
        if len(self.accumulator) >= self._current_batch_size and self._continue_accumulating:
            await self._process_batches()

    async def flush(self) -> None:
        if not self.accumulator:
            return
        await self._process_batch(
            self.accumulator,
            self.accumulator_segments,
            stop_accumulating_flag=True,
        )
        self.accumulator = []
        self.accumulator_segments = []
        self._current_batch_size = self.base_batch_size
        self._continue_accumulating = True

    async def _process_batches(self) -> None:
        continue_accumulating, incomplete_seg, carryover_segments = await self._process_batch(
            self.accumulator,
            self.accumulator_segments,
        )

        if continue_accumulating:
            if self._current_batch_size >= self.max_batch_size:
                await self._process_batch(
                    self.accumulator,
                    self.accumulator_segments,
                    stop_accumulating_flag=True,
                )
                self.accumulator = []
                self.accumulator_segments = []
                self._current_batch_size = self.base_batch_size
                self._continue_accumulating = True
            else:
                self._current_batch_size += self.base_batch_size
        else:
            self.accumulator = [incomplete_seg] if incomplete_seg else []
            self.accumulator_segments = carryover_segments if incomplete_seg else []
            self._current_batch_size = self.base_batch_size
            self._continue_accumulating = True

    async def _process_batch(
        self,
        text_batch: List[str],
        segment_batch: List[List[Dict[str, Any]]],
        stop_accumulating_flag: bool = False,
    ) -> Tuple[bool, str, List[List[Dict[str, Any]]]]:
        input_text = " ".join(text_batch)
        accumulated_output = accumulate_text_json(input_text, llm_config=self._llm_config)
        if not accumulated_output:
            logger.info("[ACCUMULATE] Empty result; continuing accumulation.")
            await self._emit_status(
                "warning",
                "Accumulator returned empty output; continuing accumulation.",
                {"stage": "accumulate"},
            )
            return True, input_text, segment_batch

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
                },
            )

        segmented_input_chunk = accumulated_output.get("Completed_segment", "")
        incomplete_seg = accumulated_output.get("Incomplete_segment", "")

        decision_flag = accumulated_output.get("decision", "continue_accumulating")
        if decision_flag == "continue_accumulating":
            decision = True
        elif decision_flag == "stop_accumulating":
            decision = False
        else:
            logger.info("[ACCUMULATE] Unexpected decision flag: %s", decision_flag)
            decision = True

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

        if segmented_input_chunk.strip():
            transcript_for_llm = format_speaker_prefixed_transcript(
                segmented_input_chunk,
                completed_segments if completed_segments else None,
            )

            mod_input = (
                f"Existing JSON : \n {repr(self.existing_json)} "
                f"\n\n Transcript Input: \n {transcript_for_llm}"
            )
            generation_status_messages: List[str] = []
            output_json = generate_lct_json(
                mod_input,
                llm_config=self._llm_config,
                status_messages=generation_status_messages,
            )
            for status_message in generation_status_messages:
                await self._emit_status(
                    "warning",
                    status_message,
                    {"stage": "generate_lct_json"},
                )

            if output_json:
                chunk_id = str(uuid.uuid4())
                self.chunk_dict[chunk_id] = segmented_input_chunk
                for item in output_json:
                    item["chunk_id"] = chunk_id

                self.existing_json.extend(output_json)
                await self._send_update(self.existing_json, self.chunk_dict)
            else:
                await self._emit_status(
                    "error",
                    "LLM returned no structured graph output for a completed transcript segment.",
                    {
                        "stage": "generate_lct_json",
                        "segment_chars": len(segmented_input_chunk),
                    },
                )

        logger.info("[ACCUMULATE] Evaluated batch of %s transcripts", len(text_batch))
        return decision, incomplete_seg, carryover_segments

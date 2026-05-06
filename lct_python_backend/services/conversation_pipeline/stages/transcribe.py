"""Transcribe stage — manages transcript-buffer state and emits typed events.

The audit (``docs/plans/pipeline-extract-state-audit.md``) shows that the
**transcript-state management** in the live path is a clean carve-out:
``WsSessionContext`` holds ``pending_partial_parts``, ``pending_partial_chars``,
``pending_partial_timestamps``, ``pending_speaker_segments``, and
``session_final_text_parts`` (lines 123-127), all mutated inline in
``_process_*`` methods. The actual STT call remains in the transport
(it's tied to FastAPI WebSocket / HTTP machinery), but **the state
transitions around STT events** belong here.

This stage offers two usage modes:

  1. **Streaming helpers** for transports that produce partials/finals
     out of band (i.e. live websocket as STT events arrive). Transports
     call ``note_partial(...)`` and ``note_final(...)``; the stage
     mutates ``PipelineState.transcript_buffer`` and emits the typed
     ``TranscriptPartial`` / ``TranscriptFinal`` events.

  2. **Sequential run** for transports that already have a full transcript
     ready (i.e. the import path after segmented STT completes). The
     stage's ``run(state, emit)`` finalises any buffered partials and
     emits a single TranscriptFinal — useful as a pipeline stage in
     ``ConversationPipeline``.

Both modes converge on the same ``PipelineState`` shape, which is the
point of the contract: downstream stages never need to know which
transport produced the transcript.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Iterable, Optional, Tuple

from ..events import TranscriptFinal, TranscriptPartial
from ..protocol import EmitFn, Stage
from ..state import PipelineState


class TranscribeStage:
    """Owns transcript-buffer mutations + typed-event emission.

    Stateless — all state lives on ``PipelineState.transcript_buffer``
    and ``PipelineState.final_text_parts``. Multiple transports can
    share an instance.
    """

    name = "transcribe"

    async def note_partial(
        self,
        state: PipelineState,
        emit: EmitFn,
        text: str,
        *,
        timestamp_start: Optional[float] = None,
        timestamp_end: Optional[float] = None,
        speaker_segments: Iterable[Dict[str, Any]] = (),
    ) -> None:
        """Record a partial STT result and emit ``TranscriptPartial``.

        Mirrors the behaviour the live transport currently does inline
        around ``pending_partial_parts.append(...)``.
        """
        normalised = (text or "").strip()
        if not normalised:
            return

        buf = state.transcript_buffer
        buf.partial_parts.append(normalised)
        buf.partial_chars += len(normalised)
        if timestamp_start is not None and (
            buf.partial_timestamp_start is None
            or timestamp_start < buf.partial_timestamp_start
        ):
            buf.partial_timestamp_start = timestamp_start
        if timestamp_end is not None and (
            buf.partial_timestamp_end is None
            or timestamp_end > buf.partial_timestamp_end
        ):
            buf.partial_timestamp_end = timestamp_end

        segments_tuple = tuple(speaker_segments or ())
        for seg in segments_tuple:
            if isinstance(seg, dict):
                buf.pending_speaker_segments.append(seg)

        # Telemetry milestone: first partial in this session.
        if state.telemetry.first_partial_at_ms is None:
            state.telemetry.first_partial_at_ms = time.perf_counter() * 1000.0

        await emit(
            TranscriptPartial(
                stage=self.name,
                text=normalised,
                timestamp_start=timestamp_start,
                timestamp_end=timestamp_end,
                speaker_segments=segments_tuple,
            )
        )

    async def note_final(
        self,
        state: PipelineState,
        emit: EmitFn,
        text: str,
        *,
        timestamp_start: Optional[float] = None,
        timestamp_end: Optional[float] = None,
        speaker_segments: Iterable[Dict[str, Any]] = (),
        utterance_id: Optional[str] = None,
    ) -> None:
        """Record a final STT result and emit ``TranscriptFinal``.

        On final, the buffered partial state is flushed: the timestamp
        bounds for the partial run are reconciled with the final's
        bounds, the speaker segments are merged, and any partial chars
        are zeroed. ``state.final_text_parts`` accumulates the full
        transcript across the session.
        """
        normalised = (text or "").strip()
        if not normalised:
            # Even an empty final still clears partial state — STT may
            # signal "nothing useful in this window".
            self._reset_buffer(state)
            return

        buf = state.transcript_buffer

        # Merge timestamp bounds: prefer explicit final bounds; fall
        # back to widest-of-partial when not provided.
        ts_start = timestamp_start if timestamp_start is not None else buf.partial_timestamp_start
        ts_end = timestamp_end if timestamp_end is not None else buf.partial_timestamp_end

        # Merge speaker segments from buffer + this final.
        merged_segments: list[Dict[str, Any]] = list(buf.pending_speaker_segments)
        for seg in speaker_segments or ():
            if isinstance(seg, dict):
                merged_segments.append(seg)
        segments_tuple = tuple(merged_segments)

        state.final_text_parts.append(normalised)
        # full_transcript_text is the convenience materialisation that
        # downstream stages (segment/accumulate/generate_graph) read.
        state.full_transcript_text = (
            state.full_transcript_text + (" " if state.full_transcript_text else "") + normalised
        )

        self._reset_buffer(state)

        # Telemetry milestone: first final.
        if state.telemetry.first_final_at_ms is None:
            state.telemetry.first_final_at_ms = time.perf_counter() * 1000.0

        await emit(
            TranscriptFinal(
                stage=self.name,
                text=normalised,
                timestamp_start=ts_start,
                timestamp_end=ts_end,
                speaker_segments=segments_tuple,
                utterance_id=utterance_id,
            )
        )

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        """Sequential-mode invocation. Finalises any pending partials.

        For transports that produce a full transcript out of band (e.g.
        the import path after batched STT completes) this stage is a
        no-op when there's nothing to drain. When there are buffered
        partials, it synthesises a TranscriptFinal so downstream stages
        see a uniform stream regardless of which transport invoked us.
        """
        buf = state.transcript_buffer
        if not buf.partial_parts:
            return

        merged = " ".join(buf.partial_parts).strip()
        await self.note_final(
            state,
            emit,
            merged,
            timestamp_start=buf.partial_timestamp_start,
            timestamp_end=buf.partial_timestamp_end,
            speaker_segments=tuple(buf.pending_speaker_segments),
        )

    @staticmethod
    def _reset_buffer(state: PipelineState) -> None:
        buf = state.transcript_buffer
        buf.partial_parts.clear()
        buf.partial_chars = 0
        buf.partial_timestamp_start = None
        buf.partial_timestamp_end = None
        buf.pending_speaker_segments.clear()


__all__ = ["TranscribeStage"]

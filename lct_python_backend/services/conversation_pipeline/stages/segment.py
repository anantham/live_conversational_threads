"""Segment stage — chunk the assembled transcript into analyzer batches.

A pure-function stage. Takes ``state.full_transcript_text`` and produces
a list of chunked strings on ``state.transcript_chunks`` for the
``accumulate`` stage (PR-C) to feed into the LLM.

Today both transports independently call the same helper —
``services.text_parsers.chunk_transcript_lines`` (text_parsers.py:169) —
to produce these chunks. This stage is a thin wrapper so that the
chunk-boundary policy lives in one place and downstream stages can
read ``state.transcript_chunks`` rather than re-deriving them.

The chunk size (``max_chars``) is currently a constant; later PRs may
make it adaptive based on the current LLM provider's preferred prompt
window per ADR-030 §D5 (capability-sensitive routing).
"""

from __future__ import annotations

from ..events import StageStarted  # noqa: F401  (re-exported for symmetry)
from ..protocol import EmitFn, Stage
from ..state import PipelineState

from lct_python_backend.services.text_parsers import chunk_transcript_lines


class SegmentStage:
    """Splits ``state.full_transcript_text`` into LLM-sized chunks.

    Mutates ``state.source_metadata['transcript_chunks']`` (a transport-
    visible field) and exposes the chunks via the convenience attribute
    ``state.utterances`` is *not* touched — this stage is text-shape
    only; speaker segmentation lives elsewhere.
    """

    name = "segment"

    def __init__(self, *, max_chars: int = 280) -> None:
        self._max_chars = int(max_chars)

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        text = (state.full_transcript_text or "").strip()
        if not text:
            # Nothing to chunk; downstream stages handle empty input.
            return

        chunks = chunk_transcript_lines(text, max_chars=self._max_chars)

        # Surface the chunks on source_metadata so transports can read
        # them without depending on a stage-internal attribute. This
        # mirrors how the existing import worker passes chunks around.
        meta = dict(state.source_metadata)
        meta["transcript_chunks"] = list(chunks)
        meta["transcript_chunk_count"] = len(chunks)
        state.source_metadata = meta


__all__ = ["SegmentStage"]

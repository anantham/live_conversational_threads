"""Ingest stage — source classification (audio vs text).

The first stage in the pipeline. It examines ``state.source_metadata``
and the explicit ``state.source_kind`` (set by the transport) and
normalizes them into:

  - ``state.source_kind``    — one of "live_audio" | "audio_file" | "text_file" | "unknown"
  - ``state.is_likely_audio`` — bool used by downstream routing
  - ``state.source_metadata`` — preserved as-is

For PR-A the stage is intentionally thin: live transports always carry
``source_kind="live_audio"`` at construction; import transports already
classify the file before calling the pipeline. This stage exists to
emit the typed ``IngestStarted`` / ``IngestCompleted`` events so the
contract is uniform across transports and observability is symmetric.

Later PRs may move file-extension sniffing here.
"""

from __future__ import annotations

from typing import Optional

from ..events import IngestCompleted, IngestStarted
from ..protocol import EmitFn, Stage
from ..state import PipelineState


# File extensions the existing import path classifies as audio. Mirrors
# ``_AUDIO_SUFFIXES`` in ``services/import_bulk_pipeline.py:53``.
AUDIO_SUFFIXES = frozenset({
    ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".mp4",
})


class IngestStage:
    """First stage of the conversation pipeline. See module docstring."""

    name = "ingest"

    async def run(self, state: PipelineState, emit: EmitFn) -> None:
        size = _coerce_int(state.source_metadata.get("file_size_bytes"))
        await emit(
            IngestStarted(
                stage=self.name,
                source_kind=state.source_kind,
                source_size_bytes=size,
            )
        )

        # Honour an explicit transport-supplied source_kind first.
        kind = state.source_kind if state.source_kind != "unknown" else None

        # Otherwise sniff the file extension if metadata carries one.
        if kind is None:
            path = (state.source_metadata.get("file_name")
                    or state.source_metadata.get("path")
                    or "")
            kind = _classify_path(path)

        is_audio = kind in {"live_audio", "audio_file"}
        state.source_kind = kind
        state.is_likely_audio = is_audio

        await emit(
            IngestCompleted(
                stage=self.name,
                source_kind=kind,
                is_likely_audio=is_audio,
                source_metadata=dict(state.source_metadata),
            )
        )


def _classify_path(path: str) -> str:
    """Classify a file path/name into a source_kind. Empty path → unknown."""
    if not path:
        return "unknown"
    lower = path.lower()
    for suffix in AUDIO_SUFFIXES:
        if lower.endswith(suffix):
            return "audio_file"
    if lower.endswith((".txt", ".text", ".md", ".log", ".vtt", ".srt", ".pdf")):
        return "text_file"
    return "unknown"


def _coerce_int(value: object) -> Optional[int]:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


__all__ = ["IngestStage", "AUDIO_SUFFIXES"]

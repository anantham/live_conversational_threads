"""Speaker diarization and ASR-to-speaker alignment for the transcription pipeline."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from lct_python_backend.services.coercion_helpers import coerce_float, coerce_str
from lct_python_backend.services.transcript.transcription_utils import (
    STT_PYANNOTE_DEVICE,
    STT_PYANNOTE_MAX_SPEAKERS,
    STT_PYANNOTE_MIN_SPEAKERS,
    STT_PYANNOTE_MODEL,
    _coerce_optional_int,
)

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Speaker transcript formatting
# ---------------------------------------------------------------------------

def _format_speaker_transcript(segments: Sequence[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for seg in segments:
        speaker = coerce_str(seg.get("speaker")) or "SPEAKER_00"
        text = coerce_str(seg.get("text"))
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines).strip()


# ---------------------------------------------------------------------------
# ASR ↔ speaker segment alignment
# ---------------------------------------------------------------------------

def _speaker_overlap_seconds(
    asr_start: float,
    asr_end: float,
    speaker_start: float,
    speaker_end: float,
) -> float:
    return max(0.0, min(asr_end, speaker_end) - max(asr_start, speaker_start))


def _align_asr_segments_to_speakers(
    asr_segments: Sequence[Dict[str, Any]],
    speaker_segments: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Assign each ASR segment to the speaker segment with max temporal overlap."""
    if not asr_segments:
        return []

    normalized_speaker_segments: List[Dict[str, Any]] = []
    for seg in speaker_segments:
        if not isinstance(seg, dict):
            continue
        start = coerce_float(seg.get("start"))
        end = coerce_float(seg.get("end"))
        speaker = coerce_str(seg.get("speaker"))
        if start is None or end is None or end <= start or not speaker:
            continue
        normalized_speaker_segments.append({"speaker": speaker, "start": start, "end": end})

    assigned: List[Dict[str, Any]] = []
    for asr in asr_segments:
        asr_start = coerce_float(asr.get("start"))
        asr_end = coerce_float(asr.get("end"))
        text = coerce_str(asr.get("text"))
        if asr_start is None or asr_end is None or asr_end <= asr_start or not text:
            continue

        best_speaker = "SPEAKER_00"
        best_overlap = 0.0
        for diar in normalized_speaker_segments:
            overlap = _speaker_overlap_seconds(asr_start, asr_end, diar["start"], diar["end"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = diar["speaker"]

        assigned.append({"speaker": best_speaker, "start": asr_start, "end": asr_end, "text": text})

    # Merge adjacent segments from same speaker to keep transcript compact.
    merged: List[Dict[str, Any]] = []
    for seg in assigned:
        if (
            merged
            and merged[-1]["speaker"] == seg["speaker"]
            and float(seg["start"]) - float(merged[-1]["end"]) <= 0.35
        ):
            merged[-1]["text"] = f"{merged[-1]['text']} {seg['text']}".strip()
            merged[-1]["end"] = max(float(merged[-1]["end"]), float(seg["end"]))
            continue
        merged.append(dict(seg))
    return merged


# ---------------------------------------------------------------------------
# Pyannote pipeline (loaded once per process)
# ---------------------------------------------------------------------------

_PYANNOTE_PIPELINE: Any = None
_PYANNOTE_PIPELINE_DEVICE: str = ""
_PYANNOTE_PIPELINE_MODEL: str = ""


def _resolve_pyannote_device(torch_module: Any) -> str:
    requested = STT_PYANNOTE_DEVICE
    if requested in {"", "auto"}:
        if getattr(torch_module.backends, "mps", None) and torch_module.backends.mps.is_available():
            return "mps"
        if torch_module.cuda.is_available():
            return "cuda"
        return "cpu"
    return requested


def _load_pyannote_pipeline() -> Any:
    """Load and cache pyannote pipeline once per process."""
    global _PYANNOTE_PIPELINE, _PYANNOTE_PIPELINE_DEVICE, _PYANNOTE_PIPELINE_MODEL

    hf_token = coerce_str(os.getenv("STT_PYANNOTE_HF_TOKEN") or os.getenv("HF_TOKEN"))
    if not hf_token:
        raise RuntimeError("Missing HF token for pyannote (set STT_PYANNOTE_HF_TOKEN or HF_TOKEN).")

    if (
        _PYANNOTE_PIPELINE is not None
        and _PYANNOTE_PIPELINE_DEVICE == STT_PYANNOTE_DEVICE
        and _PYANNOTE_PIPELINE_MODEL == STT_PYANNOTE_MODEL
    ):
        return _PYANNOTE_PIPELINE

    import torch
    from pyannote.audio import Pipeline

    try:
        pipeline = Pipeline.from_pretrained(STT_PYANNOTE_MODEL, use_auth_token=hf_token)
    except TypeError as exc:
        message = str(exc)
        if "use_auth_token" in message:
            raise RuntimeError(
                "pyannote/huggingface_hub version mismatch: install huggingface_hub<1.0 "
                "for pyannote.audio 3.x compatibility."
            ) from exc
        raise

    resolved_device = _resolve_pyannote_device(torch)
    if resolved_device != "cpu":
        try:
            pipeline.to(torch.device(resolved_device))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[PYANNOTE] Failed to move pipeline to %s: %s. Falling back to CPU.",
                resolved_device,
                exc,
            )
            resolved_device = "cpu"

    _PYANNOTE_PIPELINE = pipeline
    _PYANNOTE_PIPELINE_DEVICE = STT_PYANNOTE_DEVICE
    _PYANNOTE_PIPELINE_MODEL = STT_PYANNOTE_MODEL
    logger.info(
        "[PYANNOTE] Loaded model=%s requested_device=%s resolved_device=%s",
        STT_PYANNOTE_MODEL,
        STT_PYANNOTE_DEVICE,
        resolved_device,
    )
    return _PYANNOTE_PIPELINE


def _run_pyannote_diarization(audio_path: Path) -> List[Dict[str, Any]]:
    pipeline = _load_pyannote_pipeline()
    min_speakers = _coerce_optional_int(STT_PYANNOTE_MIN_SPEAKERS)
    max_speakers = _coerce_optional_int(STT_PYANNOTE_MAX_SPEAKERS)

    kwargs: Dict[str, Any] = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    try:
        diarization = pipeline(str(audio_path), **kwargs)
    except Exception as exc:  # noqa: BLE001
        message = str(exc) or type(exc).__name__
        if "Expected size" in message and "tensor" in message:
            raise RuntimeError(
                "pyannote diarization failed on this compressed source; "
                "convert to 16kHz mono WAV and retry."
            ) from exc
        raise

    speaker_segments: List[Dict[str, Any]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = float(turn.start)
        end = float(turn.end)
        if end <= start:
            continue
        speaker_segments.append(
            {"speaker": coerce_str(speaker) or "SPEAKER_00", "start": start, "end": end}
        )
    speaker_segments.sort(key=lambda seg: (float(seg["start"]), float(seg["end"])))
    return speaker_segments

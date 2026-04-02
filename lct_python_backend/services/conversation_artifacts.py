"""Artifact builders for conversation exports."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional


def sanitize_artifact_basename(value: str, fallback: str = "conversation") -> str:
    candidate = str(value or "").strip() or fallback
    candidate = re.sub(r"[\\/:*?\"<>|]+", "_", candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate or fallback


def _format_timestamp(seconds: Any) -> str:
    if seconds is None:
        return "--:--:--.---"
    total = max(0.0, float(seconds))
    hours = int(total // 3600)
    minutes = int((total % 3600) // 60)
    whole_seconds = int(total % 60)
    millis = int(round((total - int(total)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def build_linear_transcript_text(
    *,
    conversation: Any,
    utterances: Iterable[Any],
    chunk_dict: Optional[Dict[str, str]] = None,
) -> str:
    """Render a deterministic linear transcript artifact."""
    utterance_list = list(utterances or [])
    lines = [
        f"# Conversation: {getattr(conversation, 'conversation_name', '') or 'Untitled Conversation'}",
        f"# Source type: {getattr(conversation, 'source_type', '') or 'unknown'}",
        f"# Generated at: {datetime.now(timezone.utc).isoformat()}",
        f"# Total utterances: {len(utterance_list)}",
    ]

    if utterance_list:
        for utterance in utterance_list:
            speaker_id = getattr(utterance, "speaker_id", None) or "SPEAKER_00"
            speaker_name = getattr(utterance, "speaker_name", None) or ""
            speaker_label = str(speaker_name or speaker_id)
            speaker_source = getattr(utterance, "speaker_source", None)
            confidence = getattr(utterance, "speaker_confidence", None)
            timestamp_start = getattr(utterance, "timestamp_start", None)
            timestamp_end = getattr(utterance, "timestamp_end", None)
            prefix = (
                f"[{_format_timestamp(timestamp_start)} - {_format_timestamp(timestamp_end)}] "
                f"{speaker_label}: "
            )
            detail_parts = []
            if speaker_source:
                detail_parts.append(f"speaker_source={speaker_source}")
            if confidence is not None:
                detail_parts.append(f"speaker_confidence={confidence}")
            detail_suffix = f" ({', '.join(detail_parts)})" if detail_parts else ""
            lines.append(f"{prefix}{getattr(utterance, 'text', '')}{detail_suffix}")
        return "\n".join(lines).strip() + "\n"

    lines.append("# Fallback linear transcript (no utterance rows materialized)")
    if chunk_dict:
        for chunk_id, chunk_text in chunk_dict.items():
            lines.append(f"\n[{chunk_id}]")
            lines.append(str(chunk_text or "").strip())
    return "\n".join(lines).strip() + "\n"

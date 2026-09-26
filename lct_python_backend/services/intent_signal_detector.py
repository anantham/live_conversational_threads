"""ADR-013 Contract C detector for live intent signals.

This module owns only the LLM detection step. Validation stays in
``intent_signal_persistence`` so imported/offline callers can reuse the same
contract parser without running an LLM.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from lct_python_backend.services.intent_signal_persistence import validate_contract_c
from lct_python_backend.services.local_llm_client import chat_with_provider_fallback

logger = logging.getLogger("lct_backend")

PROMPT_NAME = "intent_signal_detection"
PROMPT_VERSION = "adr-013-v1"

_MIN_SEGMENT_CHARS = int(os.getenv("INTENT_SIGNAL_MIN_SEGMENT_CHARS", "80"))

_PROMPT = """You are ADR-013 Contract C: an intent-signal detector for a live conversation.

An intent signal (user-facing word: prayer) is a pre-formal intention, half-formed
intuition, unresolved question, or gestured-at pattern that is too early to force
into a claim, task, or summary.

Detect ONLY signals that are explicitly present in this one finalized transcript
segment. Be conservative.

Do NOT include:
- ordinary factual claims
- generic summaries
- action items or scheduling tasks
- explicit fetch / fact-check commands
- polished conclusions that are already clear claims

Return ONLY a JSON array. Empty array is valid.

Each item must have exactly this shape:
{
  "raw_text": "verbatim quote from the segment",
  "context_summary": "1-2 sentences preserving the local context",
  "speaker_id": "speaker label if present, otherwise unknown",
  "source_utterance_refs": ["utterance_0"],
  "detection_confidence": 0.0,
  "is_new": true,
  "existing_signal_match": null
}

SEGMENT utterance_0:
"""


@dataclass
class IntentSignalDetectionResult:
    """Result of one Contract C detector pass."""

    validated_items: List[Dict[str, Any]]
    raw_count: int
    detection_model: str
    provider_id: str
    elapsed_ms: float
    error: Optional[str] = None


def should_run() -> bool:
    """Return whether ADR-013 live Contract C detection is enabled."""
    return os.getenv("INTENT_SIGNAL_DETECTION_ENABLED", "false").strip().lower() == "true"


def _pregate(segment_text: str) -> bool:
    text = str(segment_text or "").strip()
    return len(text) >= _MIN_SEGMENT_CHARS


def _strip_markdown_fence(text: str) -> str:
    s = str(text or "").strip()
    if "```" not in s:
        return s
    match = re.search(r"```(?:json)?\s*(.*?)```", s, re.S | re.I)
    return match.group(1).strip() if match else s


def _loads_json_arrayish(raw: Any) -> Any:
    """Parse model output, accepting either an array or {"signals": [...]}."""
    if isinstance(raw, (list, dict)):
        return raw
    text = _strip_markdown_fence(str(raw or ""))
    if not text:
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        obj_start = text.find("{")
        obj_end = text.rfind("}")
        if obj_start >= 0 and obj_end > obj_start:
            return json.loads(text[obj_start : obj_end + 1])
        raise


def _coerce_items(parsed: Any) -> List[Dict[str, Any]]:
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    if isinstance(parsed, dict) and isinstance(parsed.get("signals"), list):
        return [item for item in parsed["signals"] if isinstance(item, dict)]
    return []


async def detect_intent_signals_for_segment(
    *,
    segment_text: str,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> IntentSignalDetectionResult:
    """Run Contract C detection for one finalized transcript segment.

    Never raises. The caller decides whether/how to persist returned items and
    whether to record durable events.
    """
    if not _pregate(segment_text):
        return IntentSignalDetectionResult(
            validated_items=[],
            raw_count=0,
            detection_model="",
            provider_id="",
            elapsed_ms=0.0,
        )

    start = time.perf_counter()
    try:
        result = await chat_with_provider_fallback(
            [{"role": "user", "content": _PROMPT + str(segment_text or "").strip()}],
            providers=providers,
            require_json=False,
            max_tokens=900,
            temperature=0.1,
            prompt_name=PROMPT_NAME,
            prompt_version=PROMPT_VERSION,
        )
        parsed = _loads_json_arrayish(result.data)
        raw_items = _coerce_items(parsed)
        validated = validate_contract_c(raw_items)
        return IntentSignalDetectionResult(
            validated_items=validated,
            raw_count=len(raw_items),
            detection_model=result.model or result.provider_id or "unknown",
            provider_id=result.provider_id or "",
            elapsed_ms=(time.perf_counter() - start) * 1000.0,
        )
    except Exception as exc:  # noqa: BLE001 - live path must never fail transcript persistence
        logger.warning("[intent-signal] Contract C detection failed: %s", type(exc).__name__)
        return IntentSignalDetectionResult(
            validated_items=[],
            raw_count=0,
            detection_model="",
            provider_id="",
            elapsed_ms=(time.perf_counter() - start) * 1000.0,
            error=f"{type(exc).__name__}: {exc}",
        )

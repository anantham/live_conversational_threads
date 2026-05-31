"""
Consumption-trigger detection for live conversation segments.

A lightweight local-LLM pass that asks: "Is the speaker reaching for a
prior held intention?" Distinct from Contract C (which detects NEW prayers
being made). This pass gates the call to IndrasNet's /api/prayers/match
so we don't query for every segment regardless of relevance.

Pipeline position:
    completed segment
        ↓
    [Contract B — graph delta]      (existing)
        ↓
    [Contract C — new prayer detection]  (existing helper, optional wiring)
        ↓
    [consumption_trigger — THIS]    (new)
        ↓ (only if has_trigger)
    [indrasnet_client.match_prayers]
        ↓
    [WS event → frontend chip]

Error policy:
    LLM failures (unreachable, malformed JSON, timeout) log loudly and
    return ConsumptionTriggerResult(has_trigger=False, error_note=...).
    The live pipeline must never block on this — it's an enhancement,
    not a critical path. Per ADR-013: detection failures are telemetry,
    not errors. Per AGENTS.md §Error Logging: no silent failures —
    everything that fails is logged at WARN with a descriptive cause.

Configuration:
    CONSUMPTION_TRIGGER_ENABLED — feature flag (default false)
    CONSUMPTION_TRIGGER_MODEL — model name override (default: system chat_model)
    CONSUMPTION_TRIGGER_THRESHOLD — confidence cutoff (default 0.6)
    CONSUMPTION_TRIGGER_TIMEOUT_SECONDS — per-call cap (default 4.0)
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lct_python_backend.services.llm_config import get_env_llm_defaults
from lct_python_backend.services.local_llm_client import (
    extract_json_from_text,
    get_local_client,
)

logger = logging.getLogger("lct_backend")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONSUMPTION_THRESHOLD = 0.6
DEFAULT_CONSUMPTION_TIMEOUT_SECONDS = 4.0
DEFAULT_MAX_RECENT_SEGMENTS = 2
DEFAULT_MAX_THREAD_NAMES = 6


def is_enabled() -> bool:
    """Read the feature flag. Off by default — explicit opt-in only."""
    return os.getenv("CONSUMPTION_TRIGGER_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def get_threshold() -> float:
    try:
        return float(os.getenv("CONSUMPTION_TRIGGER_THRESHOLD", str(DEFAULT_CONSUMPTION_THRESHOLD)))
    except (TypeError, ValueError):
        return DEFAULT_CONSUMPTION_THRESHOLD


def get_timeout_seconds() -> float:
    try:
        return float(os.getenv("CONSUMPTION_TRIGGER_TIMEOUT_SECONDS", str(DEFAULT_CONSUMPTION_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_CONSUMPTION_TIMEOUT_SECONDS


def get_model() -> str:
    """Resolve which LLM to use. Specific override → system default."""
    override = os.getenv("CONSUMPTION_TRIGGER_MODEL")
    if override and override.strip():
        return override.strip()
    return get_env_llm_defaults().get("chat_model") or "zai-org/glm-4.6v-flash"


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class ConsumptionTriggerResult:
    """
    Outcome of the trigger detection pass.

    `has_trigger=True` means the LLM judges that the speaker is reaching
    for a prior held intention with confidence ≥ threshold. The caller
    should then forward `topic_hints` + segment text to IndrasNet's match
    endpoint.

    `has_trigger=False` covers three sub-cases distinguishable via
    `error_note`:
      - error_note is None → LLM ran successfully and said "no trigger"
      - error_note is a string → LLM call failed; the live pipeline should
        not assume "no trigger means definitely nothing relevant" in
        telemetry; this distinction matters for measuring real false-negatives.
    """
    has_trigger: bool
    topic_hints: List[str] = field(default_factory=list)
    confidence: float = 0.0
    reasoning: str = ""
    error_note: Optional[str] = None
    model: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "has_trigger": self.has_trigger,
            "topic_hints": self.topic_hints,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "error_note": self.error_note,
            "model": self.model,
        }


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a listening assistant analyzing a live conversation.

Your single job: decide whether the speaker is REACHING FOR a prior held intention — bringing up a topic they previously said they'd come back to, asking "what was that thing we were going to discuss", or implicitly returning to an unfinished thread.

This is NOT the same as expressing a NEW intention (that's handled by a separate detector). Look specifically for re-emergence signals:
- explicit recall: "what were we going to talk about", "remember when", "speaking of which"
- implicit return: a topic shift toward a domain that was previously earmarked
- meta-language: "I keep meaning to ask", "we never got to", "by the way"

Be conservative. If the speaker is clearly making a fresh statement or asking a fresh question with no callback signal, answer has_trigger=false. Surfacing prior prayers at the wrong moment breaks conversational flow."""


_USER_PROMPT_TEMPLATE = """Active threads in this conversation:
{thread_block}

Recent segments leading up to the latest one:
{recent_block}

Latest segment:
{segment_text}

Return ONLY a JSON object with exactly these keys:
{{
  "has_trigger": true | false,
  "topic_hints": ["1-3 short topical keywords describing what they're reaching for; empty list if has_trigger=false"],
  "confidence": 0.0,
  "reasoning": "one sentence — why or why not"
}}"""


def _format_thread_block(threads: Optional[List[str]]) -> str:
    if not threads:
        return "(none yet)"
    truncated = threads[:DEFAULT_MAX_THREAD_NAMES]
    return "\n".join(f"- {t}" for t in truncated if t)


def _format_recent_block(segments: Optional[List[str]]) -> str:
    if not segments:
        return "(none — this is the first segment)"
    truncated = segments[-DEFAULT_MAX_RECENT_SEGMENTS:]
    return "\n---\n".join(s.strip() for s in truncated if s and s.strip())


def build_prompt(
    *,
    segment_text: str,
    active_threads: Optional[List[str]],
    recent_segments: Optional[List[str]],
) -> List[Dict[str, str]]:
    """Assemble the chat messages array. Exposed for testability."""
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _USER_PROMPT_TEMPLATE.format(
                thread_block=_format_thread_block(active_threads),
                recent_block=_format_recent_block(recent_segments),
                segment_text=(segment_text or "").strip(),
            ),
        },
    ]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_llm_response(response_body: Dict[str, Any]) -> ConsumptionTriggerResult:
    """
    Extract the LLM's structured output. Tolerates: response_format=json_object
    (parsed dict), raw text with ```json fences, raw text with prose around
    the JSON. Anything unrecoverable raises ValueError so the caller can log
    and degrade gracefully.
    """
    try:
        message = response_body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as e:
        raise ValueError(f"Response missing choices[0].message: {e}")

    content = message.get("content")
    if isinstance(content, dict):
        # Some providers parse json_object server-side and put a dict here
        parsed = content
    elif isinstance(content, str):
        if not content.strip():
            raise ValueError("Response content is empty string")
        parsed = extract_json_from_text(content)
    else:
        raise ValueError(f"Response content has unexpected type {type(content).__name__}")

    if not isinstance(parsed, dict):
        raise ValueError(f"Parsed content is not a dict: {type(parsed).__name__}")

    raw_has = parsed.get("has_trigger")
    has_trigger = bool(raw_has) if isinstance(raw_has, bool) else (
        str(raw_has).strip().lower() in {"true", "yes", "1"}
    )

    raw_conf = parsed.get("confidence", 0.0)
    try:
        confidence = float(raw_conf)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    raw_hints = parsed.get("topic_hints") or []
    if isinstance(raw_hints, str):
        # tolerate "a, b, c"
        hints = [t.strip() for t in raw_hints.split(",") if t.strip()]
    elif isinstance(raw_hints, list):
        hints = [str(t).strip() for t in raw_hints if str(t).strip()]
    else:
        hints = []

    reasoning = str(parsed.get("reasoning") or "").strip()

    return ConsumptionTriggerResult(
        has_trigger=has_trigger,
        topic_hints=hints,
        confidence=confidence,
        reasoning=reasoning,
        error_note=None,
    )


# ---------------------------------------------------------------------------
# Public detection function
# ---------------------------------------------------------------------------

async def detect_consumption_trigger(
    *,
    segment_text: str,
    active_threads: Optional[List[str]] = None,
    recent_segments: Optional[List[str]] = None,
    config_override: Optional[Dict[str, Any]] = None,
) -> ConsumptionTriggerResult:
    """
    Decide whether the latest segment is the speaker reaching for a prior
    held intention. Calls the local LLM with a tight prompt and applies the
    confidence threshold.

    Never raises — failures are caught, logged at WARN, and returned as
    a ConsumptionTriggerResult with error_note set. This matches ADR-013's
    "detection failures are telemetry, not errors" policy: a transient LLM
    hiccup should not interrupt the user's conversation.

    Args:
        segment_text: The just-finalized segment.
        active_threads: Names of currently-open threads (for disambiguation).
        recent_segments: Last 1-2 segments before this one (for context).
        config_override: Optional LLM config dict; defaults to system env.

    Returns:
        ConsumptionTriggerResult. Caller checks `has_trigger` to decide
        whether to fire the IndrasNet match call.
    """
    if not segment_text or not segment_text.strip():
        return ConsumptionTriggerResult(
            has_trigger=False,
            error_note="empty segment_text",
        )

    config = dict(config_override or get_env_llm_defaults())
    # Match the per-call timeout, not the gateway default (which is generous).
    config["timeout_seconds"] = min(
        float(config.get("timeout_seconds") or DEFAULT_CONSUMPTION_TIMEOUT_SECONDS),
        get_timeout_seconds(),
    )

    model = get_model()
    threshold = get_threshold()
    messages = build_prompt(
        segment_text=segment_text,
        active_threads=active_threads,
        recent_segments=recent_segments,
    )

    logger.debug(
        "[consumption_trigger] calling LLM model=%s ctx_len=%d threads=%d recents=%d",
        model, len(segment_text),
        len(active_threads or []), len(recent_segments or []),
    )

    client = get_local_client(config)
    try:
        response_body = await client.chat(
            model=model,
            messages=messages,
            temperature=0.1,
            max_tokens=200,
        )
    except Exception as exc:  # noqa: BLE001 — non-blocking by design
        msg = f"LLM call failed: {type(exc).__name__}: {exc}"
        logger.warning("[consumption_trigger] %s", msg)
        return ConsumptionTriggerResult(
            has_trigger=False,
            error_note=msg,
            model=model,
        )

    try:
        result = parse_llm_response(response_body)
    except (ValueError, json.JSONDecodeError) as exc:
        msg = f"LLM response unparseable: {exc}"
        logger.warning("[consumption_trigger] %s", msg)
        return ConsumptionTriggerResult(
            has_trigger=False,
            error_note=msg,
            model=model,
        )

    result.model = model

    # Apply confidence threshold. If LLM says has_trigger=True but confidence
    # is below threshold, demote to has_trigger=False but preserve the hints
    # for telemetry — they may be useful for understanding what the model
    # thought was happening even when we declined to surface anything.
    if result.has_trigger and result.confidence < threshold:
        logger.debug(
            "[consumption_trigger] LLM said trigger but conf %.2f < threshold %.2f — demoting",
            result.confidence, threshold,
        )
        result.has_trigger = False

    logger.info(
        "[consumption_trigger] result has_trigger=%s confidence=%.2f hints=%s reasoning=%r",
        result.has_trigger, result.confidence, result.topic_hints,
        result.reasoning[:80] if result.reasoning else "",
    )
    return result

"""
Intent Signal persistence helper (ADR-013).

Handles Contract C: parse → validate → persist LLM-detected intent signals
(prayers) to intent_signals and intent_signal_sightings.

Design constraints from ADR-013:
- Never blocks transcript persistence; all failures are warnings
- raw_text + context_window are immutable after creation
- Items below confidence threshold (< 0.6) are discarded, not persisted
- Parse/contract failures logged as warnings
  TODO: record to analysis_events table once it exists
"""

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from lct_python_backend.models import IntentSignal, IntentSignalSighting

logger = logging.getLogger(__name__)

# Confidence threshold below which detected signals are discarded
CONFIDENCE_THRESHOLD = float(os.getenv("INTENT_SIGNAL_CONFIDENCE_THRESHOLD", "0.6"))

# Feature flag — set to "true" to enable Contract C detection in the live path
INTENT_SIGNAL_DETECTION_ENABLED = os.getenv("INTENT_SIGNAL_DETECTION_ENABLED", "false").lower() == "true"


# ---------------------------------------------------------------------------
# Contract C validator
# ---------------------------------------------------------------------------

def _validate_item(raw: Any, index: int) -> Optional[Dict]:
    """
    Validate one item from the Contract C JSON array.

    Returns the cleaned item dict, or None if the item should be dropped.
    Logs a warning for every dropped item so nothing is silent.
    """
    if not isinstance(raw, dict):
        logger.warning("Contract C item %d is not a dict — dropping", index)
        return None

    required = ("raw_text", "speaker_id", "detection_confidence")
    for field in required:
        if field not in raw:
            logger.warning(
                "Contract C item %d missing required field '%s' — dropping", index, field
            )
            return None

    if not isinstance(raw["raw_text"], str) or not raw["raw_text"].strip():
        logger.warning("Contract C item %d has empty raw_text — dropping", index)
        return None

    try:
        confidence = float(raw["detection_confidence"])
    except (TypeError, ValueError):
        logger.warning(
            "Contract C item %d has non-numeric detection_confidence — dropping", index
        )
        return None

    if confidence < CONFIDENCE_THRESHOLD:
        logger.debug(
            "Contract C item %d confidence %.2f below threshold %.2f — discarding",
            index, confidence, CONFIDENCE_THRESHOLD,
        )
        return None

    return {
        "raw_text": raw["raw_text"].strip(),
        "context_summary": str(raw.get("context_summary", "")).strip(),
        "speaker_id": str(raw.get("speaker_id", "")).strip(),
        "source_utterance_refs": raw.get("source_utterance_refs") or [],
        "detection_confidence": confidence,
        "is_new": bool(raw.get("is_new", True)),
        "existing_signal_match": raw.get("existing_signal_match"),
    }


def validate_contract_c(llm_output: Any, stage: str = "intent_signal_detection") -> List[Dict]:
    """
    Parse and validate Contract C LLM output.

    Args:
        llm_output: Raw value from LLM (expected: list of dicts)
        stage: Label for warning logs (helps trace which pipeline stage this came from)

    Returns:
        List of validated, threshold-passing items.  Empty list is valid.
    """
    if not isinstance(llm_output, list):
        logger.warning(
            "[%s] Contract C output is not a list (got %s) — returning empty",
            stage, type(llm_output).__name__,
        )
        # TODO: record to analysis_events when that table exists
        return []

    valid = []
    for i, item in enumerate(llm_output):
        cleaned = _validate_item(item, i)
        if cleaned is not None:
            valid.append(cleaned)

    logger.debug("[%s] Contract C: %d / %d items passed validation", stage, len(valid), len(llm_output))
    return valid


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

async def persist_intent_signals(
    *,
    db,
    conversation_id: str,
    validated_items: List[Dict],
    detection_model: str,
    utterance_id_map: Optional[Dict[str, str]] = None,
) -> Dict[str, int]:
    """
    Persist validated Contract C items to intent_signals / intent_signal_sightings.

    Args:
        db: Async SQLAlchemy session
        conversation_id: UUID string of the current conversation
        validated_items: Output of validate_contract_c()
        detection_model: Model name string (written to detection_model column)
        utterance_id_map: Optional mapping from sequence-number refs
            (e.g. "utterance_3") to UUID strings, for resolving source_utterance_refs.

    Returns:
        {"created": N, "sightings": M, "skipped": K}
    """
    if not validated_items:
        return {"created": 0, "sightings": 0, "skipped": 0}

    utterance_id_map = utterance_id_map or {}
    created = 0
    sightings = 0
    skipped = 0
    now = datetime.now(timezone.utc)
    conv_uuid = uuid.UUID(conversation_id)

    for item in validated_items:
        try:
            # Resolve source_utterance_refs to UUIDs where possible
            source_ids = []
            for ref in item["source_utterance_refs"]:
                resolved = utterance_id_map.get(str(ref))
                if resolved:
                    try:
                        source_ids.append(uuid.UUID(resolved))
                    except ValueError:
                        pass

            if item["is_new"] or not item["existing_signal_match"]:
                # Create a new intent signal
                signal = IntentSignal(
                    id=uuid.uuid4(),
                    conversation_id=conv_uuid,
                    raw_text=item["raw_text"],
                    context_window=item["context_summary"],
                    speaker_id=item["speaker_id"],
                    source_utterance_ids=source_ids or None,
                    status="active",
                    emerged_at=now,
                    sighting_count=1,
                    detection_confidence=item["detection_confidence"],
                    detection_model=detection_model,
                    salience=item["detection_confidence"],  # bootstrap from confidence
                )
                db.add(signal)
                created += 1
                logger.debug(
                    "persist_intent_signals: created signal %s for conversation %s",
                    signal.id, conversation_id,
                )
            else:
                # This item re-surfaces an existing signal
                try:
                    existing_id = uuid.UUID(str(item["existing_signal_match"]))
                except (ValueError, TypeError):
                    logger.warning(
                        "persist_intent_signals: invalid existing_signal_match %r — skipping sighting",
                        item["existing_signal_match"],
                    )
                    skipped += 1
                    continue

                # Add a sighting row; let the UNIQUE constraint prevent duplicates
                sighting = IntentSignalSighting(
                    id=uuid.uuid4(),
                    intent_signal_id=existing_id,
                    conversation_id=conv_uuid,
                    utterance_ids=source_ids or None,
                    context_note=item["context_summary"],
                    sighting_confidence=item["detection_confidence"],
                    sighted_at=now,
                )
                db.add(sighting)
                sightings += 1

                # Update denormalised summary on the parent signal
                # (fire-and-forget UPDATE; non-fatal if signal row not found)
                from sqlalchemy import update
                from lct_python_backend.models import IntentSignal as _IS
                await db.execute(
                    update(_IS)
                    .where(_IS.id == existing_id)
                    .values(
                        status="accumulating",
                        sighting_count=_IS.sighting_count + 1,
                        last_sighted_at=now,
                        last_sighted_conversation_id=conv_uuid,
                        updated_at=now,
                    )
                )
                logger.debug(
                    "persist_intent_signals: sighting for signal %s in conversation %s",
                    existing_id, conversation_id,
                )

        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "persist_intent_signals: failed to persist item %r — %s",
                item.get("raw_text", "")[:60], exc,
            )
            skipped += 1
            # TODO: record to analysis_events when that table exists

    try:
        await db.flush()
    except Exception as exc:  # noqa: BLE001
        logger.warning("persist_intent_signals: flush failed — %s", exc)
        return {"created": 0, "sightings": 0, "skipped": len(validated_items)}

    logger.info(
        "persist_intent_signals: conversation=%s created=%d sightings=%d skipped=%d",
        conversation_id, created, sightings, skipped,
    )
    return {"created": created, "sightings": sightings, "skipped": skipped}

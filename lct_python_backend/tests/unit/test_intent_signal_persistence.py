"""
Unit tests for intent_signal_persistence.py (ADR-013).

Tests:
  - validate_contract_c: valid batch, missing fields, low confidence, non-list input
  - persist_intent_signals: new signals, sightings for existing, mixed batch
  - Skipping and error-isolation: bad existing_signal_match, flush failure
"""
import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev")

from lct_python_backend.services.intent_signal_persistence import (
    validate_contract_c,
    persist_intent_signals,
    CONFIDENCE_THRESHOLD,
)


CONVERSATION_ID = str(uuid.uuid4())
EXISTING_SIGNAL_ID = str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db_mock():
    db = MagicMock()
    db.add = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    return db


def _valid_item(**overrides):
    base = {
        "raw_text": "I keep noticing this pattern but don't know what it is yet",
        "context_summary": "Speaker was discussing emergent structure in datasets",
        "speaker_id": "Alice",
        "source_utterance_refs": ["utterance_3", "utterance_4"],
        "detection_confidence": 0.82,
        "is_new": True,
        "existing_signal_match": None,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# validate_contract_c tests
# ---------------------------------------------------------------------------

class TestValidateContractC:
    def test_valid_batch_returns_all_items(self):
        batch = [_valid_item(), _valid_item(raw_text="Another observation")]
        result = validate_contract_c(batch)
        assert len(result) == 2

    def test_non_list_input_returns_empty(self):
        assert validate_contract_c({"raw_text": "oops"}) == []
        assert validate_contract_c(None) == []
        assert validate_contract_c("string") == []

    def test_empty_list_returns_empty(self):
        assert validate_contract_c([]) == []

    def test_missing_required_field_drops_item(self):
        # Missing raw_text
        bad = {
            "context_summary": "test",
            "speaker_id": "Alice",
            "detection_confidence": 0.9,
        }
        result = validate_contract_c([bad, _valid_item()])
        assert len(result) == 1  # only the valid item

    def test_low_confidence_item_discarded(self):
        below = _valid_item(detection_confidence=CONFIDENCE_THRESHOLD - 0.01)
        above = _valid_item(detection_confidence=CONFIDENCE_THRESHOLD)
        result = validate_contract_c([below, above])
        assert len(result) == 1
        assert result[0]["detection_confidence"] == CONFIDENCE_THRESHOLD

    def test_exactly_threshold_confidence_passes(self):
        item = _valid_item(detection_confidence=CONFIDENCE_THRESHOLD)
        result = validate_contract_c([item])
        assert len(result) == 1

    def test_empty_raw_text_drops_item(self):
        item = _valid_item(raw_text="   ")
        assert validate_contract_c([item]) == []

    def test_non_numeric_confidence_drops_item(self):
        item = _valid_item(detection_confidence="high")
        assert validate_contract_c([item]) == []

    def test_non_dict_item_drops_item(self):
        result = validate_contract_c(["not a dict", _valid_item()])
        assert len(result) == 1

    def test_unknown_keys_are_ignored(self):
        item = _valid_item(extra_field="should be ignored", another="also fine")
        result = validate_contract_c([item])
        assert len(result) == 1
        assert "extra_field" not in result[0]


# ---------------------------------------------------------------------------
# persist_intent_signals tests
# ---------------------------------------------------------------------------

class TestPersistIntentSignals:
    @pytest.mark.asyncio
    async def test_empty_validated_items_is_noop(self):
        db = _make_db_mock()
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=[],
            detection_model="qwen2.5",
        )
        db.add.assert_not_called()
        assert result == {"created": 0, "sightings": 0, "skipped": 0}

    @pytest.mark.asyncio
    async def test_new_signal_creates_intent_signal_row(self):
        db = _make_db_mock()
        items = [validate_contract_c([_valid_item()])[0]]
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=items,
            detection_model="qwen2.5",
        )
        assert db.add.call_count == 1
        added = db.add.call_args[0][0]
        from lct_python_backend.models import IntentSignal
        assert isinstance(added, IntentSignal)
        assert added.raw_text == items[0]["raw_text"]
        assert added.status == "active"
        assert added.detection_model == "qwen2.5"
        assert result["created"] == 1
        assert result["sightings"] == 0

    @pytest.mark.asyncio
    async def test_existing_signal_creates_sighting_row(self):
        db = _make_db_mock()
        item = validate_contract_c([_valid_item(
            is_new=False,
            existing_signal_match=EXISTING_SIGNAL_ID,
        )])[0]
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=[item],
            detection_model="mistral",
        )
        assert db.add.call_count == 1
        added = db.add.call_args[0][0]
        from lct_python_backend.models import IntentSignalSighting
        assert isinstance(added, IntentSignalSighting)
        assert str(added.intent_signal_id) == EXISTING_SIGNAL_ID
        assert result["created"] == 0
        assert result["sightings"] == 1
        # Should also have fired an UPDATE to increment sighting_count
        db.execute.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_mixed_batch_new_and_sighting(self):
        db = _make_db_mock()
        new_item = validate_contract_c([_valid_item()])[0]
        sight_item = validate_contract_c([_valid_item(
            raw_text="Pattern again",
            is_new=False,
            existing_signal_match=EXISTING_SIGNAL_ID,
        )])[0]
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=[new_item, sight_item],
            detection_model="qwen2.5",
        )
        assert result["created"] == 1
        assert result["sightings"] == 1
        assert result["skipped"] == 0
        assert db.add.call_count == 2

    @pytest.mark.asyncio
    async def test_invalid_existing_signal_match_is_skipped(self):
        db = _make_db_mock()
        item = validate_contract_c([_valid_item(
            is_new=False,
            existing_signal_match="not-a-uuid",
        )])[0]
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=[item],
            detection_model="qwen2.5",
        )
        assert result["skipped"] == 1
        assert result["sightings"] == 0
        db.add.assert_not_called()

    @pytest.mark.asyncio
    async def test_utterance_id_map_resolves_refs(self):
        db = _make_db_mock()
        u_id = str(uuid.uuid4())
        item = validate_contract_c([_valid_item(source_utterance_refs=["utterance_0"])])[0]
        await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=[item],
            detection_model="qwen2.5",
            utterance_id_map={"utterance_0": u_id},
        )
        added = db.add.call_args[0][0]
        assert uuid.UUID(u_id) in added.source_utterance_ids

    @pytest.mark.asyncio
    async def test_flush_failure_returns_zero_counts(self):
        db = _make_db_mock()
        db.flush.side_effect = Exception("DB connection lost")
        items = [validate_contract_c([_valid_item()])[0]]
        result = await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=items,
            detection_model="qwen2.5",
        )
        # Should not raise; should report zero persisted
        assert result["created"] == 0
        assert result["sightings"] == 0
        assert result["skipped"] == 1

    @pytest.mark.asyncio
    async def test_detection_model_written_to_row(self):
        db = _make_db_mock()
        model_name = "mistral-nemo-12b"
        items = [validate_contract_c([_valid_item()])[0]]
        await persist_intent_signals(
            db=db,
            conversation_id=CONVERSATION_ID,
            validated_items=items,
            detection_model=model_name,
        )
        added = db.add.call_args[0][0]
        assert added.detection_model == model_name

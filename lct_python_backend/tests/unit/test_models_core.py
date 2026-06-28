"""Unit tests for lct_python_backend.models.core (no DB required).

These tests verify model structure — CheckConstraints, nullable settings,
default callables, and index definitions — by inspecting the SQLAlchemy
metadata at the class level. Nothing here touches a database.
"""

import uuid

import pytest
import sqlalchemy as sa

from lct_python_backend.models.core import (
    Conversation,
    SpeakerAudioReference,
    SpeakerCorrectionEvent,
    SpeakerSegment,
    TranscriptEvent,
    Utterance,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _constraint_names(model) -> set:
    return {c.name for c in model.__table__.constraints if c.name}


def _check_constraints(model) -> dict:
    """Return {name: sqltext_str} for all CheckConstraints on the model."""
    return {
        c.name: str(c.sqltext)
        for c in model.__table__.constraints
        if isinstance(c, sa.CheckConstraint) and c.name
    }


def _index_names(model) -> set:
    return {idx.name for idx in model.__table__.indexes}


def _column(model, name) -> sa.Column:
    return model.__table__.c[name]


# ---------------------------------------------------------------------------
# Conversation
# ---------------------------------------------------------------------------

class TestConversationModel:
    def test_tablename(self):
        assert Conversation.__tablename__ == "conversations"

    def test_primary_key_has_uuid_default(self):
        col = _column(Conversation, "id")
        assert col.primary_key
        # The Python-side default must be the uuid4 callable.
        assert col.default is not None
        assert callable(col.default.arg)
        assert col.default.arg.__name__ == "uuid4"
        assert col.default.arg.__module__ == "uuid"

    def test_conversation_type_check_covers_all_values(self):
        checks = _check_constraints(Conversation)
        expr = checks["valid_conversation_type"]
        for allowed in ("live_audio", "transcript", "chat", "hybrid"):
            assert allowed in expr, f"'{allowed}' missing from valid_conversation_type"

    def test_visibility_check_covers_all_values(self):
        checks = _check_constraints(Conversation)
        expr = checks["valid_visibility"]
        for allowed in ("private", "shared", "public"):
            assert allowed in expr, f"'{allowed}' missing from valid_visibility"

    def test_required_columns_are_not_nullable(self):
        required = ("conversation_name", "conversation_type", "source_type", "owner_id", "started_at")
        for col_name in required:
            col = _column(Conversation, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_optional_columns_are_nullable(self):
        optional = ("ended_at", "duration_seconds", "gcs_path", "deleted_at", "goals", "goal_progress")
        for col_name in optional:
            col = _column(Conversation, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_indexes_defined(self):
        names = _index_names(Conversation)
        assert "idx_conversations_owner" in names
        assert "idx_conversations_started" in names

    def test_indrasnet_group_id_nullable(self):
        col = _column(Conversation, "indrasnet_group_id")
        assert col.nullable

    def test_unlocked_levels_nullable(self):
        col = _column(Conversation, "unlocked_levels")
        assert col.nullable


# ---------------------------------------------------------------------------
# Utterance
# ---------------------------------------------------------------------------

class TestUtteranceModel:
    def test_tablename(self):
        assert Utterance.__tablename__ == "utterances"

    def test_required_columns_not_nullable(self):
        for col_name in ("text", "speaker_id", "sequence_number", "conversation_id"):
            col = _column(Utterance, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_timestamp_check_constraint_exists(self):
        checks = _check_constraints(Utterance)
        assert "valid_timestamps" in checks
        expr = checks["valid_timestamps"]
        assert "timestamp_end" in expr
        assert "timestamp_start" in expr

    def test_speaker_source_has_server_default(self):
        col = _column(Utterance, "speaker_source")
        assert col.server_default is not None

    def test_speaker_revision_has_server_default(self):
        col = _column(Utterance, "speaker_revision")
        assert col.server_default is not None

    def test_word_timings_nullable(self):
        col = _column(Utterance, "word_timings")
        assert col.nullable

    def test_source_identifier_nullable(self):
        col = _column(Utterance, "source_identifier")
        assert col.nullable

    def test_indexes_defined(self):
        names = _index_names(Utterance)
        assert "idx_utterances_conversation" in names
        assert "idx_utterances_speaker" in names
        assert "idx_utterances_timestamp" in names


# ---------------------------------------------------------------------------
# TranscriptEvent
# ---------------------------------------------------------------------------

class TestTranscriptEventModel:
    def test_tablename(self):
        assert TranscriptEvent.__tablename__ == "transcript_events"

    def test_event_type_check_constraint(self):
        checks = _check_constraints(TranscriptEvent)
        assert "check_event_type" in checks
        expr = checks["check_event_type"]
        assert "partial" in expr
        assert "final" in expr

    def test_required_columns_not_nullable(self):
        for col_name in ("provider", "event_type", "text", "sequence_number", "conversation_id"):
            col = _column(TranscriptEvent, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_utterance_id_is_nullable(self):
        col = _column(TranscriptEvent, "utterance_id")
        assert col.nullable

    def test_speaker_id_nullable(self):
        col = _column(TranscriptEvent, "speaker_id")
        assert col.nullable

    def test_indexes_defined(self):
        names = _index_names(TranscriptEvent)
        assert "idx_transcript_events_conversation" in names
        assert "idx_transcript_events_event_type" in names


# ---------------------------------------------------------------------------
# SpeakerSegment
# ---------------------------------------------------------------------------

class TestSpeakerSegmentModel:
    def test_tablename(self):
        assert SpeakerSegment.__tablename__ == "speaker_segments"

    def test_required_columns_not_nullable(self):
        for col_name in ("provider", "speaker_id", "conversation_id"):
            col = _column(SpeakerSegment, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_absolute_timestamp_check_exists(self):
        checks = _check_constraints(SpeakerSegment)
        assert "valid_speaker_segment_timestamps" in checks

    def test_relative_timestamp_check_exists(self):
        checks = _check_constraints(SpeakerSegment)
        assert "valid_speaker_segment_relative_timestamps" in checks

    def test_text_nullable(self):
        assert _column(SpeakerSegment, "text").nullable

    def test_indexes_defined(self):
        names = _index_names(SpeakerSegment)
        assert "idx_speaker_segments_conversation" in names
        assert "idx_speaker_segments_speaker" in names
        assert "idx_speaker_segments_timestamp" in names


# ---------------------------------------------------------------------------
# SpeakerAudioReference
# ---------------------------------------------------------------------------

class TestSpeakerAudioReferenceModel:
    def test_tablename(self):
        assert SpeakerAudioReference.__tablename__ == "speaker_audio_references"

    def test_required_columns_not_nullable(self):
        for col_name in ("speaker_id", "speaker_name", "sample_rate_hz"):
            col = _column(SpeakerAudioReference, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_optional_columns_nullable(self):
        for col_name in ("audio_wav", "source_conversation_id", "source_utterance_id",
                         "source_timestamp_start", "source_timestamp_end",
                         "duration_seconds", "clip_quality_score"):
            col = _column(SpeakerAudioReference, col_name)
            assert col.nullable, f"{col_name} should be nullable"

    def test_index_on_speaker(self):
        names = _index_names(SpeakerAudioReference)
        assert "idx_speaker_audio_speaker" in names


# ---------------------------------------------------------------------------
# SpeakerCorrectionEvent
# ---------------------------------------------------------------------------

class TestSpeakerCorrectionEventModel:
    def test_tablename(self):
        assert SpeakerCorrectionEvent.__tablename__ == "speaker_correction_events"

    def test_required_columns_not_nullable(self):
        for col_name in ("conversation_id", "utterance_id", "prior_speaker", "new_speaker", "source"):
            col = _column(SpeakerCorrectionEvent, col_name)
            assert not col.nullable, f"{col_name} should be NOT NULL"

    def test_time_window_has_server_default(self):
        col = _column(SpeakerCorrectionEvent, "time_window_seconds")
        assert col.server_default is not None

    def test_user_id_nullable(self):
        assert _column(SpeakerCorrectionEvent, "user_id").nullable

    def test_indexes_defined(self):
        names = _index_names(SpeakerCorrectionEvent)
        assert "idx_speaker_corrections_conversation" in names
        assert "idx_speaker_corrections_utterance" in names

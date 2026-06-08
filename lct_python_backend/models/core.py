"""Core conversation models: Conversation, Utterance, TranscriptEvent, SpeakerSegment."""

import uuid

from sqlalchemy import (
    Column, Integer, Float, Boolean, Text, DateTime, LargeBinary,
    ForeignKey, Index, CheckConstraint, ARRAY, text as sql_text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, TSVECTOR
from sqlalchemy.sql import func

from .base import Base


class Conversation(Base):
    """Top-level conversation container"""
    __tablename__ = "conversations"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_name = Column(Text, nullable=False)
    conversation_type = Column(Text, nullable=False)  # 'live_audio', 'transcript', 'chat', 'hybrid'

    # Source
    source_type = Column(Text, nullable=False)  # 'audio_stream', 'google_meet', 'slack', etc.
    source_metadata = Column(JSONB)
    # IndrasNet stable conversation key (group_id) this LCT conversation mirrors,
    # so re-extraction / coverage backfill can re-pull the raw turns (P0). NULL =
    # not sourced from IndrasNet.
    indrasnet_group_id = Column(Text)

    # Participants
    participant_count = Column(Integer, default=0)
    participants = Column(ARRAY(JSONB))  # Array of participant objects

    # Temporal
    started_at = Column(DateTime(timezone=True), nullable=False)
    ended_at = Column(DateTime(timezone=True))
    duration_seconds = Column(Integer)

    # Goals & Intent
    goals = Column(ARRAY(JSONB))  # Array of goal objects
    goal_progress = Column(JSONB)

    # Storage
    gcs_path = Column(Text)  # Path to full conversation JSON in GCS

    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime(timezone=True))  # Soft delete

    # Privacy
    owner_id = Column(Text, nullable=False)
    visibility = Column(Text, default='private')  # 'private', 'shared', 'public'
    shared_with = Column(ARRAY(Text))

    # Analytics (cached)
    total_utterances = Column(Integer, default=0)
    total_words = Column(Integer, default=0)
    total_nodes = Column(Integer, default=0)
    total_claims = Column(Integer, default=0)

    # Emergent-depth tracking per ADR-030 §D9. NULL = chunks-only (legacy
    # default); populated as the unlock cascade in §P4 approves higher tiers.
    unlocked_levels = Column(ARRAY(Integer))

    # Full-text search
    tsv_search = Column(TSVECTOR)

    __table_args__ = (
        CheckConstraint(
            "conversation_type IN ('live_audio', 'transcript', 'chat', 'hybrid')",
            name='valid_conversation_type'
        ),
        CheckConstraint(
            "visibility IN ('private', 'shared', 'public')",
            name='valid_visibility'
        ),
        Index('idx_conversations_owner', 'owner_id'),
        Index('idx_conversations_started', 'started_at'),
        Index('idx_conversations_tsv', 'tsv_search', postgresql_using='gin'),
    )


class Utterance(Base):
    """Atomic unit of speech/text"""
    __tablename__ = "utterances"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)

    # Content
    text = Column(Text, nullable=False)
    text_cleaned = Column(Text)  # Normalized

    # Speaker
    speaker_id = Column(Text, nullable=False)
    speaker_name = Column(Text)
    speaker_role = Column(Text)
    speaker_source = Column(Text, nullable=False, server_default=sql_text("'session_default'"))
    speaker_confidence = Column(Float)
    speaker_revision = Column(Integer, nullable=False, server_default=sql_text("0"))

    # Temporal
    sequence_number = Column(Integer, nullable=False)
    timestamp_start = Column(Float)
    timestamp_end = Column(Float)
    duration_seconds = Column(Float)

    # Context
    chunk_id = Column(UUID(as_uuid=True))
    node_id = Column(UUID(as_uuid=True))
    thread_id = Column(UUID(as_uuid=True))
    # IndrasNet items.source_identifier — the immutable per-turn provenance
    # anchor carried across the LCT/IndrasNet boundary (P0). Lets node.source_ref
    # point back to exact raw turns + survives re-import. NULL for legacy/local-
    # only rows.
    source_identifier = Column(Text)

    # Metadata
    confidence_score = Column(Float)
    language = Column(Text, default='en')
    emotion = Column(Text)
    energy_level = Column(Float)

    # Source-specific
    platform_metadata = Column(JSONB)
    # Word-level timings populated by the diarization-refinement pass
    # (live STT post-flush) OR the openai_audio HTTP import with
    # timestamp_granularities=["word"]. Shape:
    # [{word: str, start: float, end: float, confidence?: float}, ...]
    # Pre-requisite for the Descript-style word-synced transcript UI.
    word_timings = Column(JSONB)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "(timestamp_start IS NULL AND timestamp_end IS NULL) OR "
            "(timestamp_end IS NULL) OR "
            "(timestamp_end >= timestamp_start)",
            name='valid_timestamps'
        ),
        Index('idx_utterances_conversation', 'conversation_id', 'sequence_number'),
        Index('idx_utterances_speaker', 'conversation_id', 'speaker_id'),
        Index('idx_utterances_speaker_source', 'conversation_id', 'speaker_source'),
        Index('idx_utterances_chunk', 'chunk_id'),
        Index('idx_utterances_node', 'node_id'),
        Index('idx_utterances_thread', 'thread_id'),
        Index('idx_utterances_timestamp', 'conversation_id', 'timestamp_start'),
    )


class TranscriptEvent(Base):
    __tablename__ = "transcript_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    utterance_id = Column(UUID(as_uuid=True), ForeignKey('utterances.id', ondelete='CASCADE'), nullable=True)
    provider = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)  # 'partial' | 'final'
    text = Column(Text, nullable=False)
    word_timestamps = Column(JSONB)
    segment_timestamps = Column(JSONB)
    speaker_id = Column(Text)
    sequence_number = Column(Integer, nullable=False)
    event_metadata = Column("metadata", JSONB)
    received_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_transcript_events_conversation', 'conversation_id'),
        Index('idx_transcript_events_provider', 'provider'),
        Index('idx_transcript_events_event_type', 'event_type'),
        Index('idx_transcript_events_utterance', 'utterance_id'),
        CheckConstraint("event_type IN ('partial', 'final')", name='check_event_type'),
    )


class SpeakerAudioReference(Base):
    """Persisted audio clips for known speakers across sessions."""
    __tablename__ = "speaker_audio_references"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    speaker_id = Column(Text, nullable=False)
    speaker_name = Column(Text, nullable=False)

    # Audio data (WAV format stored as bytes)
    audio_wav = Column(LargeBinary(length=10_000_000))  # ~10MB max
    sample_rate_hz = Column(Integer, nullable=False, default=16000)

    # Source context
    source_conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'))
    source_utterance_id = Column(UUID(as_uuid=True), ForeignKey('utterances.id', ondelete='SET NULL'))
    source_timestamp_start = Column(Float)
    source_timestamp_end = Column(Float)

    # Quality indicators
    duration_seconds = Column(Float)
    clip_quality_score = Column(Float)  # 0-1 confidence from STT

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_speaker_audio_speaker', 'speaker_id', 'speaker_name'),
        Index('idx_speaker_audio_conversation', 'source_conversation_id'),
    )


class SpeakerSegment(Base):
    """Immutable diarization evidence aligned to a conversation time window."""

    __tablename__ = "speaker_segments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        UUID(as_uuid=True),
        ForeignKey('conversations.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_utterance_id = Column(
        UUID(as_uuid=True),
        ForeignKey('utterances.id', ondelete='SET NULL'),
        nullable=True,
    )

    provider = Column(Text, nullable=False)
    model = Column(Text)
    transport = Column(Text)
    speaker_id = Column(Text, nullable=False)
    text = Column(Text)

    timestamp_start = Column(Float)
    timestamp_end = Column(Float)
    relative_start = Column(Float)
    relative_end = Column(Float)
    window_timestamp_start = Column(Float)
    window_timestamp_end = Column(Float)

    confidence_score = Column(Float)
    segment_metadata = Column(JSONB)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "(timestamp_start IS NULL AND timestamp_end IS NULL) OR "
            "(timestamp_end IS NULL) OR "
            "(timestamp_end >= timestamp_start)",
            name='valid_speaker_segment_timestamps'
        ),
        CheckConstraint(
            "(relative_start IS NULL AND relative_end IS NULL) OR "
            "(relative_end IS NULL) OR "
            "(relative_end >= relative_start)",
            name='valid_speaker_segment_relative_timestamps'
        ),
        Index('idx_speaker_segments_conversation', 'conversation_id'),
        Index('idx_speaker_segments_source_utterance', 'source_utterance_id'),
        Index('idx_speaker_segments_speaker', 'conversation_id', 'speaker_id'),
        Index('idx_speaker_segments_timestamp', 'conversation_id', 'timestamp_start'),
    )


class SpeakerCorrectionEvent(Base):
    """Audit log of every user-driven speaker rename. Per ADR-032 Part H.

    v1: writes happen when the user renames a speaker via the transcript
    inline edit OR the NodeDetail panel. ``time_window_seconds`` records
    the ± window around the corrected utterance that gets hard-relabeled.

    v2 (ADR-033 future): same rows serve as labeled training data for
    voice-embedding-based propagation. The ``source`` field grows to
    include ``voice_propagation_auto`` for system-applied corrections.
    """

    __tablename__ = "speaker_correction_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        UUID(as_uuid=True),
        ForeignKey('conversations.id', ondelete='CASCADE'),
        nullable=False,
    )
    utterance_id = Column(
        UUID(as_uuid=True),
        ForeignKey('utterances.id', ondelete='CASCADE'),
        nullable=False,
    )
    prior_speaker = Column(Text, nullable=False)
    new_speaker = Column(Text, nullable=False)
    time_window_seconds = Column(Integer, nullable=False, server_default=sql_text("300"))
    # Free-text source: "transcript_inline" | "node_detail_panel" |
    # "imported" | future "voice_propagation_auto".
    source = Column(Text, nullable=False)
    user_id = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index('idx_speaker_corrections_conversation', 'conversation_id', 'created_at'),
        Index('idx_speaker_corrections_utterance', 'utterance_id'),
    )

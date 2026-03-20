"""User interaction models: Bookmark, EditsLog."""

import uuid

from sqlalchemy import (
    Column, Float, Boolean, Text, DateTime,
    ForeignKey, Index, CheckConstraint, ARRAY, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func

from .base import Base


class Bookmark(Base):
    """User bookmarks for conversation turns/nodes"""
    __tablename__ = "bookmarks"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)

    # What's bookmarked
    utterance_ids = Column(ARRAY(UUID(as_uuid=True)))  # Array of utterance UUIDs in this turn
    turn_id = Column(Text)  # Ephemeral turn ID (e.g., "turn_5")
    speaker_id = Column(Text)  # Who spoke in this turn

    # Content
    turn_summary = Column(Text)  # Short preview of the turn
    full_text = Column(Text)  # Full text of the bookmarked turn
    notes = Column(Text)  # User's notes about this bookmark

    # Metadata
    created_by = Column(Text, default='anonymous')
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_bookmark_conversation', 'conversation_id'),
        Index('idx_bookmark_speaker', 'speaker_id'),
        Index('idx_bookmark_created_by', 'created_by'),
        Index('idx_bookmark_created_at', 'created_at'),
    )


class EditsLog(Base):
    """Training data from user corrections"""
    __tablename__ = "edits_log"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)

    # Target
    target_type = Column(Text, nullable=False)  # 'node', 'relationship', 'cluster', 'speaker_attribution'
    target_id = Column(UUID(as_uuid=True), nullable=False)

    # Edit
    field_name = Column(Text, nullable=False)
    old_value = Column(Text)
    new_value = Column(Text)

    # Context
    edit_type = Column(Text, nullable=False)  # 'correction', 'addition', 'deletion', 'merge', 'split'
    user_comment = Column(Text)  # Contemporaneous rationale (set at creation, immutable)
    annotations = Column(Text)  # Post-hoc review notes (appended via feedback endpoint)

    # User
    user_id = Column(Text, nullable=False)
    actor_type = Column(Text, nullable=False, server_default='human')  # human|llm_suggestion|import_correction|bulk_operation
    user_confidence = Column(Float, default=1.0)

    # Training
    exported_for_training = Column(Boolean, default=False)
    training_dataset_id = Column(Text)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "target_type IN ('node', 'relationship', 'cluster', 'speaker_attribution', 'claim', 'utterance')",
            name='valid_target_type'
        ),
        CheckConstraint(
            "edit_type IN ('correction', 'addition', 'deletion', 'merge', 'split')",
            name='valid_edit_type'
        ),
        Index('idx_edits_conversation', 'conversation_id'),
        Index('idx_edits_target', 'target_type', 'target_id'),
        Index('idx_edits_training', 'exported_for_training', postgresql_where=text("exported_for_training = false")),
    )



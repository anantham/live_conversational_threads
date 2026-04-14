"""Durable observability models for live Threads session analytics."""

import uuid

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from .base import Base


class ThreadSession(Base):
    """Durable lifecycle row for a live Threads session."""

    __tablename__ = "thread_sessions"

    session_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_id = Column(Text, nullable=False)
    entrypoint = Column(Text, nullable=False, server_default="live_threads")
    status = Column(Text, nullable=False, server_default="started")
    terminal_reason = Column(Text)

    stt_provider = Column(Text)
    stt_transport = Column(Text)
    runtime_mode = Column(Text)

    client_metadata = Column(JSONB)
    session_metadata = Column(JSONB)

    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at = Column(DateTime(timezone=True))
    duration_ms = Column(Integer)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint(
            "status IN ('started', 'active', 'completed', 'failed', 'abandoned')",
            name="check_thread_session_status",
        ),
        Index("idx_thread_sessions_conversation", "conversation_id"),
        Index("idx_thread_sessions_started", "started_at"),
        Index("idx_thread_sessions_status", "status"),
        Index("idx_thread_sessions_owner", "owner_id"),
    )


class ThreadSessionEvent(Base):
    """Structured durable event for a live Threads session."""

    __tablename__ = "thread_session_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(
        UUID(as_uuid=True),
        ForeignKey("thread_sessions.session_id", ondelete="CASCADE"),
        nullable=False,
    )
    conversation_id = Column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )

    stage = Column(Text, nullable=False)
    level = Column(Text, nullable=False, server_default="info")
    event_type = Column(Text, nullable=False)
    code = Column(Text)
    message = Column(Text)
    context = Column(JSONB)
    metrics = Column(JSONB)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "level IN ('debug', 'info', 'warning', 'error')",
            name="check_thread_session_event_level",
        ),
        Index("idx_thread_session_events_session", "session_id", "created_at"),
        Index("idx_thread_session_events_conversation", "conversation_id", "created_at"),
        Index("idx_thread_session_events_stage", "stage"),
        Index("idx_thread_session_events_type", "event_type"),
        Index("idx_thread_session_events_level", "level"),
    )

"""System models: APICallsLog, AppSetting."""

import uuid

from sqlalchemy import (
    Column, Integer, Float, Text, DateTime,
    ForeignKey, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func

from .base import Base


class APICallsLog(Base):
    """LLM API call tracking and cost monitoring"""
    __tablename__ = "api_calls_log"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Context
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='SET NULL'))
    endpoint = Column(Text, nullable=False)  # Which API endpoint triggered this
    feature = Column(Text, nullable=False)  # 'node_generation', 'claim_detection', 'bias_detection', etc.

    # API Details
    provider = Column(Text, nullable=False)  # 'openai', 'anthropic', 'google'
    model = Column(Text, nullable=False)  # 'gpt-4', 'claude-sonnet-4', etc.

    # Tokens
    prompt_tokens = Column(Integer, nullable=False)
    completion_tokens = Column(Integer, nullable=False)
    total_tokens = Column(Integer, nullable=False)

    # Cost (USD)
    prompt_cost = Column(Float, nullable=False)
    completion_cost = Column(Float, nullable=False)
    total_cost = Column(Float, nullable=False)

    # Performance
    latency_ms = Column(Integer)  # Response time in milliseconds
    status = Column(Text, nullable=False)  # 'success', 'error', 'timeout'
    error_message = Column(Text)

    # Timestamps
    started_at = Column(DateTime(timezone=True), nullable=False)
    completed_at = Column(DateTime(timezone=True))

    # Metadata
    request_id = Column(Text)  # Provider's request ID for debugging

    __table_args__ = (
        Index('idx_api_calls_conversation', 'conversation_id'),
        Index('idx_api_calls_feature', 'feature'),
        Index('idx_api_calls_provider_model', 'provider', 'model'),
        Index('idx_api_calls_started', 'started_at'),
        Index('idx_api_calls_cost', 'total_cost'),
    )


class AppSetting(Base):
    __tablename__ = "app_settings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(Text, unique=True, nullable=False)
    value = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

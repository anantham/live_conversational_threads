"""System models: APICallsLog, AppSetting, PipelineArtifact, ServiceStatus."""

import uuid

from sqlalchemy import (
    Boolean, CheckConstraint, Column, Integer, Float, String, Text, DateTime,
    ForeignKey, Index, Date,
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


class LLMCallFact(Base):
    """Content-free, price-free durable fact for one logical LLM operation."""

    __tablename__ = "llm_call_facts"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))

    conversation_id = Column(Text)
    session_id = Column(Text)
    route_id = Column(Text)
    capability = Column(Text, nullable=False)

    provider_id = Column(Text)
    provider_type = Column(Text)
    model = Column(Text)
    attempt_number = Column(Integer)
    total_providers_tried = Column(Integer)

    prompt_name = Column(Text)
    prompt_version = Column(Text)

    prompt_tokens = Column(Integer)
    completion_tokens = Column(Integer)
    total_tokens = Column(Integer)

    latency_ms = Column(Integer, nullable=False)
    provider_latency_ms = Column(Float)
    status = Column(Text, nullable=False)
    finish_reason = Column(Text)
    error_code = Column(Text)
    request_id = Column(Text)

    started_at = Column(DateTime(timezone=True), nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('success', 'error', 'cache_hit')",
            name="check_llm_call_fact_status",
        ),
        Index("idx_llm_call_facts_started", "started_at"),
        Index("idx_llm_call_facts_conversation", "conversation_id", "started_at"),
        Index("idx_llm_call_facts_session", "session_id", "started_at"),
        Index("idx_llm_call_facts_provider_model", "provider_id", "model"),
        Index("idx_llm_call_facts_capability", "capability"),
        Index("idx_llm_call_facts_status", "status"),
    )


class AppSetting(Base):
    __tablename__ = "app_settings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(Text, unique=True, nullable=False)
    value = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PipelineArtifact(Base):
    """
    Cached pipeline artifacts for resume-on-failure.
    Each stage stores its output so failed LLM steps don't require re-transcription.
    """
    __tablename__ = "pipeline_artifacts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'))

    # Stage identification
    stage = Column(String(50), nullable=False)  # 'upload', 'transcription', 'chunking', 'accumulation', 'graph'
    stage_index = Column(Integer, default=0)  # For multi-part stages (chunk 1/41)

    # Cache key
    content_hash = Column(String(64))  # SHA256 of input for deduplication

    # Artifact data
    artifact_type = Column(String(50))  # 'audio', 'transcript', 'chunks', 'segment', 'nodes'
    artifact_path = Column(Text)  # File path for large data (audio, etc.)
    artifact_json = Column(JSONB)  # Inline JSON for small data

    # Metadata (named artifact_metadata to avoid SQLAlchemy reserved 'metadata')
    artifact_metadata = Column(JSONB)  # Telemetry, provider info, timing
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_artifacts_conv_stage', 'conversation_id', 'stage'),
        Index('idx_artifacts_hash', 'content_hash'),
    )


class ServiceStatus(Base):
    """
    Tracks health status of backend services (WhisperX, LLM, etc.)
    for UI indicators and routing decisions.
    """
    __tablename__ = "service_status"

    service_name = Column(String(50), primary_key=True)  # 'whisperx', 'modal_whisperx', 'lmstudio', 'modal_llm'
    is_healthy = Column(Boolean, default=False)
    last_check = Column(DateTime(timezone=True))
    latency_ms = Column(Integer)
    backend_type = Column(String(20))  # 'local', 'modal'
    url = Column(Text)
    model_name = Column(String(100))  # For LLM services
    service_metadata = Column(JSONB)  # Avoid SQLAlchemy reserved 'metadata'


class UsageQuota(Base):
    """Track daily usage for quota enforcement"""
    __tablename__ = "usage_quotas"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(String(255), nullable=False)  # User identifier (from session metadata or BYOK)
    quota_type = Column(String(50), nullable=False)  # 'stt_live', 'stt_import', 'llm'
    date = Column(DateTime(timezone=True).with_variant(Date, 'postgresql'), nullable=False)
    minutes_used = Column(Float, nullable=False, default=0.0)
    requests_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_usage_quotas_owner_type_date', 'owner_id', 'quota_type', 'date'),
        Index('idx_usage_quotas_date', 'date'),
    )

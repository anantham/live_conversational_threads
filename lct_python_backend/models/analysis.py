"""Epistemic analysis models: Claim, ArgumentTree, IsOughtConflation, Simulacra, Bias, Frame."""

import uuid

from sqlalchemy import (
    Column, Integer, Float, Boolean, Text, DateTime,
    ForeignKey, Index, CheckConstraint, ARRAY,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func

from .base import Base


class Claim(Base):
    """Three-layer claim taxonomy: factual, normative, and worldview claims"""
    __tablename__ = "claims"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)

    # Claim Content
    claim_text = Column(Text, nullable=False)
    claim_type = Column(Text, nullable=False)  # 'factual', 'normative', 'worldview'

    # For semantic search - OpenAI text-embedding-3-small produces 1536 dimensions
    embedding = Column(ARRAY(Float))  # Vector embedding for similarity search

    # Source
    utterance_ids = Column(ARRAY(UUID(as_uuid=True)), nullable=False)
    speaker_name = Column(Text)

    # Classification Confidence
    strength = Column(Float, nullable=False)  # How central is this claim? (0-1)
    confidence = Column(Float, nullable=False)  # Confidence in classification (0-1)

    # Factual Claims
    is_verifiable = Column(Boolean)  # Can this be fact-checked?
    verification_status = Column(Text)  # 'verified', 'false', 'misleading', 'unverifiable', 'pending'
    fact_check_result = Column(JSONB)  # Full Perplexity fact-check result
    fact_checked_at = Column(DateTime(timezone=True))

    # Normative Claims
    normative_type = Column(Text)  # 'prescription', 'evaluation', 'obligation', 'preference'
    implicit_values = Column(ARRAY(Text))  # e.g., ['efficiency', 'fairness', 'growth']

    # Worldview Claims
    worldview_category = Column(Text)  # e.g., 'economic_neoliberal', 'moral_utilitarian'
    hidden_premises = Column(ARRAY(Text))  # Unstated assumptions
    ideological_markers = Column(ARRAY(Text))  # Phrases that signal ideology

    # Relationships (for argument mapping)
    supports_claim_ids = Column(ARRAY(UUID(as_uuid=True)))  # Claims this supports
    contradicts_claim_ids = Column(ARRAY(UUID(as_uuid=True)))  # Claims this contradicts
    depends_on_claim_ids = Column(ARRAY(UUID(as_uuid=True)))  # Premises this depends on

    # Metadata
    analyzed_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_claims_conversation', 'conversation_id'),
        Index('idx_claims_node', 'node_id'),
        Index('idx_claims_type', 'claim_type'),
        Index('idx_claims_speaker', 'conversation_id', 'speaker_name'),
        CheckConstraint("claim_type IN ('factual', 'normative', 'worldview')", name='check_claim_type'),
        CheckConstraint('strength >= 0.0 AND strength <= 1.0', name='check_claim_strength'),
        CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_claim_confidence'),
        CheckConstraint(
            "verification_status IS NULL OR verification_status IN ('verified', 'false', 'misleading', 'unverifiable', 'pending')",
            name='check_verification_status'
        ),
        CheckConstraint(
            "normative_type IS NULL OR normative_type IN ('prescription', 'evaluation', 'obligation', 'preference')",
            name='check_normative_type'
        ),
    )


class ArgumentTree(Base):
    """Argument structure mapping: premises → conclusions"""
    __tablename__ = "argument_trees"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)

    # Tree Structure
    root_claim_id = Column(UUID(as_uuid=True), ForeignKey('claims.id'), nullable=False)
    tree_structure = Column(JSONB, nullable=False)  # Nested JSON tree

    # Metadata
    title = Column(Text)
    summary = Column(Text)

    # Analysis
    argument_type = Column(Text)  # 'deductive', 'inductive', 'abductive'
    is_valid = Column(Boolean)  # Logically valid structure?
    is_sound = Column(Boolean)  # Valid + true premises?
    confidence = Column(Float)
    identified_fallacies = Column(ARRAY(Text))
    circular_dependencies = Column(ARRAY(UUID(as_uuid=True)))

    # Relationships
    premise_claim_ids = Column(ARRAY(UUID(as_uuid=True)))
    conclusion_claim_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Display
    visualization_data = Column(JSONB)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_argument_trees_conversation', 'conversation_id'),
        Index('idx_argument_trees_node', 'node_id'),
        Index('idx_argument_trees_root_claim', 'root_claim_id'),
        CheckConstraint("argument_type IS NULL OR argument_type IN ('deductive', 'inductive', 'abductive')", name='check_argument_type'),
        CheckConstraint('confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)', name='check_argument_confidence'),
    )


class IsOughtConflation(Base):
    """Naturalistic fallacies: jumping from 'is' to 'ought'"""
    __tablename__ = "is_ought_conflations"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)

    # The Conflation
    descriptive_claim_id = Column(UUID(as_uuid=True), ForeignKey('claims.id'), nullable=False)
    normative_claim_id = Column(UUID(as_uuid=True), ForeignKey('claims.id'), nullable=False)

    # Analysis
    conflation_text = Column(Text, nullable=False)
    explanation = Column(Text, nullable=False)
    fallacy_type = Column(Text)  # 'naturalistic_fallacy', 'appeal_to_nature', etc.

    # Evidence
    utterance_ids = Column(ARRAY(UUID(as_uuid=True)), nullable=False)
    speaker_name = Column(Text)

    # Confidence
    strength = Column(Float, nullable=False)
    confidence = Column(Float, nullable=False)

    # Timestamp
    detected_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_is_ought_conversation', 'conversation_id'),
        Index('idx_is_ought_node', 'node_id'),
        Index('idx_is_ought_descriptive', 'descriptive_claim_id'),
        Index('idx_is_ought_normative', 'normative_claim_id'),
        CheckConstraint("fallacy_type IS NULL OR fallacy_type IN ('naturalistic_fallacy', 'appeal_to_nature', 'appeal_to_tradition', 'appeal_to_popularity')", name='check_fallacy_type'),
        CheckConstraint('strength >= 0.0 AND strength <= 1.0', name='check_is_ought_strength'),
        CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_is_ought_confidence'),
    )


class SimulacraAnalysis(Base):
    """Simulacra level detection results for conversation nodes"""
    __tablename__ = "simulacra_analysis"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'), nullable=False, unique=True)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id'), nullable=False)

    # Analysis results
    level = Column(Integer, nullable=False)  # 1-4
    confidence = Column(Float, nullable=False)  # 0.0-1.0
    reasoning = Column(Text)
    examples = Column(JSONB)  # Array of example quotes

    # Metadata
    analyzed_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_simulacra_node', 'node_id'),
        Index('idx_simulacra_conversation', 'conversation_id'),
        Index('idx_simulacra_level', 'level'),
        CheckConstraint('level >= 1 AND level <= 4', name='check_simulacra_level'),
        CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_simulacra_confidence'),
    )


class BiasAnalysis(Base):
    """Cognitive bias detection results for conversation nodes"""
    __tablename__ = "bias_analysis"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'), nullable=False)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id'), nullable=False)

    # Bias classification
    bias_type = Column(Text, nullable=False)  # e.g., "confirmation_bias", "anchoring"
    category = Column(Text, nullable=False)   # e.g., "confirmation", "decision", "social"

    # Analysis results
    severity = Column(Float, nullable=False)  # 0.0-1.0 (how severe is this bias)
    confidence = Column(Float, nullable=False)  # 0.0-1.0 (confidence in detection)
    description = Column(Text)  # Explanation of how bias manifests
    evidence = Column(JSONB)  # Array of example quotes

    # Metadata
    analyzed_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_bias_node', 'node_id'),
        Index('idx_bias_conversation', 'conversation_id'),
        Index('idx_bias_type', 'bias_type'),
        Index('idx_bias_category', 'category'),
        CheckConstraint('severity >= 0.0 AND severity <= 1.0', name='check_bias_severity'),
        CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_bias_confidence'),
    )


class FrameAnalysis(Base):
    """Implicit frame detection results for conversation nodes"""
    __tablename__ = "frame_analysis"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'), nullable=False)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id'), nullable=False)

    # Frame classification
    frame_type = Column(Text, nullable=False)  # e.g., "market_fundamentalism", "utilitarian"
    category = Column(Text, nullable=False)    # e.g., "economic", "moral", "political"

    # Analysis results
    strength = Column(Float, nullable=False)  # 0.0-1.0 (how strongly frame is present)
    confidence = Column(Float, nullable=False)  # 0.0-1.0 (confidence in detection)
    description = Column(Text)  # How the frame manifests
    evidence = Column(JSONB)  # Array of example quotes
    assumptions = Column(JSONB)  # Array of underlying assumptions
    implications = Column(Text)  # What this frame implies

    # Metadata
    analyzed_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_frame_node', 'node_id'),
        Index('idx_frame_conversation', 'conversation_id'),
        Index('idx_frame_type', 'frame_type'),
        Index('idx_frame_category', 'category'),
        CheckConstraint('strength >= 0.0 AND strength <= 1.0', name='check_frame_strength'),
        CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_frame_confidence'),
    )

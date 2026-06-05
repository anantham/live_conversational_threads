"""Graph models: Node, Relationship, Cluster."""

import uuid

from sqlalchemy import (
    Column, Integer, Float, Boolean, Text, DateTime,
    ForeignKey, Index, CheckConstraint, ARRAY, text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func

from .base import Base


class Node(Base):
    """Analyzed conversational topic/segment"""
    __tablename__ = "nodes"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    node_name = Column(Text, nullable=False)

    # Content
    summary = Column(Text, nullable=False)
    key_points = Column(ARRAY(Text))
    # Verbatim LLM-authored excerpt for this node. Per ADR-032's
    # autostructures commitment: persist raw evidence so post-hoc passes
    # (speaker rollup, edge enrichment, re-classification) don't need to
    # re-call the LLM. Nullable for legacy rows pre-migration.
    source_excerpt = Column(Text)

    # Type & Hierarchy
    node_type = Column(Text, default='conversational_thread')
    level = Column(Integer, default=1)  # Hierarchy level for zoom
    parent_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'))
    children_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Flags
    is_bookmark = Column(Boolean, default=False)
    is_contextual_progress = Column(Boolean, default=False)
    is_tangent = Column(Boolean, default=False)
    is_crux = Column(Boolean, default=False)
    # Conversation-dimension flags (action items + surprises are node properties;
    # agreement/disagreement are edges per ADR-032, derived into viewer markers).
    is_action_item = Column(Boolean, default=False)
    is_surprise = Column(Boolean, default=False)

    # Temporal Flow
    predecessor_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'))
    successor_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id'))

    # Source Data
    chunk_ids = Column(ARRAY(UUID(as_uuid=True)), nullable=False)
    utterance_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Speakers
    speaker_info = Column(JSONB)  # Primary speaker, contribution %
    speaker_transitions = Column(ARRAY(JSONB))  # Speaker handoffs
    dialogue_type = Column(Text)  # 'monologue', 'dialogue', 'multi-party', 'consensus'

    # Claims
    claim_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Temporal
    timestamp_start = Column(Float)
    timestamp_end = Column(Float)
    duration_seconds = Column(Float)

    # Clustering & Display
    cluster_info = Column(JSONB)  # Auto-clustering metadata
    display_preferences = Column(JSONB)  # Visualization settings

    # Canvas Position (for Obsidian export)
    canvas_x = Column(Integer)
    canvas_y = Column(Integer)
    canvas_width = Column(Integer, default=350)
    canvas_height = Column(Integer, default=200)

    # Zoom visibility
    zoom_level_visible = Column(ARRAY(Integer))  # Which zoom levels show this node

    # Metadata
    confidence_score = Column(Float)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint(
            "dialogue_type IS NULL OR dialogue_type IN ('monologue', 'dialogue', 'multi-party', 'consensus')",
            name='valid_dialogue_type'
        ),
        Index('idx_nodes_conversation', 'conversation_id'),
        Index('idx_nodes_temporal', 'conversation_id', 'timestamp_start'),
        Index('idx_nodes_speaker', 'conversation_id', text("((speaker_info->>'primary_speaker'))")),
        Index('idx_nodes_bookmarks', 'conversation_id', postgresql_where=text("is_bookmark = true")),
        Index('idx_nodes_tangents', 'conversation_id', postgresql_where=text("is_tangent = true")),
        Index('idx_nodes_level', 'conversation_id', 'level'),
    )


class Relationship(Base):
    """Edges/connections between nodes"""
    __tablename__ = "relationships"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)

    # Endpoints
    from_node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)
    to_node_id = Column(UUID(as_uuid=True), ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False)

    # Type
    relationship_type = Column(Text, nullable=False)
    relationship_subtype = Column(Text)

    # Description
    explanation = Column(Text)

    # Strength
    strength = Column(Float, default=1.0)
    confidence = Column(Float, default=1.0)

    # Evidence
    supporting_utterance_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Direction
    is_bidirectional = Column(Boolean, default=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("from_node_id != to_node_id", name='no_self_reference'),
        CheckConstraint("strength BETWEEN 0 AND 1", name='valid_strength'),
        CheckConstraint("confidence BETWEEN 0 AND 1", name='valid_confidence'),
        Index('idx_relationships_from', 'from_node_id'),
        Index('idx_relationships_to', 'to_node_id'),
        Index('idx_relationships_type', 'conversation_id', 'relationship_type'),
    )


class Cluster(Base):
    """Hierarchical node grouping"""
    __tablename__ = "clusters"

    # Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    cluster_name = Column(Text, nullable=False)

    # Hierarchy
    level = Column(Integer, nullable=False)  # 2=topics, 3=themes, etc.
    parent_cluster_id = Column(UUID(as_uuid=True), ForeignKey('clusters.id'))

    # Members
    node_ids = Column(ARRAY(UUID(as_uuid=True)), nullable=False)
    child_cluster_ids = Column(ARRAY(UUID(as_uuid=True)))

    # Summary
    summary = Column(Text)
    key_themes = Column(ARRAY(Text))

    # Metadata
    auto_generated = Column(Boolean, default=True)
    clustering_algorithm = Column(Text)  # 'semantic', 'temporal', 'speaker', 'manual'
    clustering_confidence = Column(Float)

    # Display
    color = Column(Text)
    icon = Column(Text)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_clusters_conversation', 'conversation_id'),
        Index('idx_clusters_level', 'conversation_id', 'level'),
    )

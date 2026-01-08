"""Add argument trees and is-ought conflation tables

Revision ID: add_argument_analysis
Revises: add_claims_table_with_vectors
Create Date: 2025-11-12 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_argument_analysis'
down_revision = 'add_claims_table_with_vectors'
branch_labels = None
depends_on = None


def upgrade():
    # Create argument_trees table
    op.create_table(
        'argument_trees',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('node_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False),

        # Tree Structure
        sa.Column('root_claim_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('claims.id'), nullable=False),
        sa.Column('tree_structure', postgresql.JSONB, nullable=False),  # Full tree as nested JSON

        # Metadata
        sa.Column('title', sa.Text),
        sa.Column('summary', sa.Text),

        # Analysis
        sa.Column('argument_type', sa.Text),  # 'deductive', 'inductive', 'abductive'
        sa.Column('is_valid', sa.Boolean),  # Logically valid structure?
        sa.Column('is_sound', sa.Boolean),  # Valid + true premises?
        sa.Column('confidence', sa.Float),
        sa.Column('identified_fallacies', postgresql.ARRAY(sa.Text)),
        sa.Column('circular_dependencies', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),  # Claim IDs forming circular reasoning

        # Relationships
        sa.Column('premise_claim_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),  # All premises
        sa.Column('conclusion_claim_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),  # All conclusions

        # Display
        sa.Column('visualization_data', postgresql.JSONB),  # For rendering tree UI

        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),

        # Constraints
        sa.CheckConstraint("argument_type IS NULL OR argument_type IN ('deductive', 'inductive', 'abductive')", name='check_argument_type'),
        sa.CheckConstraint('confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)', name='check_argument_confidence'),
    )

    # Create indexes
    op.create_index('idx_argument_trees_conversation', 'argument_trees', ['conversation_id'])
    op.create_index('idx_argument_trees_node', 'argument_trees', ['node_id'])
    op.create_index('idx_argument_trees_root_claim', 'argument_trees', ['root_claim_id'])

    # Create is_ought_conflations table
    op.create_table(
        'is_ought_conflations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('node_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False),

        # The Conflation
        sa.Column('descriptive_claim_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('claims.id'), nullable=False),  # "Is" statement
        sa.Column('normative_claim_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('claims.id'), nullable=False),  # "Ought" statement

        # Analysis
        sa.Column('conflation_text', sa.Text, nullable=False),  # Full text containing the conflation
        sa.Column('explanation', sa.Text, nullable=False),  # Why this is problematic
        sa.Column('fallacy_type', sa.Text),

        # Evidence
        sa.Column('utterance_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=False),
        sa.Column('speaker_name', sa.Text),

        # Confidence
        sa.Column('strength', sa.Float, nullable=False),
        sa.Column('confidence', sa.Float, nullable=False),

        # Metadata
        sa.Column('detected_at', sa.DateTime(timezone=True), server_default=sa.func.now()),

        # Constraints
        sa.CheckConstraint("fallacy_type IS NULL OR fallacy_type IN ('naturalistic_fallacy', 'appeal_to_nature', 'appeal_to_tradition', 'appeal_to_popularity')", name='check_fallacy_type'),
        sa.CheckConstraint('strength >= 0.0 AND strength <= 1.0', name='check_is_ought_strength'),
        sa.CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_is_ought_confidence'),
    )

    # Create indexes
    op.create_index('idx_is_ought_conversation', 'is_ought_conflations', ['conversation_id'])
    op.create_index('idx_is_ought_node', 'is_ought_conflations', ['node_id'])
    op.create_index('idx_is_ought_descriptive', 'is_ought_conflations', ['descriptive_claim_id'])
    op.create_index('idx_is_ought_normative', 'is_ought_conflations', ['normative_claim_id'])

    print("✅ Argument analysis tables created")


def downgrade():
    op.drop_table('is_ought_conflations')
    op.drop_table('argument_trees')

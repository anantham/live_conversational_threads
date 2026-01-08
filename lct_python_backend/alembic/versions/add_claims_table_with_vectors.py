"""Add claims table with pgvector support

Revision ID: add_claims_vectors
Revises: add_analysis_tables_weeks_11_13
Create Date: 2025-11-12 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision = 'add_claims_vectors'
down_revision = 'add_analysis_tables_weeks_11_13'
branch_labels = None
depends_on = None


def upgrade():
    # Enable pgvector extension
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')

    # Create claims table
    op.create_table(
        'claims',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('node_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('nodes.id', ondelete='CASCADE'), nullable=False),

        # Claim Content
        sa.Column('claim_text', sa.Text, nullable=False),
        sa.Column('claim_type', sa.Text, nullable=False),

        # For semantic search - OpenAI text-embedding-3-small produces 1536 dimensions
        sa.Column('embedding', postgresql.ARRAY(sa.Float), nullable=True),

        # Source
        sa.Column('utterance_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=False),
        sa.Column('speaker_name', sa.Text),

        # Classification Confidence
        sa.Column('strength', sa.Float, nullable=False),
        sa.Column('confidence', sa.Float, nullable=False),

        # Factual Claims
        sa.Column('is_verifiable', sa.Boolean),
        sa.Column('verification_status', sa.Text),
        sa.Column('fact_check_result', postgresql.JSONB),
        sa.Column('fact_checked_at', sa.DateTime(timezone=True)),

        # Normative Claims
        sa.Column('normative_type', sa.Text),
        sa.Column('implicit_values', postgresql.ARRAY(sa.Text)),

        # Worldview Claims
        sa.Column('worldview_category', sa.Text),
        sa.Column('hidden_premises', postgresql.ARRAY(sa.Text)),
        sa.Column('ideological_markers', postgresql.ARRAY(sa.Text)),

        # Relationships
        sa.Column('supports_claim_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),
        sa.Column('contradicts_claim_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),
        sa.Column('depends_on_claim_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),

        # Metadata
        sa.Column('analyzed_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),

        # Constraints
        sa.CheckConstraint('claim_type IN (\'factual\', \'normative\', \'worldview\')', name='check_claim_type'),
        sa.CheckConstraint('strength >= 0.0 AND strength <= 1.0', name='check_claim_strength'),
        sa.CheckConstraint('confidence >= 0.0 AND confidence <= 1.0', name='check_claim_confidence'),
        sa.CheckConstraint(
            'verification_status IS NULL OR verification_status IN (\'verified\', \'false\', \'misleading\', \'unverifiable\', \'pending\')',
            name='check_verification_status'
        ),
        sa.CheckConstraint(
            'normative_type IS NULL OR normative_type IN (\'prescription\', \'evaluation\', \'obligation\', \'preference\')',
            name='check_normative_type'
        ),
    )

    # Create indexes
    op.create_index('idx_claims_conversation', 'claims', ['conversation_id'])
    op.create_index('idx_claims_node', 'claims', ['node_id'])
    op.create_index('idx_claims_type', 'claims', ['claim_type'])
    op.create_index('idx_claims_speaker', 'claims', ['conversation_id', 'speaker_name'])
    op.create_index('idx_claims_verification', 'claims', ['verification_status'], postgresql_where=sa.text('verification_status IS NOT NULL'))

    # Full-text search index on claim_text
    op.execute("""
        CREATE INDEX idx_claims_fulltext ON claims
        USING gin(to_tsvector('english', claim_text))
    """)

    # Note: Vector similarity index will be created after embeddings are populated
    # This is because ivfflat index requires training data
    # Command to create later: CREATE INDEX idx_claims_embedding ON claims USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    print("✅ Claims table created with pgvector support")
    print("⚠️  Note: Run 'CREATE INDEX idx_claims_embedding ON claims USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);' after populating embeddings")


def downgrade():
    op.drop_table('claims')
    op.execute('DROP EXTENSION IF EXISTS vector')

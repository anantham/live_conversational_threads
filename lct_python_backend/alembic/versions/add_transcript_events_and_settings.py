"""Add transcript events and app settings tables

Revision ID: add_transcript_events_and_settings
Revises: add_claims_vectors
Create Date: 2026-01-12 06:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_transcript_events_and_settings'
down_revision = 'add_claims_vectors'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'app_settings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('key', sa.Text, nullable=False, unique=True),
        sa.Column('value', postgresql.JSONB, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    op.create_table(
        'transcript_events',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('utterance_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('utterances.id', ondelete='CASCADE'), nullable=True),
        sa.Column('provider', sa.Text, nullable=False),
        sa.Column('event_type', sa.Text, nullable=False),
        sa.Column('text', sa.Text, nullable=False),
        sa.Column('word_timestamps', postgresql.JSONB),
        sa.Column('segment_timestamps', postgresql.JSONB),
        sa.Column('speaker_id', sa.Text),
        sa.Column('sequence_number', sa.Integer, nullable=False),
        sa.Column('metadata', postgresql.JSONB),
        sa.Column('received_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_index('idx_transcript_events_conversation', 'transcript_events', ['conversation_id'])
    op.create_index('idx_transcript_events_provider', 'transcript_events', ['provider'])
    op.create_index('idx_transcript_events_event_type', 'transcript_events', ['event_type'])
    op.create_index('idx_transcript_events_utterance', 'transcript_events', ['utterance_id'])
    op.create_check_constraint(
        'check_event_type',
        'transcript_events',
        "event_type IN ('partial', 'final')",
    )


def downgrade():
    op.drop_table('transcript_events')
    op.drop_table('app_settings')

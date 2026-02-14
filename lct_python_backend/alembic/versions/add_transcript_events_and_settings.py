"""Add transcript events and app settings tables

Revision ID: add_transcript_events_settings
Revises: add_argument_analysis
Create Date: 2026-01-12 06:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_transcript_events_settings'
down_revision = 'add_argument_analysis'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if 'app_settings' not in existing_tables:
        op.create_table(
            'app_settings',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
            sa.Column('key', sa.Text, nullable=False, unique=True),
            sa.Column('value', postgresql.JSONB, nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),
        )

    if 'transcript_events' not in existing_tables:
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

    # Re-inspect after potential table creation to apply missing indexes/constraints.
    inspector = sa.inspect(bind)
    existing_indexes = {idx['name'] for idx in inspector.get_indexes('transcript_events')}
    existing_checks = {chk['name'] for chk in inspector.get_check_constraints('transcript_events')}

    if 'idx_transcript_events_conversation' not in existing_indexes:
        op.create_index('idx_transcript_events_conversation', 'transcript_events', ['conversation_id'])
    if 'idx_transcript_events_provider' not in existing_indexes:
        op.create_index('idx_transcript_events_provider', 'transcript_events', ['provider'])
    if 'idx_transcript_events_event_type' not in existing_indexes:
        op.create_index('idx_transcript_events_event_type', 'transcript_events', ['event_type'])
    if 'idx_transcript_events_utterance' not in existing_indexes:
        op.create_index('idx_transcript_events_utterance', 'transcript_events', ['utterance_id'])

    if 'check_event_type' not in existing_checks:
        op.create_check_constraint(
            'check_event_type',
            'transcript_events',
            "event_type IN ('partial', 'final')",
        )


def downgrade():
    op.drop_table('transcript_events')
    op.drop_table('app_settings')

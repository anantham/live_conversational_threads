"""Add speaker_audio_references table for cross-session voice library

Revision ID: speaker_audio_references
Revises: speaker_segments_materialized
Create Date: 2026-04-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = 'speaker_audio_references'
down_revision = 'speaker_segments_materialized'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'speaker_audio_references',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('speaker_id', sa.Text, nullable=False),
        sa.Column('speaker_name', sa.Text, nullable=False),
        sa.Column('audio_wav', sa.LargeBinary(length=10_000_000)),
        sa.Column('sample_rate_hz', sa.Integer, nullable=False, server_default='16000'),
        sa.Column('source_conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=True),
        sa.Column('source_utterance_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('utterances.id', ondelete='SET NULL'), nullable=True),
        sa.Column('source_timestamp_start', sa.Float),
        sa.Column('source_timestamp_end', sa.Float),
        sa.Column('duration_seconds', sa.Float),
        sa.Column('clip_quality_score', sa.Float),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )
    op.create_index('idx_speaker_audio_speaker', 'speaker_audio_references', ['speaker_id', 'speaker_name'])
    op.create_index('idx_speaker_audio_conversation', 'speaker_audio_references', ['source_conversation_id'])


def downgrade():
    op.drop_index('idx_speaker_audio_conversation', table_name='speaker_audio_references')
    op.drop_index('idx_speaker_audio_speaker', table_name='speaker_audio_references')
    op.drop_table('speaker_audio_references')
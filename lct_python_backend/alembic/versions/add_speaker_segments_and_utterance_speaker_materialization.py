"""Add speaker_segments table and utterance speaker materialization fields

Revision ID: speaker_segments_materialized
Revises: adr_018_edit_history
Create Date: 2026-03-20
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'speaker_segments_materialized'
down_revision = 'adr_018_edit_history'
branch_labels = None
depends_on = None


def _column_names(inspector, table_name: str):
    return {column["name"] for column in inspector.get_columns(table_name)}


def _index_names(inspector, table_name: str):
    return {index["name"] for index in inspector.get_indexes(table_name)}


def _check_names(inspector, table_name: str):
    return {check["name"] for check in inspector.get_check_constraints(table_name)}


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if 'speaker_segments' not in existing_tables:
        op.create_table(
            'speaker_segments',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
            sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
            sa.Column('source_utterance_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('utterances.id', ondelete='SET NULL'), nullable=True),
            sa.Column('provider', sa.Text, nullable=False),
            sa.Column('model', sa.Text),
            sa.Column('transport', sa.Text),
            sa.Column('speaker_id', sa.Text, nullable=False),
            sa.Column('text', sa.Text),
            sa.Column('timestamp_start', sa.Float),
            sa.Column('timestamp_end', sa.Float),
            sa.Column('relative_start', sa.Float),
            sa.Column('relative_end', sa.Float),
            sa.Column('window_timestamp_start', sa.Float),
            sa.Column('window_timestamp_end', sa.Float),
            sa.Column('confidence_score', sa.Float),
            sa.Column('segment_metadata', postgresql.JSONB),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        )

    inspector = sa.inspect(bind)
    utterance_columns = _column_names(inspector, 'utterances')
    if 'speaker_source' not in utterance_columns:
        op.add_column(
            'utterances',
            sa.Column('speaker_source', sa.Text(), nullable=False, server_default=sa.text("'session_default'")),
        )
    if 'speaker_confidence' not in utterance_columns:
        op.add_column('utterances', sa.Column('speaker_confidence', sa.Float(), nullable=True))
    if 'speaker_revision' not in utterance_columns:
        op.add_column(
            'utterances',
            sa.Column('speaker_revision', sa.Integer(), nullable=False, server_default=sa.text("0")),
        )

    inspector = sa.inspect(bind)
    utterance_indexes = _index_names(inspector, 'utterances')
    if 'idx_utterances_speaker_source' not in utterance_indexes:
        op.create_index('idx_utterances_speaker_source', 'utterances', ['conversation_id', 'speaker_source'])

    speaker_indexes = _index_names(inspector, 'speaker_segments')
    if 'idx_speaker_segments_conversation' not in speaker_indexes:
        op.create_index('idx_speaker_segments_conversation', 'speaker_segments', ['conversation_id'])
    if 'idx_speaker_segments_source_utterance' not in speaker_indexes:
        op.create_index('idx_speaker_segments_source_utterance', 'speaker_segments', ['source_utterance_id'])
    if 'idx_speaker_segments_speaker' not in speaker_indexes:
        op.create_index('idx_speaker_segments_speaker', 'speaker_segments', ['conversation_id', 'speaker_id'])
    if 'idx_speaker_segments_timestamp' not in speaker_indexes:
        op.create_index('idx_speaker_segments_timestamp', 'speaker_segments', ['conversation_id', 'timestamp_start'])

    speaker_checks = _check_names(inspector, 'speaker_segments')
    if 'valid_speaker_segment_timestamps' not in speaker_checks:
        op.create_check_constraint(
            'valid_speaker_segment_timestamps',
            'speaker_segments',
            "(timestamp_start IS NULL AND timestamp_end IS NULL) OR "
            "(timestamp_end IS NULL) OR "
            "(timestamp_end >= timestamp_start)",
        )
    if 'valid_speaker_segment_relative_timestamps' not in speaker_checks:
        op.create_check_constraint(
            'valid_speaker_segment_relative_timestamps',
            'speaker_segments',
            "(relative_start IS NULL AND relative_end IS NULL) OR "
            "(relative_end IS NULL) OR "
            "(relative_end >= relative_start)",
        )


def downgrade():
    op.drop_index('idx_speaker_segments_timestamp', table_name='speaker_segments')
    op.drop_index('idx_speaker_segments_speaker', table_name='speaker_segments')
    op.drop_index('idx_speaker_segments_source_utterance', table_name='speaker_segments')
    op.drop_index('idx_speaker_segments_conversation', table_name='speaker_segments')
    op.drop_index('idx_utterances_speaker_source', table_name='utterances')
    op.drop_column('utterances', 'speaker_revision')
    op.drop_column('utterances', 'speaker_confidence')
    op.drop_column('utterances', 'speaker_source')
    op.drop_table('speaker_segments')

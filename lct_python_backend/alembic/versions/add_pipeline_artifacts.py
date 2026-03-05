"""Add pipeline_artifacts and service_status tables

Revision ID: add_pipeline_artifacts
Revises: add_transcript_events_settings
Create Date: 2026-03-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_pipeline_artifacts'
down_revision = 'add_transcript_events_settings'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    # Pipeline artifacts - cache for intermediate pipeline products
    if 'pipeline_artifacts' not in existing_tables:
        op.create_table(
            'pipeline_artifacts',
            sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
            sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE')),
            sa.Column('stage', sa.String(50), nullable=False),
            sa.Column('stage_index', sa.Integer, default=0),
            sa.Column('content_hash', sa.String(64)),
            sa.Column('artifact_type', sa.String(50)),
            sa.Column('artifact_path', sa.Text),
            sa.Column('artifact_json', postgresql.JSONB),
            sa.Column('artifact_metadata', postgresql.JSONB),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.create_index('idx_artifacts_conv_stage', 'pipeline_artifacts', ['conversation_id', 'stage'])
        op.create_index('idx_artifacts_hash', 'pipeline_artifacts', ['content_hash'])

    # Service status - health tracking for UI indicators
    if 'service_status' not in existing_tables:
        op.create_table(
            'service_status',
            sa.Column('service_name', sa.String(50), primary_key=True),
            sa.Column('is_healthy', sa.Boolean, default=False),
            sa.Column('last_check', sa.DateTime(timezone=True)),
            sa.Column('latency_ms', sa.Integer),
            sa.Column('backend_type', sa.String(20)),
            sa.Column('url', sa.Text),
            sa.Column('model_name', sa.String(100)),
            sa.Column('service_metadata', postgresql.JSONB),
        )


def downgrade():
    op.drop_table('service_status')
    op.drop_table('pipeline_artifacts')

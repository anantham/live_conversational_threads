"""ADR-018: Edit History Contracts — add actor_type/annotations, drop EditFeedback

Revision ID: adr_018_edit_history
Revises: add_intent_signals
Create Date: 2026-03-20

Adds:
  edits_log.actor_type  — TEXT DEFAULT 'human' (backfilled)
  edits_log.annotations — TEXT nullable (post-hoc review notes, separate from user_comment)

Drops:
  edit_feedback table — replaced by annotations column on edits_log
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'adr_018_edit_history'
down_revision: Union[str, Sequence[str], None] = 'add_intent_signals'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    edits_log_columns = {
        column["name"] for column in inspector.get_columns("edits_log")
    }

    # Add actor_type with default and backfill
    if 'actor_type' not in edits_log_columns:
        op.add_column(
            'edits_log',
            sa.Column('actor_type', sa.Text(), server_default='human', nullable=False),
        )
    # Add annotations column for post-hoc review notes
    if 'annotations' not in edits_log_columns:
        op.add_column(
            'edits_log',
            sa.Column('annotations', sa.Text(), nullable=True),
        )
    # Drop EditFeedback table (replaced by annotations column)
    if 'edit_feedback' in inspector.get_table_names():
        op.drop_table('edit_feedback')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    edits_log_columns = {
        column["name"] for column in inspector.get_columns("edits_log")
    }

    if 'annotations' in edits_log_columns:
        op.drop_column('edits_log', 'annotations')
    if 'actor_type' in edits_log_columns:
        op.drop_column('edits_log', 'actor_type')
    # Recreate edit_feedback table
    if 'edit_feedback' not in inspector.get_table_names():
        op.create_table(
            'edit_feedback',
            sa.Column('id', sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column('edit_id', sa.dialects.postgresql.UUID(as_uuid=True),
                      sa.ForeignKey('edits_log.id'), nullable=False),
            sa.Column('text', sa.Text(), nullable=False),
            sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.create_index('idx_edit_feedback_edit', 'edit_feedback', ['edit_id'])

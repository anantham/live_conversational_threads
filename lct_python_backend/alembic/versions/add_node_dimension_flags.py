"""Add is_action_item + is_surprise node dimension flags (conversation-dimension extraction).

Two new node-level boolean flags so the conversation map / .threads artifact can
surface post-call value beyond cruxes + tangents:

  - is_action_item: an explicit task/commitment/next-step a speaker agreed to do.
  - is_surprise:    new information, a realization, or something that changed a mind.

Agreement/disagreement are intentionally NOT node flags here — they are relational
and live on edges (ADR-032 supports/rebuts); the viewer derives per-node markers
from those edges. See docs/plans/2026-06-06-conversation-dimensions-extraction.md.

ADDITIVE + safe for a concurrently-running (pre-branch) backend: both columns get a
server_default of false, so inserts from code that doesn't know the columns still
land valid (not NULL). Reversible.

Revision ID: add_node_dimension_flags
Revises: add_users_and_backfill_owner
Create Date: 2026-06-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "add_node_dimension_flags"
down_revision: Union[str, Sequence[str], None] = "add_users_and_backfill_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "nodes",
        sa.Column("is_action_item", sa.Boolean(), nullable=True, server_default=sa.text("false")),
    )
    op.add_column(
        "nodes",
        sa.Column("is_surprise", sa.Boolean(), nullable=True, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("nodes", "is_surprise")
    op.drop_column("nodes", "is_action_item")

"""Add conversations.unlocked_levels column for emergent-depth tracking.

Per ADR-030 §D9, each conversation tracks which hierarchy tiers have
been unlocked by the cascade in §P4 (chunks always; ideas/topics/
themes/arcs as they earn it via the LLM-judge). The column starts as
``[1]`` (chunks always present) and grows monotonically.

This migration is independent of the pipeline transport rewiring (§Step
5b in the migration plan). The column is added now so that:

  - Browse / view UIs can surface "this conversation has 3 unlocked
    tiers" without re-walking the events.
  - Cross-conversation telemetry can build a depth histogram via a
    single ``SELECT array_length(unlocked_levels, 1)``.
  - When transports are wired in (Step 5b), they can populate the
    column directly from ``PipelineState.hierarchy.unlocked_levels``.

Until then, the column is unset (NULL) for old rows; reads should
default to ``[1]`` when NULL — both the API response shape and the
Conversation model treat NULL as "chunks-only".

Revision ID: add_unlocked_levels
Revises: fc20c9ad7b2e
Create Date: 2026-05-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "add_unlocked_levels"
down_revision: Union[str, Sequence[str], None] = "fc20c9ad7b2e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add conversations.unlocked_levels: integer[] tracking emergent depth."""
    op.add_column(
        "conversations",
        sa.Column(
            "unlocked_levels",
            sa.ARRAY(sa.Integer()),
            nullable=True,
            comment="Emergent-depth tier list per ADR-030 §D9. NULL = chunks-only.",
        ),
    )


def downgrade() -> None:
    """Drop conversations.unlocked_levels."""
    op.drop_column("conversations", "unlocked_levels")

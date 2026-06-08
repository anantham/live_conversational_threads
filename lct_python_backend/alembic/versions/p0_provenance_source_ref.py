"""P0: provenance + raw-retention columns (LCT x IndrasNet pipeline).

Per docs/plans/2026-06-08-lct-indrasnet-pipeline.md (codex-reviewed). Adds the
columns that make every graph node auditable back to source and let LCT
conversations key off IndrasNet's stable id — without arbitrary compression:

1. ``Utterance.source_identifier`` TEXT — the immutable per-turn provenance
   anchor from IndrasNet ``items.source_identifier``. NULL for legacy/local rows.
2. ``Node.source_ref`` JSONB — ``{utterance_ids, source_identifiers, start_seq,
   end_seq, coverage_pct}``; the auditable node->raw link. ``source_excerpt`` is
   demoted to a display snippet; THIS is the provenance mechanism.
3. ``Conversation.indrasnet_group_id`` TEXT — the IndrasNet stable conversation
   key this LCT conversation mirrors (so raw turns can be re-pulled).

All nullable for legacy rows; fully reversible.

Revision ID: p0_provenance_source_ref
Revises: add_node_dimension_flags
Create Date: 2026-06-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "p0_provenance_source_ref"
down_revision: Union[str, Sequence[str], None] = "add_node_dimension_flags"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "utterances",
        sa.Column("source_identifier", sa.Text(), nullable=True),
    )
    op.add_column(
        "nodes",
        sa.Column("source_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("indrasnet_group_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversations", "indrasnet_group_id")
    op.drop_column("nodes", "source_ref")
    op.drop_column("utterances", "source_identifier")

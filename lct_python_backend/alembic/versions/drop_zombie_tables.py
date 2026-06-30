"""Drop zombie tables: argument_trees, is_ought_conflations, clusters.

All three were created speculatively, have zero rows, no active service writing
to them, and were explicitly tombstoned in AUDIT_RATIONALITY_2026-05-30.md.
The permanent replacements are already in production:
  - Node.cluster_info JSONB  →  replaces clusters
  - Node.thread_id / thread_state columns  →  replaced clusters.level/hierarchy
  - argument_trees / is_ought_conflations  →  never had a service; no replacement planned

Revision ID: drop_zombie_tables
Revises: add_node_thread_columns
Create Date: 2026-06-30
"""

from typing import Sequence, Union

from alembic import op


revision: str = "drop_zombie_tables"
down_revision: Union[str, Sequence[str], None] = "add_node_thread_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop in dependency order: is_ought_conflations + argument_trees both FK into
    # claims — drop them first (source of FK), then clusters (self-referential only).
    op.drop_table("is_ought_conflations")
    op.drop_table("argument_trees")
    op.drop_table("clusters")


def downgrade() -> None:
    raise NotImplementedError(
        "These tables are intentionally dropped. Re-run the original creation "
        "migrations (add_argument_analysis, initial_schema) if rollback is needed."
    )

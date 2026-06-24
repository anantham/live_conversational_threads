"""Add Node.thread_id + Node.thread_state columns (#12 / ADR-058).

The LLM authors per-node thread structure (thread_id slug + thread_state
new_thread|continue_thread|return_to_thread). Persistence already extracts these
but only ever wrote them into the Node.cluster_info JSONB blob — there was no
column — so the API (NodeResponse) and the graph swim-lane layout (which read
thread_id/thread_state top-level) never saw them. This promotes them to real
Text columns.

  - thread_id is a SLUG (e.g. "thread::vision"), NOT a UUID -> Text, not UUID.
  - ADDITIVE + nullable: a concurrently-running old backend that doesn't know the
    columns still inserts valid rows (NULL). Reversible.
  - BACKFILL: existing LLM-path rows already carry these inside cluster_info, so
    we copy them across — no re-extraction needed for thread_id/thread_state.
    (is_tangent/is_crux are a separate, already-columnar story; old pre-2026-06-05
    rows are 0 there and need re-extraction, which this migration does NOT do.)

This is also a MERGE migration: the history had two open heads
(speaker_audio_references + add_usage_quotas); this unifies them so
`alembic upgrade head` is unambiguous again.

Revision ID: add_node_thread_columns
Revises: speaker_audio_references, add_usage_quotas
Create Date: 2026-06-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "add_node_thread_columns"
down_revision: Union[str, Sequence[str], None] = ("speaker_audio_references", "add_usage_quotas")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("nodes", sa.Column("thread_id", sa.Text(), nullable=True))
    op.add_column("nodes", sa.Column("thread_state", sa.Text(), nullable=True))
    # Backfill from the cluster_info JSONB mirror (->> returns NULL if key absent).
    op.execute(
        "UPDATE nodes SET thread_id = cluster_info->>'thread_id' "
        "WHERE thread_id IS NULL AND cluster_info->>'thread_id' IS NOT NULL"
    )
    op.execute(
        "UPDATE nodes SET thread_state = cluster_info->>'thread_state' "
        "WHERE thread_state IS NULL AND cluster_info->>'thread_state' IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("nodes", "thread_state")
    op.drop_column("nodes", "thread_id")

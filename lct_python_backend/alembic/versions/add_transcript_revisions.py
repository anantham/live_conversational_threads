"""add_transcript_revisions — decision-B: proposed transcript changes await operator review

Revision ID: add_transcript_revisions
Revises: subject_review_bundles
Create Date: 2026-06-26

The slow-pass (Attendee MP3 re-transcription) must NOT overwrite the live transcript
directly (audit A4).  Decision B replaces that with a review-gated flow:

  1. A source (slow-pass, manual resubmit, or future automated quality pass) proposes
     a new set of ASR segments for a conversation.
  2. A row is created here with status='pending'.
  3. The operator reviews (or rejects) via the API.
  4. On approval, `reconcile_and_patch_utterances` (previously a stub) applies the
     segments and triggers a graph rebuild.

Design constraints:
  - `proposed_segments` is the raw ASR output (list of {speaker, start, end, text}).
    Stored as JSONB; the approval handler feeds it back through the import pipeline.
  - `current_snapshot_utterance_count` is a lightweight checksum — if the conversation
    has been edited since the proposal was made, approval can flag a staleness warning
    without fetching the full text.
  - Only one pending revision per conversation at a time (enforced by the service,
    not a DB constraint — lets a new proposal supersede a stale pending one explicitly).
  - `source` tracks provenance: 'slow_pass' (Attendee MP3), 'resubmit' (operator),
    'manual' (direct API call).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_transcript_revisions"
down_revision: Union[str, Sequence[str], None] = "add_node_thread_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "transcript_revisions",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False, server_default="manual"),
        sa.Column("proposed_segments", sa.JSON(), nullable=False),
        sa.Column("current_snapshot_utterance_count", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_transcript_revisions_conversation_id",
        "transcript_revisions",
        ["conversation_id"],
    )
    op.create_index(
        "ix_transcript_revisions_status",
        "transcript_revisions",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_transcript_revisions_status", table_name="transcript_revisions")
    op.drop_index("ix_transcript_revisions_conversation_id", table_name="transcript_revisions")
    op.drop_table("transcript_revisions")

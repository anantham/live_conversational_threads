"""shared_conversation_links — Google-gated per-share access tokens

Revision ID: share_conversation_links
Revises: adr032_excerpts_words_corrs
Create Date: 2026-05-24

Adds the table that backs the public share-link feature. Each row is one
share token + the email allowlist that gates it. Recipients hit
/share/<token>, sign in with Google, the backend verifies their email
against the allowlist and returns the conversation if it matches.

Schema rationale:

  token             — URL-safe random string (the entire "is this share
                      valid?" identifier; long enough that brute force
                      is irrelevant — 32 bytes base64url ≈ 256 bits)
  conversation_id   — the conversation this share targets (FK by string,
                      not enforced at SQL level because conversations
                      themselves don't have a contracted PK across the
                      app)
  allowed_emails    — JSON array of lowercased emails; NULL means
                      "anyone with the link." We default to per-share
                      ACL but keep the public-by-link path available.
  created_at        — when the share was minted
  created_by_email  — operator who created the share (NULL today;
                      reserved for a future user model)
  revoked_at        — set when the operator kills the share. NULL =
                      active. Keeps the row for audit instead of
                      deleting; the share-fetch endpoint checks this.
  expires_at        — optional auto-expiry. NULL = never expires.
  view_count        — cheap usage signal
  last_viewed_at    — cheap recency signal; useful for "purge stale
                      shares" tooling later
  last_viewed_by    — email of the most recent verified viewer, for
                      the same operational reason

No FK constraint on conversation_id because the conversations row id
schema is inconsistent across the codebase (sometimes file_id, sometimes
canvas_id, sometimes UUID-like). The fetch endpoint validates by querying
the conversation directly, so referential integrity at SQL level isn't
load-bearing.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'share_conversation_links'
down_revision: Union[str, Sequence[str], None] = 'adr032_excerpts_words_corrs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'shared_conversation_links',
        sa.Column('token', sa.Text, primary_key=True),
        sa.Column('conversation_id', sa.Text, nullable=False),
        sa.Column('allowed_emails', sa.Text, nullable=True),  # JSON array of lowercased emails
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column('created_by_email', sa.Text, nullable=True),
        sa.Column('revoked_at', sa.DateTime, nullable=True),
        sa.Column('expires_at', sa.DateTime, nullable=True),
        sa.Column('view_count', sa.Integer, server_default='0', nullable=False),
        sa.Column('last_viewed_at', sa.DateTime, nullable=True),
        sa.Column('last_viewed_by', sa.Text, nullable=True),
    )
    op.create_index(
        'ix_shared_conversation_links_conversation_id',
        'shared_conversation_links',
        ['conversation_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_shared_conversation_links_conversation_id', table_name='shared_conversation_links')
    op.drop_table('shared_conversation_links')

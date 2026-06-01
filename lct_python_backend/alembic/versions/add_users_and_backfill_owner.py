"""Add users table + backfill conversation owner_id (ADR-034 Step 1).

Introduces per-user tenancy groundwork for the owner-isolation phase:

  1. Create ``users`` (opaque id -> Google identity map; see models/identity.py).
  2. Seed the single owner row (``usr_aditya`` -> adityaprasadiskool@gmail.com).
  3. Backfill ``conversations.owner_id``: the legacy default tenants
     (``default_user``, ``anonymous``, and the bare ``aditya`` value) are
     relabelled to the canonical ``usr_aditya``.

This is the "default-tenant collision" fix from the Step-1 plan (§F hazard
#1): before any owner-scoped read guard is enabled, all existing rows must
carry the real owner id, or the owner's own conversations would disappear
from their list.

NON-DESTRUCTIVE: only ``owner_id`` strings are rewritten. No node /
relationship / utterance / audio content is touched. Reversible: downgrade
relabels ``usr_aditya`` back to ``default_user`` and drops ``users``.

Revision ID: add_users_and_backfill_owner
Revises: share_conversation_links
Create Date: 2026-06-02
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "add_users_and_backfill_owner"
down_revision: Union[str, Sequence[str], None] = "share_conversation_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The canonical single-owner id (matches services/owner_context.DEFAULT_OWNER_ID)
# and the legacy values that collapse into it.
OWNER_ID = "usr_aditya"
OWNER_EMAIL = "adityaprasadiskool@gmail.com"
OWNER_DISPLAY = "Aditya"
LEGACY_OWNER_IDS = ("default_user", "anonymous", "aditya")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=255), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=True, unique=True),
        sa.Column("google_sub", sa.String(length=255), nullable=True, unique=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
    )

    # Seed the single owner. ON CONFLICT keeps this idempotent if re-run.
    op.execute(
        sa.text(
            """
            INSERT INTO users (id, email, display_name)
            VALUES (:id, :email, :display)
            ON CONFLICT (id) DO NOTHING
            """
        ).bindparams(id=OWNER_ID, email=OWNER_EMAIL, display=OWNER_DISPLAY)
    )

    # Backfill conversations: relabel legacy/default tenants to the owner.
    op.execute(
        sa.text(
            "UPDATE conversations SET owner_id = :owner "
            "WHERE owner_id = ANY(:legacy)"
        ).bindparams(owner=OWNER_ID, legacy=list(LEGACY_OWNER_IDS))
    )

    # usage_quotas also carry owner_id directly — relabel for consistency so
    # quota history follows the same tenant after isolation lands.
    op.execute(
        sa.text(
            "UPDATE usage_quotas SET owner_id = :owner "
            "WHERE owner_id = ANY(:legacy)"
        ).bindparams(owner=OWNER_ID, legacy=list(LEGACY_OWNER_IDS))
    )

    # thread_sessions also carry owner_id directly.
    op.execute(
        sa.text(
            "UPDATE thread_sessions SET owner_id = :owner "
            "WHERE owner_id = ANY(:legacy)"
        ).bindparams(owner=OWNER_ID, legacy=list(LEGACY_OWNER_IDS))
    )


def downgrade() -> None:
    # Relabel back to the historical default and drop the users table.
    op.execute(
        sa.text(
            "UPDATE conversations SET owner_id = 'default_user' WHERE owner_id = :owner"
        ).bindparams(owner=OWNER_ID)
    )
    op.execute(
        sa.text(
            "UPDATE usage_quotas SET owner_id = 'default_user' WHERE owner_id = :owner"
        ).bindparams(owner=OWNER_ID)
    )
    op.execute(
        sa.text(
            "UPDATE thread_sessions SET owner_id = 'default_user' WHERE owner_id = :owner"
        ).bindparams(owner=OWNER_ID)
    )
    op.drop_table("users")

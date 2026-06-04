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


def _table_exists(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def _relabel_owner(bind, table: str) -> None:
    """Relabel legacy owner ids -> the canonical owner, dialect-portable.

    Uses an ``IN (...)`` expansion (works on Postgres AND sqlite) rather than
    Postgres-only ``= ANY(:legacy)``. Skips tables that don't exist so the
    migration is safe on partially-provisioned / test databases.
    """
    if not _table_exists(bind, table):
        return
    params = {"owner": OWNER_ID}
    placeholders = []
    for i, legacy in enumerate(LEGACY_OWNER_IDS):
        key = f"legacy_{i}"
        params[key] = legacy
        placeholders.append(f":{key}")
    bind.execute(
        sa.text(
            f"UPDATE {table} SET owner_id = :owner "
            f"WHERE owner_id IN ({', '.join(placeholders)})"
        ).bindparams(**params)
    )


def upgrade() -> None:
    bind = op.get_bind()

    # Idempotent: only create the users table if it isn't already present
    # (re-running the migration on a DB that already has it must not error).
    if not _table_exists(bind, "users"):
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

    # Seed the single owner only if not already present (dialect-portable
    # idempotency via a SELECT-guard rather than Postgres ON CONFLICT).
    already = bind.execute(
        sa.text("SELECT 1 FROM users WHERE id = :id").bindparams(id=OWNER_ID)
    ).first()
    if already is None:
        bind.execute(
            sa.text(
                "INSERT INTO users (id, email, display_name) "
                "VALUES (:id, :email, :display)"
            ).bindparams(id=OWNER_ID, email=OWNER_EMAIL, display=OWNER_DISPLAY)
        )

    # Backfill: relabel legacy/default tenants to the owner across every table
    # that carries owner_id. Skips absent tables; portable across PG + sqlite.
    for table in ("conversations", "usage_quotas", "thread_sessions"):
        _relabel_owner(bind, table)


def downgrade() -> None:
    """Relabel the owner back to the historical default and drop ``users``.

    LOSSY-BY-DESIGN: this collapses *every* row currently owned by ``usr_aditya``
    back to ``default_user``, including any conversations created AFTER upgrade.
    A label-collapse cannot distinguish pre-existing rows from new ones — the
    original (default_user / anonymous / aditya) distinction is not recoverable.
    For a single-owner deployment this is harmless (one tenant either way); do
    NOT rely on it to perfectly restore multi-tenant state. Skips absent tables.
    """
    bind = op.get_bind()
    for table in ("conversations", "usage_quotas", "thread_sessions"):
        if _table_exists(bind, table):
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET owner_id = 'default_user' "
                    f"WHERE owner_id = :owner"
                ).bindparams(owner=OWNER_ID)
            )
    if _table_exists(bind, "users"):
        op.drop_table("users")

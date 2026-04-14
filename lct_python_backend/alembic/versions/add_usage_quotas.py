"""Add usage quotas table for STT quota enforcement.

Revision ID: add_usage_quotas
Revises: add_thread_session_observability
Create Date: 2026-04-14
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "add_usage_quotas"
down_revision = "add_thread_session_observability"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "usage_quotas" not in existing_tables:
        op.create_table(
            "usage_quotas",
            sa.Column(
                "id",
                postgresql.UUID(as_uuid=True),
                primary_key=True,
                server_default=sa.text("gen_random_uuid()"),
            ),
            sa.Column("owner_id", sa.String(255), nullable=False),
            sa.Column("quota_type", sa.String(50), nullable=False),
            sa.Column(
                "date",
                sa.DateTime(timezone=True),
                nullable=False,
            ),
            sa.Column("minutes_used", sa.Float(), nullable=False, server_default="0"),
            sa.Column("requests_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                onupdate=sa.text("now()"),
            ),
        )
        op.create_index(
            "idx_usage_quotas_owner_type_date",
            "usage_quotas",
            ["owner_id", "quota_type", "date"],
        )
        op.create_index(
            "idx_usage_quotas_date",
            "usage_quotas",
            ["date"],
        )


def downgrade():
    op.drop_index("idx_usage_quotas_date", table_name="usage_quotas")
    op.drop_index("idx_usage_quotas_owner_type_date", table_name="usage_quotas")
    op.drop_table("usage_quotas")
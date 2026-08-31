"""add facts-only durable LLM call telemetry

Revision ID: add_llm_call_facts
Revises: add_transcript_revisions
Create Date: 2026-08-31

ADR-064 intentionally creates a new table instead of coercing unknown prices
into the older cost-bearing ``api_calls_log`` schema. No content-bearing fields
exist in this table.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_llm_call_facts"
down_revision: Union[str, Sequence[str], None] = "add_transcript_revisions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_call_facts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=True),
        sa.Column("session_id", sa.Text(), nullable=True),
        sa.Column("route_id", sa.Text(), nullable=True),
        sa.Column("capability", sa.Text(), nullable=False),
        sa.Column("provider_id", sa.Text(), nullable=True),
        sa.Column("provider_type", sa.Text(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("attempt_number", sa.Integer(), nullable=True),
        sa.Column("total_providers_tried", sa.Integer(), nullable=True),
        sa.Column("prompt_name", sa.Text(), nullable=True),
        sa.Column("prompt_version", sa.Text(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("provider_latency_ms", sa.Float(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("finish_reason", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('success', 'error', 'cache_hit')",
            name="check_llm_call_fact_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_llm_call_facts_started", "llm_call_facts", ["started_at"])
    op.create_index(
        "idx_llm_call_facts_conversation",
        "llm_call_facts",
        ["conversation_id", "started_at"],
    )
    op.create_index(
        "idx_llm_call_facts_session",
        "llm_call_facts",
        ["session_id", "started_at"],
    )
    op.create_index(
        "idx_llm_call_facts_provider_model",
        "llm_call_facts",
        ["provider_id", "model"],
    )
    op.create_index("idx_llm_call_facts_capability", "llm_call_facts", ["capability"])
    op.create_index("idx_llm_call_facts_status", "llm_call_facts", ["status"])


def downgrade() -> None:
    op.drop_index("idx_llm_call_facts_status", table_name="llm_call_facts")
    op.drop_index("idx_llm_call_facts_capability", table_name="llm_call_facts")
    op.drop_index("idx_llm_call_facts_provider_model", table_name="llm_call_facts")
    op.drop_index("idx_llm_call_facts_session", table_name="llm_call_facts")
    op.drop_index("idx_llm_call_facts_conversation", table_name="llm_call_facts")
    op.drop_index("idx_llm_call_facts_started", table_name="llm_call_facts")
    op.drop_table("llm_call_facts")


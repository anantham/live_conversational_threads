"""Add durable thread session observability tables.

Revision ID: add_thread_session_observability
Revises: add_pipeline_artifacts
Create Date: 2026-04-14
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "add_thread_session_observability"
down_revision = "add_pipeline_artifacts"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "thread_sessions" not in existing_tables:
        op.create_table(
            "thread_sessions",
            sa.Column(
                "session_id",
                postgresql.UUID(as_uuid=True),
                primary_key=True,
                server_default=sa.text("gen_random_uuid()"),
            ),
            sa.Column(
                "conversation_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("conversations.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("owner_id", sa.Text(), nullable=False),
            sa.Column("entrypoint", sa.Text(), nullable=False, server_default="live_threads"),
            sa.Column("status", sa.Text(), nullable=False, server_default="started"),
            sa.Column("terminal_reason", sa.Text()),
            sa.Column("stt_provider", sa.Text()),
            sa.Column("stt_transport", sa.Text()),
            sa.Column("runtime_mode", sa.Text()),
            sa.Column("client_metadata", postgresql.JSONB()),
            sa.Column("session_metadata", postgresql.JSONB()),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("ended_at", sa.DateTime(timezone=True)),
            sa.Column("duration_ms", sa.Integer()),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                onupdate=sa.func.now(),
            ),
        )

    if "thread_session_events" not in existing_tables:
        op.create_table(
            "thread_session_events",
            sa.Column(
                "id",
                postgresql.UUID(as_uuid=True),
                primary_key=True,
                server_default=sa.text("gen_random_uuid()"),
            ),
            sa.Column(
                "session_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("thread_sessions.session_id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "conversation_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("conversations.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("stage", sa.Text(), nullable=False),
            sa.Column("level", sa.Text(), nullable=False, server_default="info"),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column("code", sa.Text()),
            sa.Column("message", sa.Text()),
            sa.Column("context", postgresql.JSONB()),
            sa.Column("metrics", postgresql.JSONB()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )

    inspector = sa.inspect(bind)
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("thread_sessions")}
    existing_checks = {chk["name"] for chk in inspector.get_check_constraints("thread_sessions")}

    if "idx_thread_sessions_conversation" not in existing_indexes:
        op.create_index("idx_thread_sessions_conversation", "thread_sessions", ["conversation_id"])
    if "idx_thread_sessions_started" not in existing_indexes:
        op.create_index("idx_thread_sessions_started", "thread_sessions", ["started_at"])
    if "idx_thread_sessions_status" not in existing_indexes:
        op.create_index("idx_thread_sessions_status", "thread_sessions", ["status"])
    if "idx_thread_sessions_owner" not in existing_indexes:
        op.create_index("idx_thread_sessions_owner", "thread_sessions", ["owner_id"])
    if "check_thread_session_status" not in existing_checks:
        op.create_check_constraint(
            "check_thread_session_status",
            "thread_sessions",
            "status IN ('started', 'active', 'completed', 'failed', 'abandoned')",
        )

    existing_event_indexes = {idx["name"] for idx in inspector.get_indexes("thread_session_events")}
    existing_event_checks = {
        chk["name"] for chk in inspector.get_check_constraints("thread_session_events")
    }
    if "idx_thread_session_events_session" not in existing_event_indexes:
        op.create_index(
            "idx_thread_session_events_session",
            "thread_session_events",
            ["session_id", "created_at"],
        )
    if "idx_thread_session_events_conversation" not in existing_event_indexes:
        op.create_index(
            "idx_thread_session_events_conversation",
            "thread_session_events",
            ["conversation_id", "created_at"],
        )
    if "idx_thread_session_events_stage" not in existing_event_indexes:
        op.create_index("idx_thread_session_events_stage", "thread_session_events", ["stage"])
    if "idx_thread_session_events_type" not in existing_event_indexes:
        op.create_index("idx_thread_session_events_type", "thread_session_events", ["event_type"])
    if "idx_thread_session_events_level" not in existing_event_indexes:
        op.create_index("idx_thread_session_events_level", "thread_session_events", ["level"])
    if "check_thread_session_event_level" not in existing_event_checks:
        op.create_check_constraint(
            "check_thread_session_event_level",
            "thread_session_events",
            "level IN ('debug', 'info', 'warning', 'error')",
        )


def downgrade():
    op.drop_table("thread_session_events")
    op.drop_table("thread_sessions")

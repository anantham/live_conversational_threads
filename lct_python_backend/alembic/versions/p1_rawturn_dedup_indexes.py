"""P1: structured-RawTurn dedup + turn-uniqueness indexes.

Per docs/plans/2026-06-17-p1-rawturn-data-contract.md (codex-reviewed, verdict
GO). Adds the DB-level uniqueness the POST /api/import/turns ingest relies on
(Pydantic validation is defense-in-depth, NOT the integrity guarantee):
  1. UNIQUE(conversation_id, sequence_number) WHERE source_identifier IS NOT NULL
  2. UNIQUE(conversation_id, source_identifier) WHERE source_identifier IS NOT NULL
  3. UNIQUE(owner_id, indrasnet_group_id) WHERE indrasnet_group_id IS NOT NULL
                                            AND deleted_at IS NULL

Migration safety (codex re-review #6): these unique indexes FAIL to create if
duplicate rows already exist (the prior schema permitted them). A PREFLIGHT audit
runs first and FAILS FAST with a diagnostic listing the offenders — it never
auto-deletes provenance rows; the owner remediates, then re-runs `alembic upgrade`.
Implemented as partial unique INDEXES (Postgres has no partial UNIQUE constraint).

Revision ID: p1_rawturn_dedup_indexes
Revises: p0_provenance_source_ref
Create Date: 2026-06-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "p1_rawturn_dedup_indexes"
down_revision: Union[str, Sequence[str], None] = "p0_provenance_source_ref"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (label, query) — each returns the duplicate GROUPS that would violate a new index.
_PREFLIGHT = (
    (
        "(conversation_id, sequence_number) in RawTurn utterances",
        # Scoped to RawTurn rows (source_identifier IS NOT NULL): legacy/live-STT
        # utterances legitimately reuse sequence_number within a conversation
        # (e.g. segment-resume restarts at 1), so a global index would be wrong.
        """
        SELECT conversation_id, sequence_number, COUNT(*) AS n
        FROM utterances
        WHERE source_identifier IS NOT NULL
        GROUP BY conversation_id, sequence_number
        HAVING COUNT(*) > 1
        """,
    ),
    (
        "(conversation_id, source_identifier) in utterances",
        """
        SELECT conversation_id, source_identifier, COUNT(*) AS n
        FROM utterances
        WHERE source_identifier IS NOT NULL
        GROUP BY conversation_id, source_identifier
        HAVING COUNT(*) > 1
        """,
    ),
    (
        "active (owner_id, indrasnet_group_id) in conversations",
        """
        SELECT owner_id, indrasnet_group_id, COUNT(*) AS n
        FROM conversations
        WHERE indrasnet_group_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY owner_id, indrasnet_group_id
        HAVING COUNT(*) > 1
        """,
    ),
)


def _preflight_or_fail() -> None:
    bind = op.get_bind()
    problems = []
    for label, query in _PREFLIGHT:
        rows = bind.execute(sa.text(query)).fetchall()
        if rows:
            sample = "; ".join(str(tuple(r)) for r in rows[:10])
            more = "" if len(rows) <= 10 else f" (+{len(rows) - 10} more)"
            problems.append(f"  - {len(rows)} duplicate {label}: {sample}{more}")
    if problems:
        raise RuntimeError(
            "p1_rawturn_dedup_indexes PREFLIGHT FAILED — existing duplicate rows "
            "would break the new unique indexes.\nThis migration will NOT delete "
            "provenance data for you; resolve these and re-run `alembic upgrade head`:\n"
            + "\n".join(problems)
        )


def upgrade() -> None:
    _preflight_or_fail()
    # Scoped to RawTurn rows only — legacy/live-STT utterances legitimately reuse
    # sequence_number within a conversation (verified on the dev DB: 7 existing
    # conversations had duplicate seq=1). RawTurn ingest guarantees dense unique
    # seqs (Pydantic + persist_turns), and a conversation's utterances are either
    # all-RawTurn or all-legacy (re-ingest replaces them), so this is safe.
    op.create_index(
        "uq_utterances_conv_seq",
        "utterances",
        ["conversation_id", "sequence_number"],
        unique=True,
        postgresql_where=sa.text("source_identifier IS NOT NULL"),
    )
    op.create_index(
        "uq_utterances_conv_srcid",
        "utterances",
        ["conversation_id", "source_identifier"],
        unique=True,
        postgresql_where=sa.text("source_identifier IS NOT NULL"),
    )
    op.create_index(
        "uq_conversations_owner_group",
        "conversations",
        ["owner_id", "indrasnet_group_id"],
        unique=True,
        postgresql_where=sa.text(
            "indrasnet_group_id IS NOT NULL AND deleted_at IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_conversations_owner_group", table_name="conversations")
    op.drop_index("uq_utterances_conv_srcid", table_name="utterances")
    op.drop_index("uq_utterances_conv_seq", table_name="utterances")

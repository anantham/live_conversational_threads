"""ADR-032: persist source_excerpt + word_timings + speaker corrections.

Three coordinated schema additions that ADR-032 (temporal swim-lane +
semantic edges + enrichment) depends on:

1. ``Node.source_excerpt`` TEXT — persist the LLM-authored excerpt
   verbatim so post-hoc passes (speaker rollup, edge enrichment,
   classification re-runs) don't need to re-call the LLM. Per the
   autostructures commitment: persist raw evidence; let intelligence
   interpret at query time.

2. ``Utterance.word_timings`` JSONB — array of
   ``[{word, start, end, confidence?}]`` populated by either the
   live diarization-refinement pass (which already runs) or the
   import openai_audio HTTP path (when called with
   ``timestamp_granularities=["word"]``). Pre-requisite for the
   Descript-style word-synced transcript UI in NodeDetail.

3. ``speaker_correction_events`` table — audit log + future training
   set for the speaker-identity inference work. Each user correction
   captured here (utterance_id, prior_speaker, new_speaker,
   time_window_seconds, source, user_id, created_at). v1 only uses
   this for the audit trail; v2 (ADR-033 future) uses it as labeled
   training data for voice embeddings.

Revision ID: adr032_excerpts_words_corrs
Revises: add_unlocked_levels
Create Date: 2026-05-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "adr032_excerpts_words_corrs"
down_revision: Union[str, Sequence[str], None] = "add_unlocked_levels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Node.source_excerpt — verbatim LLM-authored excerpt for the node.
    #    NULL for legacy rows; new rows populated by persist_graph.
    op.add_column(
        "nodes",
        sa.Column("source_excerpt", sa.Text(), nullable=True),
    )

    # 2. Utterance.word_timings — array of word-level timing objects.
    #    Shape: [{word: str, start: float, end: float, confidence?: float}, ...]
    #    NULL for legacy rows; populated by diarization-refinement pass.
    op.add_column(
        "utterances",
        sa.Column("word_timings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    # 3. speaker_correction_events — audit log of every speaker rename.
    #    v1: hard-relabel within the time_window_seconds around the corrected
    #    utterance (default ±300s / 5 min). v2 (ADR-033 future): same rows
    #    serve as labeled training data for voice-embedding propagation.
    op.create_table(
        "speaker_correction_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "utterance_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("utterances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Prior + new speaker_id strings (e.g. "SPEAKER_00", "A", or a display
        # alias). Free-text because speaker_id schema on utterances is free-text.
        sa.Column("prior_speaker", sa.Text(), nullable=False),
        sa.Column("new_speaker", sa.Text(), nullable=False),
        # Time window of utterances affected by this correction (seconds, ±).
        sa.Column(
            "time_window_seconds",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("300"),
        ),
        # Where the correction came from. v1: "transcript_inline" |
        # "node_detail_panel" | "imported". v2 (future) adds
        # "voice_propagation_auto" when the system applies it.
        sa.Column("source", sa.Text(), nullable=False),
        # Owner of the correction. Optional today (single-user). Forward-compat
        # for multi-user.
        sa.Column("user_id", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_speaker_corrections_conversation",
        "speaker_correction_events",
        ["conversation_id", "created_at"],
    )
    op.create_index(
        "idx_speaker_corrections_utterance",
        "speaker_correction_events",
        ["utterance_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_speaker_corrections_utterance",
        table_name="speaker_correction_events",
    )
    op.drop_index(
        "idx_speaker_corrections_conversation",
        table_name="speaker_correction_events",
    )
    op.drop_table("speaker_correction_events")
    op.drop_column("utterances", "word_timings")
    op.drop_column("nodes", "source_excerpt")

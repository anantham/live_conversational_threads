"""Add intent_signals and intent_signal_sightings tables (ADR-013)

Revision ID: add_intent_signals
Revises: add_pipeline_artifacts
Create Date: 2026-03-05

Implements the prayer / intent-signal primitive defined in ADR-013.
Two tables:
  intent_signals             — one row per detected pre-formal intention
  intent_signal_sightings    — one row per (signal, conversation) re-appearance

Both tables are append-only at the fact layer; status transitions are
updates, not deletes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'add_intent_signals'
down_revision: Union[str, Sequence[str], None] = 'add_pipeline_artifacts'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'intent_signals',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('uuid_generate_v4()')),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),

        # The prayer — immutable after detection
        sa.Column('raw_text', sa.Text, nullable=False),
        sa.Column('context_window', sa.Text, nullable=False),
        sa.Column('speaker_id', sa.Text, nullable=False),

        # Fact-layer anchors — immutable
        sa.Column('source_utterance_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),
        sa.Column('source_node_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('nodes.id', ondelete='SET NULL'), nullable=True),

        # Lifecycle
        sa.Column('status', sa.Text, nullable=False, server_default='active'),
        sa.Column('emerged_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),

        # Accumulation summary (denormalized; source of truth is sightings table)
        sa.Column('sighting_count', sa.Integer, nullable=False, server_default='1'),
        sa.Column('last_sighted_at', sa.DateTime(timezone=True)),
        sa.Column('last_sighted_conversation_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('conversations.id', ondelete='SET NULL'), nullable=True),

        # Detection metadata
        sa.Column('detection_confidence', sa.Float),
        sa.Column('detection_model', sa.Text),

        # Formalization bridge (Layer 1→2)
        sa.Column('candidate_formal_statement', sa.Text),
        sa.Column('formalization_offered_at', sa.DateTime(timezone=True)),
        sa.Column('human_reviewed', sa.Boolean, server_default='false'),
        sa.Column('human_review_note', sa.Text),
        sa.Column('formalized_claim_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('claims.id', ondelete='SET NULL'), nullable=True),
        sa.Column('formalized_node_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('nodes.id', ondelete='SET NULL'), nullable=True),

        # Display
        sa.Column('salience', sa.Float, server_default='0.5'),
        sa.Column('tags', postgresql.ARRAY(sa.Text)),

        # Timestamps
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )

    op.create_check_constraint(
        'check_intent_signal_status',
        'intent_signals',
        "status IN ('active', 'accumulating', 'ready', 'formalized', 'abandoned')",
    )
    op.create_check_constraint(
        'check_intent_signal_confidence',
        'intent_signals',
        'detection_confidence IS NULL OR (detection_confidence >= 0.0 AND detection_confidence <= 1.0)',
    )
    op.create_check_constraint(
        'check_intent_signal_salience',
        'intent_signals',
        'salience IS NULL OR (salience >= 0.0 AND salience <= 1.0)',
    )

    op.create_index('idx_intent_signals_conv_status', 'intent_signals',
                    ['conversation_id', 'status'])
    op.create_index('idx_intent_signals_status_salience', 'intent_signals',
                    ['status', sa.text('salience DESC')])
    op.create_index('idx_intent_signals_last_sighted_conv', 'intent_signals',
                    ['last_sighted_conversation_id'])
    op.create_index('idx_intent_signals_formalized_claim', 'intent_signals',
                    ['formalized_claim_id'])

    # ---- intent_signal_sightings ----------------------------------------
    op.create_table(
        'intent_signal_sightings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('uuid_generate_v4()')),
        sa.Column('intent_signal_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('intent_signals.id', ondelete='CASCADE'), nullable=False),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),

        sa.Column('utterance_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True))),
        sa.Column('context_note', sa.Text),
        sa.Column('sighting_confidence', sa.Float),

        sa.Column('sighted_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )

    op.create_check_constraint(
        'check_sighting_confidence',
        'intent_signal_sightings',
        'sighting_confidence IS NULL OR (sighting_confidence >= 0.0 AND sighting_confidence <= 1.0)',
    )

    op.create_index('idx_intent_signal_sightings_signal', 'intent_signal_sightings',
                    ['intent_signal_id'])
    op.create_index('idx_intent_signal_sightings_conv', 'intent_signal_sightings',
                    ['conversation_id'])
    # Enforce one sighting per (signal, conversation)
    op.create_index('uq_intent_signal_sightings', 'intent_signal_sightings',
                    ['intent_signal_id', 'conversation_id'], unique=True)


def downgrade() -> None:
    op.drop_table('intent_signal_sightings')
    op.drop_table('intent_signals')

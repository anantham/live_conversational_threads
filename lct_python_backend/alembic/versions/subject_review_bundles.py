"""subject_review_bundles — ADR-039 P2a subject-side privacy review storage

Revision ID: subject_review_bundles
Revises: p1_rawturn_dedup_indexes
Create Date: 2026-06-21

Backs the subject-side privacy review surface (LCT ADR-039, the P2 of IndrasNet
ADR-055). IndrasNet POSTs a SubjectReviewBundleV1 to /api/subject-review/import;
each row is one bundle the conversation *subject* reviews (Confirm / Redact-more /
Reject of the AI's redactions of THEIR OWN words). The subject's decisions are
relayed server-side back to IndrasNet, which merges + re-leak-verifies.

Schema rationale — browser-returnable content and server-only secrets live in
SEPARATE columns (ADR-039 §2, review finding #3/#8 — never round-trip the full
import body into a browser-served field):

  token           — URL-safe random id; the subject's review URL is
                    /subject-review/{token}. NOT the callback token.
  prayer_id       — the IndrasNet prayer instance; the ONLY relay-routing input
                    (the callback URL is derived server-side, never producer-fed).
  run_id          — the run this bundle belongs to (audit / staleness).
  callback_token  — single-use, run-bound IndrasNet callback token. SERVER-SIDE
                    ONLY: never serialized to any browser response, NULLed after
                    the first successful relay, never logged.
  subject_email   — normalized lowercased; the SINGLE allowed reviewer (no public
                    branch — distinct from shared_conversation_links.allowed_emails).
  subject_name    — capped display label only (<=120 chars).
  items_json      — ONLY the browser-returnable items
                    {position_in_doc, original_text, proposed_redaction} —
                    no token/url/ids/free-text. SCRUBBED (NULL) after a successful
                    relay (unredacted-own-words data minimization).
  decisions_json  — the subject's submitted decisions, persisted BEFORE the relay
                    (never lose decisions to a network failure).
  decision_hash   — sha256 of the canonical decisions; LCT binds irrevocably to
                    the FIRST set (immutable) — a different-hash resubmit is 409.
  relay_result    — allowlisted-scalar summary of IndrasNet's response on success
                    (NEVER a raw upstream body).
  relay_attempts  — retry counter.
  last_error      — sanitized failure note (no upstream body, no token).
  status          — pending | submitted | relayed | failed.
  created/submitted/relayed_at — lifecycle timestamps.
  expires_at      — optional auto-expiry (410 on read/write).
  revoked_at      — operator kill switch (410 on read/write).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "subject_review_bundles"
down_revision: Union[str, Sequence[str], None] = "p1_rawturn_dedup_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "subject_review_bundles",
        sa.Column("token", sa.Text, primary_key=True),
        sa.Column("prayer_id", sa.Integer, nullable=False),
        sa.Column("run_id", sa.Text, nullable=False),
        # Server-side secret — never returned to a browser, NULLed after relay.
        sa.Column("callback_token", sa.Text, nullable=True),
        sa.Column("subject_email", sa.Text, nullable=False),
        sa.Column("subject_name", sa.Text, nullable=True),
        # Browser-returnable items only; scrubbed (NULL) after successful relay.
        sa.Column("items_json", sa.Text, nullable=True),
        sa.Column("decisions_json", sa.Text, nullable=True),
        sa.Column("decision_hash", sa.Text, nullable=True),
        sa.Column("relay_result", sa.Text, nullable=True),
        sa.Column("relay_attempts", sa.Integer, server_default="0", nullable=False),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("status", sa.Text, server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("submitted_at", sa.DateTime, nullable=True),
        sa.Column("relayed_at", sa.DateTime, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("revoked_at", sa.DateTime, nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'submitted', 'relayed', 'failed')",
            name="ck_subject_review_bundles_status",
        ),
    )
    op.create_index(
        "ix_subject_review_bundles_prayer_id",
        "subject_review_bundles",
        ["prayer_id"],
    )
    op.create_index(
        "ix_subject_review_bundles_subject_email",
        "subject_review_bundles",
        ["subject_email"],
    )


def downgrade() -> None:
    op.drop_index("ix_subject_review_bundles_subject_email", table_name="subject_review_bundles")
    op.drop_index("ix_subject_review_bundles_prayer_id", table_name="subject_review_bundles")
    op.drop_table("subject_review_bundles")

# Next full public replay

Read-only parallel audit, 2026-09-08, code head `22bb4b9`.

The next milestone is a complete run through the existing shared stages, not
another component-only success. Preserve any real failure and its exact input.

## Required harness changes

1. Use a fresh isolated database per comparison arm, preserving the pinned
   public artifact's utterance IDs. `models/core.py` makes those IDs global
   primary keys; another conversation in the old database will conflict.
   Keep old runs intact. Bootstrap directly from the SHA-verified artifact,
   not from an unrelated OWNER_SOURCE conversation.
2. Bind configured owner before inference and check it matches the export
   owner. The opt-in export now uses get_current_owner_id; do not discover
   a mismatch only after a long generation run.
3. Wire the prepared pinned message counter through InterleavedRuntimeConfig
   after dependency approval and current server parity validation. The old
   runner still uses the byte-count default. Do not crop question history.
4. Use a unique run output directory. Record exact messages, requested/served
   model, usage, cache status, finish reason, policy and stage for each call,
   reusing the existing probe receipt pattern.
5. Run run_interleaved_stages unchanged initially. It includes passage memory,
   source/relation review, aggregation levels 2–5 and final question review.

## Test intent before harness implementation

- An existing source ID or mismatched artifact/owner fails before inference;
  no old run is overwritten.
- Fresh local/frontier arms retain identical source IDs, text, attribution and
  timestamps, with independent consent and immutable run metadata.
- Exact message receipts survive a validation failure; cache and served model
  cannot be mistaken for a fresh response from the requested model.
- Export completes under the same owner and uses a run-specific candidate path.

## Not solved by completing one run

Current shared stage result remains reconciliation_pending, and reconciliation
explicitly reports semantic_reconciliation_complete=False. Global thread and
question identity reconciliation is not established by selected relation reviews.
Whole-catalog aggregation and whole-question reviews can still hit context limits.
Production revision handling, fair frontier arm, independent review and deployment
remain required. Dependency approval is outstanding; no activation is implied.

# Exact Attendee retained-source identity

- An authenticated join may supply exact Google Calendar calendar_id/event_id;
  preserve these identifiers in conversation metadata and the durable session
  registry. Same-URL dedup cannot invent or replace an occurrence identity.
- Read original final Attendee TranscriptEvent rows with stable event IDs, never
  edited utterances or proposed revisions; identity mismatch/conflict/missing
  evidence returns no transcript segments.
- The retained-source GET requires an existing configured bearer token, fails
  closed without one, uses a read-only database transaction and has bounded
  deterministic pages. It performs no joins, provider fetches, backfills or writes.
- Preserve original caption-relative timing in event metadata and explicitly leave
  Drive-audio offset unknown. Missing timing stays null; no audio seek guarantee.
- Synthetic tests cover join propagation, recurring URL conflicts, restart-safe
  identity, exact/missing/mismatched reads, original-event persistence, pagination,
  unauthorized calls, absent auth configuration and no write/provider side effects.

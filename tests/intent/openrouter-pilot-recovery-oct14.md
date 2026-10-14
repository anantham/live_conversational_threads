# One-time OpenRouter pilot recovery, 2026-10-14

This is an OFF preparation for a later, separate H1 ruling. It does not authorize publication, live SQL, activation, or a provider call. The owner must verify the exact private subjects and provider-OFF state immediately before any approved operation.

## Assumptions and predicted outcomes

- The predecessor migrations through `0009` produce the expected schema. Locate the unique recovery entry at index10 and validate its contiguous predecessor prefix; later appended migrations must not change this historical fixture. A missing predecessor or malformed journal must fail the fixture before any positive assertion.
- The observed state has exactly four lifetime OpenRouter attempts: two previously released, two held, all uncompleted, all capped at 8192 output tokens, and both held attempts older than 15 minutes. If any count, age, cap, completion, or release state differs, the update changes zero rows. Confidence: 0.9 for the synthetic proof; live identity and state still require owner verification.
- On the exact state, only the two held `recovery_released_at` values become finite current timestamps. IDs, all other fields, four lifetime records, unrelated tables, and settings remain unchanged. Applying the update again changes zero rows.
- Worker admission frees the two holders while keeping the 20-attempt lifetime limit, two-holder concurrency limit, and 10-second interval. A synthetic valid completion marks only its new attempt completed. All `fetch` calls are intercepted; no actual provider traffic occurs.

Fallback: if fixture, schema, or state checks fail, leave the live recovery unattempted and return to owner review. No automatic retry or expiry follows.

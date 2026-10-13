# One-time Soniox pilot recovery, 2026-10-13

- Apply the new SQL to isolated SQLite produced by every earlier journal migration and seeded with synthetic data in unrelated public/private tables.
- Release exactly two old, 300-second unknown leases only when the entire Soniox table has exactly four lifetime rows; retain all rows and every other field. A second application has no effect.
- Refuse the update when any count, age, duration, or unknown-lease precondition drifts, including fresh, missing, extra, and already recovered reservations.
- Exercise Worker admission through its public route: old unknown leases block concurrency before recovery, then a valid synthetic mint succeeds after recovery; lifetime and active-holder limits remain effective. No network or paid provider call.

The owner must verify the two intended live identities and disabled providers before publication. This migration does not create an ongoing unknown-lease expiry policy.

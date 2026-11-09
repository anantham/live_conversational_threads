# One-time approved synthetic Soniox reservation recovery

- Apply the actual append-only recovery SQL to isolated, fully migrated SQLite state; release only exactly two unknown leases with a 300-second maximum and at least fifteen minutes of age.
- Preserve every row, lifetime attempt count, non-lease field, and known holder; do not refund admission or change provider quotas, identity, consent, or retention.
- Refuse recovery for fresh, extra, missing, wrong-duration, or already resolved unknown leases. Repeating the migration has no further effect.
- Existing issuer admission must still enforce concurrency and lifetime limits after recovery. Tests use synthetic records, no production database, credentials, or upstream provider calls.

Authority: the user approved the one-time recovery recommendation on 2026-10-07. This is a bounded data-only custom migration exception to the normal schema-only migration guideline, not an ongoing unknown-lease expiry policy. Fresh exact live-row and disabled-provider checks precede publication; native postflight must prove only the two intended lease fields changed before one controlled diagnostic mint.

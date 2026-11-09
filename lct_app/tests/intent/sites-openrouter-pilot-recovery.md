# One-time OpenRouter pilot admission recovery — test intent

- Apply the actual append-only migration to isolated SQLite with every predecessor migration installed. Exactly two old synthetic unresolved attempts release their concurrency slots while their records, lifetime count, token caps, and `completed_at` values remain intact.
- Refuse a data release when either attempt is fresh, completed, previously released, missing, has a token cap other than the exact 8192-token pilot setting, or is accompanied by another row. Applying the guarded update again has no effect.
- Through the public Worker, require the new migration for readiness; prove that recovery leaves lifetime and 10-second admission limits intact, known concurrent holders still block admission, and a valid generation still records `completed_at` without a recovery marker.
- Compare full synthetic Soniox, public, and private storage rows before and after recovery. Intercept provider fetch before importing the Worker; use no live provider, credentials, database, or user content.

Production recovery remains a separate owner decision. The prepared migration contains no live row identifiers and is never applied to native data by these checks.

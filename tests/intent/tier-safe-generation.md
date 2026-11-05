# Tier-safe generation test intent

- Through the public request/response adapter, preserve five authored tiers, skipped levels, overlapping parent choices, semantic edges, paths and exact source evidence in a portable .threads file and Discussion.
- Typed parent coordinates admit only higher tiers; refuse same/lower/self/missing/duplicate/ambiguous references and malformed type/level pairs without repairing meaning or mutating inputs.
- Keep legacy/v1 IDs and relationships unchanged; roots and short chunk-only conversations remain valid.
- Both public Worker backend routes use this contract with one admitted request and unchanged failure/cancellation/accounting behavior; synthetic fixtures intercept all network calls and use isolated in-memory storage before imports.
- Schema and adapter evidence is offline only. A successful live provider response is a separate reserved acceptance check; tests must not imply it occurred.

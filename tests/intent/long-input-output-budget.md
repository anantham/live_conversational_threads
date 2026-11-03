# Long-input output budget test intent

Context: on 2026-11-03 the owner chose "Raise to 16k for imports": live 5-minute sessions keep 8,192 output tokens, while imports and replay get 16,384 with the 90 s window (relayed by the parent session). Measured envelope: `docs/reviews/2026-11-03-long-input-envelope.md`.

- The server, not the client, picks the cap from the transcript's own length. Up to and including 5 minutes (the live-session envelope) uses `LCT_OPENROUTER_MAX_OUTPUT_TOKENS`; longer uses `LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS`. A client cannot ask for more.
- With the long cap unset or empty, behaviour is unchanged: long transcripts use the live cap. A long cap that is malformed, above 16,384 or below the live cap leaves generation unconfigured, never silently lower.
- The attempt ledger records the cap actually reserved. Migration 0019 widens its CHECK to 16,384 and preserves every row; the snapshot changes nothing else.
- Status reports both caps. Replay maps (always long) send the long cap, and the replay preflight prices it. The preflight accepts a bare provider endpoint tag as well as regional tags, matching the health check.
- Synthetic fixtures only; no provider is called.

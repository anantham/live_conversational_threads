# Long-input output budget test intent

Context: on 2026-11-03 the owner chose "Raise to 16k for imports": live 5-minute sessions keep 8,192 output tokens, while imports and replay get 16,384 with the 90 s window (relayed by the parent session). Measured envelope: `docs/reviews/2026-11-03-long-input-envelope.md`.

- The Worker picks the cap from the validated transcript's span (last end minus first start), never from a client flag. Up to and including 5 minutes (the live-session envelope) uses `LCT_OPENROUTER_MAX_OUTPUT_TOKENS`; longer uses `LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS`. Offset timestamps on a short clip keep the live cap. A client that pads a short clip's timestamps gets at most the long cap, the owner-approved per-attempt worst case. An invalid source is a 400 before admission. The map and replay routes share one function (`outputCapFor`), and the Gemini route applies the same caps, since it shares the token settings.
- With the long cap unset or empty, behaviour is unchanged: long transcripts use the live cap. A long cap that is malformed, above 16,384 or below the live cap leaves generation unconfigured, never silently lower.
- The attempt ledger records the cap actually reserved. Migration 0019 widens its CHECK to 16,384 with unqualified column names and preserves every row; the snapshot changes nothing else. If the long cap is set before 0019 is applied, a long admission returns 503 `schema_unavailable` with no provider call, and short transcripts still work.
- Status reports both caps. Replay maps (always long) send the long cap, and the replay preflight prices it. The preflight accepts a bare provider endpoint tag as well as regional tags, matching the health check.
- Synthetic fixtures only; no provider is called.

## Error paths (added 2026-11-04)
- A replay source the transcript validator rejects returns 400 `source` from output-cap sizing, reserves nothing and calls no provider.
- An admission storage error other than the 0019 CHECK failure stays a generic 503 `generation_failed`, never the "apply migration 0019" message, with no provider call.
- Both were red-proven by removing the guard each protects.

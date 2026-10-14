# OpenRouter synthetic one-attempt pilot — test intent (2026-10-14)

- Refuse missing explicit arm, changed browser adapter source, changed Site/model/provider/cap/readiness, and an existing exclusive attempt guard before any generation POST.
- After a durable guard claim, make at most one POST even on refusal, malformed output, timeout, or cancellation; leave the guard in place. Verify actual exclusive filesystem creation and reuse in an isolated temporary directory.
- Exercise the actual browser client with intercepted fetch, then read its portable `.threads` file and verify exact synthetic source and usable Discussion utterance links. An empty or mock-only result must fail.
- Accept a usable map with an empty optional conversation-path list, matching the production contract. Trigger timeout only after a bounded observed POST-start checkpoint to avoid a load-dependent fixture race.
- Output only fixed outcome codes, stage names, counts, and timings; never expose request IDs, raw response/error text, the synthetic transcript, or generated map content.

The test never opens a network connection or writes a generated artifact. A separately approved live run would use the fixed preview origin and a caller-supplied hash of the current adapter source.

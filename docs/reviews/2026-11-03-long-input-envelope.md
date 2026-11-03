# Long-input map generation envelope — measured 2026-11-03

**Question (owner goal):** how long a transcript maps reliably today, and whether 20-minute maps can be made to pass "at least 4 of 5 paid runs return a valid map" within about $1, before chunked generation is needed.

**Answer:** 20 minutes went from **1 of 4 to 10 of 10** after one prompt instruction asking for compact single-line JSON. Every failure before the change was the 8,192-token output cap. Chunked generation is not needed for 20 minutes. It is still the path for anything much longer, because output size varies about 3× between runs on identical input and the largest compact 20-minute map used 93% of the cap.

## Method

- Built Sites Worker (`npm run build:sites-worker`, branch `fix/long-input-reference-repair`) driven by a local harness with in-memory SQLite. Real OpenRouter calls only for generation. Metadata recorded per run; replies kept locally, not committed.
- Model and route as in production: `google/gemini-3.5-flash-lite`, `provider.only: ["google-vertex"]`, `data_collection: "deny"`, `max_tokens: 8192`, 90 s provider window.
- Input: the first 5/10/15/20 minutes of the public podcast transcript in `lct_app/public/experiments/overlapping.threads` (YouTube `6HmR9IaqM88`): 62/143/218/293 turns.
- "Valid" means the Worker returned 200 with a map that passed the full validator. Runs were sequential, each in a fresh process.

## Results

| Output format | Minutes | Valid maps | Completion tokens | Hit 8,192 cap | Seconds | Cost / run |
|---|---|---|---|---|---|---|
| pretty (before) | 5 | 3/3 | 2,757–3,185 | 0 | 8–9 | $0.0088 |
| pretty (before) | 10 | 3/3 | 3,622–7,360 | 0 | 9–16 | $0.0155 |
| pretty (before) | 15 | 1/3 | 5,276–8,175 | 2 | 13–19 | $0.0197 |
| pretty (before) | 20 | 1/4 | 5,213–8,178 | 3 | 13–20 | $0.0206 |
| compact (after) | 15 | 3/3 | 2,445–4,453 | 0 | 7–12 | $0.0106 |
| compact (after) | 20 | **10/10** | 2,594–7,594 | 0 | 7–18 | $0.0123 |

The 20-minute "before" row includes one earlier run on the same input. Total spend across all 26 runs: **$0.369**.

- **Every failure was `finish_reason: length`** (rejected at `choice_finish`). No reply showed the 3 November `node-` id drift, so the reference repair in this PR was never exercised live and reported no repairs.
- **Pretty-printing cost about 30% of characters.** Every "before" reply was indented: 27–31% of characters were whitespace and newlines. Compact replies had none.
- **Map quality held.** All 13 compact maps link 100% of utterances. 20-minute compact maps have 9–45 nodes (the one valid 20-minute "before" map had 18). One compact 20-minute map skipped the idea tier, which is allowed but thinner. Edges are mostly empty before and after; that predates this change.
- **Output size varies run to run.** On identical input, completion tokens range up to about 3× (2.6k–7.6k at 20 minutes compact). Richer maps cost more tokens, so the cap is a ceiling on map richness, not only on length.

## What this means

- **20 minutes now passes** with the existing 8,192 cap: 10/10, at about $0.012 per map. The one valid 20-minute pretty run cost $0.016, and pretty runs averaged $0.021 including capped failures.
- **Tail risk remains.** The largest compact 20-minute map used 93% of the cap, so a richer reply, a longer conversation, or denser speech could hit it again. Raising `LCT_OPENROUTER_MAX_OUTPUT_TOKENS` (the model allows 65,536) would remove the tail at 20 minutes, but it raises every attempt's worst-case cost. The replay budget formula (`sites/replayProvider.js`) and `replayWire`'s fixed 8,192 also need changing. That is an owner cost decision and was not made here.
- **Beyond about 20 minutes, chunked generation (option B) is still the scalable path.** Output grows with conversation length and with map richness, and a single call has one fixed output budget.

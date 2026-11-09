# Long-input map generation envelope — measured 2026-11-03

**Question (owner goal):** how long a transcript maps reliably today, and whether 20-minute maps can be made to pass "at least 4 of 5 paid runs return a valid map" within about $1, before chunked generation is needed.

**Answer:** on this benchmark transcript, 20-minute maps went from **1 of 4 to 19 of 20** after one system-prompt line asking for compact single-line JSON (wording A below). Before the change, every failure was the 8,192-token output cap. With compact output, none of 30 runs hit the cap. The remaining failures are reference errors the model makes (a paraphrased or wrong-tier parent id), plus one provider timeout. They are rejected exactly as before.

This meets the goal for this transcript. It does not prove 20-minute conversations in general fit (see Limits). Denser speech, populated edges or richer maps can still reach the cap, and chunked generation stays the path for long or dense inputs.

## Method

- Built Sites Worker (`npm run build:sites-worker`, branch `fix/long-input-reference-repair`) driven by a local harness with in-memory SQLite. Real OpenRouter calls only for generation. Metadata recorded per run; replies and maps kept locally, not committed.
- Model and route as in production: `google/gemini-3.5-flash-lite`, `provider.only: ["google-vertex"]`, `data_collection: "deny"`, `max_tokens: 8192`, 90 s provider window.
- Input: the first 5/10/15/20 minutes of ONE public podcast transcript (`lct_app/public/experiments/overlapping.threads`, YouTube `6HmR9IaqM88`; 62/143/218/293 transcript segments, about 14.7 per minute, two speakers). The map sees these as speaker turns: 32 utterances at 20 minutes, the longest 607 words.
- "Valid" means the Worker returned 200 with a map that passed the full validator.
- Runs were sequential, each in a fresh process, in batches: baseline 3 per length; compact A at 20 min in three batches of 5, 5 and 10 (the later batches tighten the estimate), plus 3 at 15 min; compact B 10 at 20 min.
- **Cost columns.** Vertex applied an implicit prompt-cache discount to repeated identical input, so "billed" understates a fresh transcript. "Uncached" recomputes input at the list price ($0.30/M input, $2.50/M output), which is what a new conversation costs.
- Wordings tested:
  - **A** (shipped): `Return compact JSON on one line: no indentation, line breaks or spaces between tokens, so the whole map fits the output limit.`
  - **B** (tried after review): `Minify the JSON: write it on a single line, with no indentation or line breaks outside string values.`

## Results

| Output format | Minutes | Valid | Completion tokens | Hit cap | Other failures | Seconds | Billed / run | Uncached / run |
|---|---|---|---|---|---|---|---|---|
| pretty | 5 | 3/3 | 2,757–3,185 | 0 | — | 8–9 | $0.0088 | $0.0088 |
| pretty | 10 | 3/3 | 3,622–7,360 | 0 | — | 9–16 | $0.0155 | $0.0161 |
| pretty | 15 | 1/3 | 5,276–8,175 | 2 | — | 13–19 | $0.0197 | $0.0203 |
| pretty | 20 | 1/4 | 5,213–8,178 | 3 | — | 13–20 | $0.0206 | $0.0212 |
| compact A | 15 | 3/3 | 2,445–4,453 | 0 | — | 7–12 | $0.0106 | $0.0117 |
| compact A | 20 | 19/20 | 2,594–7,594 | 0 | hierarchy ×1 | 7–18 | $0.0114 | $0.0134 |
| compact B | 20 | 7/10 | 3,157–6,714 | 0 | timeout ×1, threads ×1, hierarchy ×1 | 9–90 | $0.0138 | $0.0155 |

Total billed: **$0.600** across 46 runs (the earlier confirmation run included). The one compact B timeout's cost is not reported by the provider; it is at most about $0.02.

**Why the pretty runs failed:** every "before" reply was indented, and 27–31% of its characters were whitespace and newlines.

**The instruction is followed most of the time, not always.** At 20 minutes, 19 of 20 compact A replies were unindented. The one that ignored it (`compactb-20m-2`, 29% whitespace) is the 7,594-token tail run, and it still fit. Two more contain a handful of newlines, likely inside strings. With wording B, 2 of 9 completed replies were indented.

**Map size and form held (mechanical checks only; see the reading below for quality):**
- All compact A maps link 100% of utterances. Their size is comparable to or larger than the pretty successes: 20-minute compact A maps have 9–45 nodes, the one valid 20-minute pretty map had 18.
- Prose is not squeezed. Spaces make up about 13.8% of node-summary text in every group, and summaries average 110–123 characters.
- Edges are mostly empty before and after. That predates this change, and populated edges would add output tokens.

**Wording A vs B (no output-cap failures with either).** A scored 19/20 at 20 min and B 7/10. B's failures were one 90 s timeout, one dangling thread moment and one paraphrased idea id. With these sample sizes the difference is not established (two-sided Fisher p ≈ 0.10). A is kept because it measured at least as well, and the reviewer's concern that A's rationale clause might compress content is not visible in node counts or summary text.

**Reference errors seen:** paraphrased idea ids (about 84% similar, no shared prefix or suffix), a thread step pointing to a chunk number declared under a different word pattern, and a wrong-tier parent. None is the 3 November `node-` affix drift. The reference repair correctly declined all of them, and it was never exercised live.

## Long output cap check (2026-11-04)

After the owner approved a 16,384-token cap for transcripts longer than 5 minutes, one more 20-minute run used the built Worker with `LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS=16384`. The provider request carried `max_tokens: 16384` and the map was valid (43 nodes, 5,480 completion tokens, 14.9 s, $0.0163 billed). This confirms the long-cap path end to end. It is one run, and it did not exercise the reference repair. Total billed for this study is now **$0.616** across 47 runs.

## Reading the maps against the transcript (2026-11-04)

The checks above count things. They do not say whether the grouping is right. On review, the 20-minute maps were read against the 32-utterance transcript, and each pattern was counted across all 28 valid 20-minute maps.

- **The moment tier cannot go below a speaker turn.** A chunk links whole utterances. Utterance 24 is a 607-word monologue, about 3.5 minutes, covering the NIT Trichy, physics and lab story, and every map gives it at most one card. A 3-chunk map put 1,512 words in one card.
- **Chunk granularity is unstable for the same input.** Chunk counts ranged from 3 to 32. Six maps made one card per turn (32), and that style gives 1–5-word backchannels their own cards: "Right." became "Agreement on lab challenges", and "a voracious reader." became "Voracious reader label". The other 22 grouped turns into 3–23 chunks.
- **Pass-through tiers.** Many parents have one child. In the 16k map every topic has exactly one idea over the same span, so two of the five tiers add a label but no grouping.
- **The intro is usually filed correctly, but not always.** 26 of 28 maps put the podcast opening (utterances 1–2) under an "opening/introductions" idea or a background idea. Two misfiled it, under "Boarding School and Logo Programming" (the 16k run) and "Misaligned Software Incentives". In the second map, 14 chunks sit under ideas whose own evidence does not include them. The validator checks that parent links exist, not that they make sense.
- **A host tangent is folded into the guest's story.** In the 16k map, utterances 9–15 (the host's schoolmate who went to Google) sit inside the guest's "Boarding School and Logo Programming" idea.
- **Plausibly misfiled:** in the 16k map, the Stanford semester (utterance 32, biography) sits under "Misaligned Software Incentives and Free Will".
- **Transcript name errors carry through** ("Victor Arnold", "Andrish Karpatia"). These come from speech-to-text, not from map generation.

What this changes: the 19/20 result shows the reply fits and validates. It does not show the maps are good at 20 minutes. Map quality varies widely between runs of the same input, and the two clear misfiles and the turn-level granularity floor are the main quality risks. Splitting long turns before generation would address the floor. A semantic check (a chunk's parent should share its evidence span) would catch misfiles like the 14-chunk case.

## Map structure A/B (2026-11-04, owner-approved)

**Changes tested** (branch `fix/map-structure-quality`):
- **Split:** long same-speaker turns now break at sentence ends after 60 s or 150 words, or at any segment boundary after 120 s or 300 words when no sentence end arrives.
- **Prompt:** four lines asking for one coherent moment per chunk, single children only where a tier adds meaning, a parent's evidence covering its children, and digressions as their own node.

**Method:**
- 30 paid runs: three versions (base, split, split + prompt) × two inputs × five runs, interleaved. Same model, route and harness as above, with the 16,384 long cap.
- Inputs: minutes 0–20 and 40–60 of the same podcast. That is the same speakers, so this is still one conversation, not a second genre.
- Both inputs were rebuilt with spaces between transcript segments. All 47 earlier runs had segments glued together ("firstepisode"), an artifact of how I built the test input; live speech-to-text tokens carry their own spacing.
- Total billed: **$0.361**.

| Input | Version | Valid | Turns | Chunks | Backchannel chunks | Largest chunk (words) | Single-child / parents | L1 mismatches | Completion tokens | $/run |
|---|---|---|---|---|---|---|---|---|---|---|
| 0–20 | base | 5/5 | 32 | 4–32 | 3 | 665–1,746 | 2/7, 2/7, 6/8, 3/7, 2/6 | 0 | 3,006–5,405 | 0.0110 |
| 0–20 | split | 5/5 | 41 | 8–11 | 0 | 629–1,355 | 5/10, 2/7, 1/5, 4/8, 2/6 | 0 | 3,833–6,119 | 0.0121 |
| 0–20 | split + prompt | 4/5 | 41 | 8–10 | 0 | 726 | 1/5, 1/5, 2/6, 2/7 | 0 | 3,587–6,333 | 0.0145 |
| 40–60 | base | 5/5 | 27 | 4–27 | 2 | 824–1,768 | 2/9, 7/14, 1/8, 2/11, 1/7 | 0 | 2,914–5,559 | 0.0106 |
| 40–60 | split | 5/5 | 38 | 6–38 | 2 | 215–1,768 | 4/7, 2/9, 1/5, 1/13, 2/8 | 0 | 3,882–7,068 | 0.0148 |
| 40–60 | split + prompt | 4/5 | 38 | 7–9 | 0 | 566–1,568 | 2/8, 3/7, 3/10, 3/8 | 0 | 3,602–4,996 | 0.0093 |

**What the counts show:**
- **The prompt makes chunk granularity consistent.** With it, chunk counts were 7–10 in all 8 valid maps. Without it they ranged from 4 to 38, and 4 maps made one card per turn, including cards for "Right.".
- **Splitting alone did not change what the model chooses.** The split version still produced a 38-chunk map and a 6-chunk map. Splitting makes finer cards possible, and the prompt is what gets them used. On minutes 40–60, an 824-word monologue became five utterances. Only the split + prompt map divided it ("Life theory and moderate intelligence at scale", then "High actuation spaces and abundance"); the split-only map kept one 1,700-word card for utterances 25–38.
- **Largest chunk size did not fall much.** About 9 chunks for 20 minutes is roughly 2 minutes per card. Whether that is the right grain for a "moment" is a product choice, not something these counts decide.
- **No evidence mismatches in any of the 28 valid maps,** base included. The earlier 2 of 28 misfiles were all on glued input. So the prompt's coverage line cannot be credited, and the `evidence_mismatch` log stays as detection.
- **Failures with split + prompt:**
  - One was a provider error (`finish: error`, no tokens, not billed).
  - One was the `node-` id drift on the idea tier only. The reference repair declined it because references at the other tiers resolve without the prefix, and the repair's resolved-reference guard checks every tier. This is the second real drift seen. See ISSUES.md.
- **Cost:** split + prompt averaged $0.0145 per run on 0–20 (vs $0.0110 base) and $0.0093 on 40–60 (vs $0.0106), within noise.

**What the reading shows** (one map per version and input, read against the transcript):
- Both newer versions separate the podcast's scheduling talk (40–60, utterances 11–18) from the content. The split + prompt map then put logistics and the theory under one topic, "Life Theory, Actuation Spaces, and Logistics", a new grouping error.
- **Hollow tiers recur in every version** (1/10 base, 2/10 split, 2/8 split + prompt). Chunks attach straight to topics, and each idea sits beside them as a childless copy of its topic, with the same span. The scorer now counts these (`childlessHigherNodes`). The prompt does not cause them and does not fix them.
- In the base map on 0–20, the host's schoolmate story got its own chunk; the split + prompt map merged it with Logo programming. So the digression line did not reliably work.
- Speech-to-text spellings carry through ("life theory" and "live theory" for the same organisation).

**Verdict:**
- Keep both changes. Splitting is necessary and not sufficient. The prompt removes the extreme granularity spread, at no clear cost.
- The evidence is two inputs from one conversation and 8–10 maps per version, so it shows a direction, not a guarantee.
- Not fixed: hollow tiers, occasional topic-level misgrouping, and the repair guard that refuses single-tier drift.
- Two-stage generation (chunks first, then hierarchy with enum-constrained parents) remains the structural fix for hollow tiers and misfiles.

## Limits

- **One transcript, one model/route.** 19/20 has a 95% Clopper-Pearson lower bound of about 75%. That is evidence the 4-of-5 bar is met on this input, not a guarantee for 20-minute conversations in general.
- **Tail risk.** The largest compact-A 20-minute reply used 7,594 tokens (93% of 8,192). It was the one run that ignored the compact instruction. Among replies that followed it, the largest used 6,961. A run that both ignores the instruction and produces a richer map, a denser meeting, or populated edges can still reach the cap.
- **Cost of the next step.** When this was measured, raising the cap was an open owner cost decision. The owner has since approved 16,384 for transcripts longer than 5 minutes only (`LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS`, see `lct_app/sites/README.md`). Live 5-minute sessions keep 8,192.
- **Beyond about 20 minutes, or for dense inputs,** chunked generation (option B in the options note) remains the path that does not depend on one call's output budget.

## Per-run detail

| Run | Valid | Completion | Nodes by level (1/2/3/4/5) | Coverage | Edges | Paths | Whitespace % of reply |
|---|---|---|---|---|---|---|---|
| pretty baseline-5m-1 | yes | 3185 | 6/3/3/2/1 | 100% | 0 | 1 | 29 |
| pretty baseline-5m-2 | yes | 2786 | 6/2/2/1/1 | 100% | 0 | 1 | 28 |
| pretty baseline-5m-3 | yes | 2757 | 6/2/2/1/1 | 100% | 0 | 1 | 29 |
| pretty baseline-10m-1 | yes | 7360 | 20/5/5/2/1 | 100% | 4 | 1 | 29 |
| pretty baseline-10m-2 | yes | 3622 | 4/3/3/1/1 | 100% | 0 | 1 | 30 |
| pretty baseline-10m-3 | yes | 6028 | 20/4/2/1/1 | 100% | 0 | 1 | 29 |
| pretty baseline-15m-1 | no | 8175 | — | — | — | — | 31 |
| pretty baseline-15m-2 | no | 8175 | — | — | — | — | 30 |
| pretty baseline-15m-3 | yes | 5276 | 11/3/2/1/1 | 100% | 0 | 1 | 31 |
| pretty baseline-20m-1 | no | 8178 | — | — | — | — | 28 |
| pretty baseline-20m-2 | yes | 5213 | 7/4/4/2/1 | 100% | 0 | 1 | 30 |
| pretty baseline-20m-3 | no | 8175 | — | — | — | — | 27 |
| compact A compact-20m-1 | yes | 3583 | 8/4/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compact-20m-2 | yes | 5476 | 20/8/3/1/1 | 100% | 0 | 1 | 0 |
| compact A compact-20m-3 | yes | 4498 | 20/6/3/1/1 | 100% | 0 | 1 | 0 |
| compact A compact-20m-4 | yes | 2708 | 6/0/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compact-20m-5 | yes | 4164 | 13/3/2/2/1 | 100% | 0 | 1 | 0 |
| compact A compactb-20m-1 | yes | 3834 | 11/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactb-20m-2 | yes | 7594 | 23/4/4/2/1 | 100% | 0 | 1 | 29 |
| compact A compactb-20m-3 | yes | 6961 | 32/7/3/2/1 | 100% | 0 | 1 | 0 |
| compact A compactb-20m-4 | yes | 2594 | 3/3/1/1/1 | 100% | 0 | 1 | 0 |
| compact A compactb-20m-5 | yes | 5196 | 20/4/2/1/1 | 100% | 1 | 1 | 0 |
| compact A compactb-15m-1 | yes | 4431 | 24/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactb-15m-2 | yes | 2445 | 5/2/1/1/1 | 100% | 0 | 1 | 0 |
| compact A compactb-15m-3 | yes | 4453 | 24/4/2/1/1 | 100% | 0 | 1 | 0 |
| compact B minified-20m-1 | yes | 3204 | 5/1/1/1/1 | 100% | 4 | 1 | 0 |
| compact B minified-20m-2 | no | — | — | — | — | — | n/a |
| compact B minified-20m-3 | yes | 5685 | 32/3/3/1/1 | 100% | 0 | 1 | 0 |
| compact B minified-20m-4 | yes | 6714 | 32/4/2/1/1 | 100% | 0 | 1 | 0 |
| compact B minified-20m-5 | no | 5890 | — | — | — | — | 29 |
| compact B minified-20m-6 | no | 5572 | — | — | — | — | 0 |
| compact B minified-20m-7 | yes | 6150 | 32/6/3/2/1 | 100% | 0 | 1 | 0 |
| compact B minified-20m-8 | yes | 4584 | 6/2/2/1/1 | 100% | 0 | 1 | 31 |
| compact B minified-20m-9 | yes | 5435 | 32/3/1/1/1 | 100% | 0 | 1 | 0 |
| compact B minified-20m-10 | yes | 3157 | 6/2/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-1 | yes | 4564 | 17/3/3/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-2 | yes | 3780 | 11/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-3 | yes | 2851 | 6/2/2/1/1 | 100% | 0 | 3 | 0 |
| compact A compactc-20m-4 | yes | 3230 | 7/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-5 | yes | 4291 | 20/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-6 | yes | 2905 | 5/2/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-7 | yes | 4286 | 15/3/2/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-8 | yes | 4866 | 20/3/3/1/1 | 100% | 0 | 1 | 0 |
| compact A compactc-20m-9 | no | 5935 | — | — | — | — | 0 |
| compact A compactc-20m-10 | yes | 3174 | 6/3/2/2/1 | 100% | 0 | 1 | 0 |


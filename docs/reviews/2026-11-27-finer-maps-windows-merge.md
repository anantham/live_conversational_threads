# Finer maps: windows, a merge pass and smaller utterances, measured 2026-11-26/27

**Question (owner):** can a 20-minute map show finer moments than a single generation call gives today, and at what cost in time, money and reliability?

**Answer, on one benchmark transcript with small samples:** the finest maps came from three changes combined:

1. map the conversation in 5-minute windows, then build the upper tiers in one merge call;
2. add a "map finely" sentence to the window prompt;
3. cut speaker turns into smaller utterances (about 60 words or 24 s, not 150 words or 60 s).

Two runs with all three gave 21 and 22 chunks (median 155 words, range 25–417), against 11 and 7 chunks (median 247 and 514 words) from the two valid single calls. They took 13.6 s and cost about $0.024 each. Two of the changes were tested apart:

- smaller utterances alone left a single call as coarse;
- windows without a merge pass broke speaker names and repeated the arc.

The design never separated "map finely" from the 60-word split. Windows + merge was not run at 60 words without "map finely", and a single call was never run with it. So how much of the gain each change gives is unknown.

This measures `main`'s single-call code path, from a local harness. The live Site's source branch already generates long imports in two stages (ADR-073, glance then detail), and that was not measured. The proposal is to measure that pipeline on this transcript, not to build windows plus a merge.

## Method

- Code under test: the generation and transcript modules in `lct_app/src/services/cloud/`. They are identical at `origin/main` 2bc1a0b2 and `origin/codex/lct-inference-choice` (checked with `git diff`). The experiments bundled them from b214a47b with esbuild and called them from a local Node harness. The harness is not the Worker: it skips admission, the attempt ledger, retries and storage. Real OpenRouter calls only; replies and maps are kept locally, not committed.
- Model and route as in production: `google/gemini-3.5-flash-lite`, `provider.only: ["google-vertex"]`, `data_collection: "deny"`, `require_parameters: true`, `allow_fallbacks: false`, 90 s timeout. Single calls used `max_tokens: 16384` (the approved long-input cap); window, context and merge calls used 8,192 or less.
- Input: the first 20 minutes of the public podcast transcript also used by the 2026-11-03 study (`lct_app/public/experiments/overlapping.threads`): 294 segments, 3,492 words, two speakers, segments joined with spaces. With today's split rule the transcript builder makes 41 utterances, the longest 316 words. 12 of the 41 are over 150 words.
- **Validity.** A single-call map is valid if the raw model output passes `recordingThreadsFromOpenRouterResponse`, the Worker's response validator. A windows + merge map is assembled by harness code first. That step:
  - drops window parent links that do not point to an idea in the same window;
  - drops upper-tier parent links that point to a missing node;
  - drops utterance ids a window cited from outside its window;
  - computes every parent's evidence as the union of its children's;
  - removes nodes with no evidence (3 upper nodes, in 2 runs at today's split);
  - drops thread steps that point to a missing node, and fills step evidence from the step's node;
  - clears secondary parents.

  The assembled map is then validated against the full 20-minute source. So "valid" for windows + merge means valid after these repairs. A single call gets no repairs, and its two rejections are exactly the kind of broken parent link the assembly drops. The window outputs were not saved, so how often the window-level repairs fired is unknown. In the saved merge outputs, no upper-tier parent link and no assignment pointed at a missing node. All 52 thread steps the merge wrote survived into the maps.
- Times are wall-clock from the harness to OpenRouter, with no Worker admission waits.
- **Costs** are as billed (`usage.cost`). Vertex discounts repeated identical input (`cached_tokens`). The single-call logs show that discount on repeats. At list price ($0.30 per million input tokens, $2.50 per million output tokens) the two valid single calls at today's split cost $0.016 and $0.019. Cached tokens were not logged for the windows + merge runs. Their context-pass input and the shared window prompt repeat across runs, so their billed costs may also be discounted.

### The approaches

- **One call:** the production request, unchanged.
- **Plain windows:** the production request run separately on each 5-minute window (cut at segment start times), with no shared context. Each run gives four separate maps.
- **Windows + merge** (six calls; stage 2's four calls run in parallel):
  1. **Context pass.** The whole transcript goes in, with a small strict schema. The output is a note naming who takes part (names as the conversation gives them, plus roles) and summarising each window in two or three sentences. It takes 2.3–3.0 s.
  2. **Four window calls in parallel.** Each is the production prompt and schema, with two changes. The tier sentence becomes "Use only the chunk (1) and idea (2) tiers; topics, themes and the arc are built later across the whole conversation, so leave idea parent_id null." The schema is narrowed to those two tiers. A second system message adds: "part k of N", the context note, "refer to people by name… rather than as 'the speaker'", the earlier and later window summaries (for orientation only), and "use an empty conversation_threads array". Windows are cut at utterance boundaries, so window utterance ids are the full transcript's ids. They take 3.3–7.1 s for the slowest window.
  3. **Merge call.** It sees the window chunks and ideas only: id, tier, name, summary, existing idea parent, and utterance range. It never sees transcript text. Its strict schema returns topic, theme and arc nodes, an `assignments` list that files each parentless node under one of them, edges, threads and metadata. The prompt says a topic that continues across a window boundary is one topic, and repeats the production single-child rule. It takes 4.7–8.7 s.
  4. **Assembly:** harness code, described under Validity above.
- **"Map finely" variant:** one more window sentence: "This part is short, so map it finely: start a new chunk whenever the point, story or question changes, and treat a chunk of more than three utterances as rare. An idea groups two or more related chunks; leave a chunk with no idea parent rather than creating an idea that repeats it."
- **Smaller utterances:** `SPLIT_TURN_WORDS` / `SPLIT_TURN_MS` in `recordingTranscript.js` changed from 150 / 60,000 to 60 / 24,000 (60 utterances, longest 138 words) and to 40 / 16,000 (73 utterances, longest 101 words). A speaker change starts a new utterance at every setting. Only long same-speaker turns are affected.

## Results

Time and cost ranges cover valid maps only; rejected runs are listed after the table.

| Approach | Split | Valid | Seconds | Billed per map | Chunks | Median chunk (min–max) | Tiers chunk/idea/topic/theme/arc |
|---|---|---|---|---|---|---|---|
| One call | 150 w | 2/3 | 14.7, 11.6 | $0.019, $0.014 | 11, 7 | 247 (126–635), 514 (154–739) w | 11/2/3/2/1, 7/2/4/2/1 |
| One call | 60 w | 3/3 | 11.5–16.7 | $0.013–0.022 | 10, 8, 8 | 407–619 w | 10/3/3/1/1, 8/3/3/1/1, 8/4/4/2/1 |
| One call | 40 w | 2/3 | 13.4, 18.5 | $0.016, $0.022 | 8, 10 | 496, 308 w | 8/3/2/1/1, 10/3/3/1/1 |
| Plain windows, 4 maps per run | 150 w | 8/8 windows | 8.5, 7.6 (slowest window) | $0.027, $0.028 | 15, 23 | 247 (27–639), 153 (25–411) w | 4 arcs per run |
| Windows + merge | 150 w | 3/3 | 11.5–12.2 | $0.021–0.023 | 12, 18, 10 | 250, 161, 348 w | 12/7/2/0/1, 18/8/4/2/1, 10/9/3/0/1 |
| Windows + merge, map finely | 150 w | 3/3 | 13.3–14.0 | $0.021–0.022 | 16, 18, 13 | 178, 178, 247 w | 16/0/6/3/1, 18/0/6/1/1, 13/0/7/3/1 |
| Windows + merge, map finely | 60 w | 2/2 | 13.6, 13.6 | $0.024, $0.023 | 22, 21 | 155 (25–417), 155 (25–369) w | 22/0/4/1/1, 21/0/0/4/1 |
| Windows + merge, map finely | 40 w | 2/2 | 12.8, 18.3 | $0.023, $0.029 | 15, 30 | 207 (97–496), 89 (2–496) w | 15/4/4/1/1, 30/0/6/1/1 |

Two single calls were rejected for a broken parent link (`hierarchy parent_missing`): one at 150 words (7.5 s, $0.008) and one at 40 words (20.1 s, $0.023). No output reached the token cap. One valid single call at 60 words left 1 of 60 utterances uncovered. Every windows + merge map covered every utterance.

Total billed for this study: **$0.47**, inside the standing $1 per-task test budget.

## What each change did

**Smaller utterances alone did nothing for one call.** At 60 and 40 words a single call still drew 8–10 chunks, each covering more of the smaller utterances. Output grew (up to 9,041 tokens) and so did latency. The model's own grouping set the grain, not the utterance size.

**Plain windows gave finer maps but broke the map's structure:**
- Speaker names were lost after the first window. Windows 2–4 never saw the introduction. 3 and 6 summaries per run say "the speaker" instead of the guest's name.
- Each window wrote its own arc, so each run had four near-identical "personal background" arcs.
- The same topic appeared on both sides of a boundary: the move to programming ends window 3 and starts window 4.
- Grain varied widely: the same window gave 2 chunks in one run and 9 in the next.

**The context pass and merge call fixed names and the single arc.** No merged map has a summary saying "the speaker". One map names the guest in 21 summaries. The context pass named host and guest correctly (both names checked against the transcript). Each merged map has one arc and one title.

**Windows plus merge at today's split was already finer than one call** (10–18 chunks), but many chunks were a single long utterance. In the 18-chunk "map finely" map, 13 of 18 chunks were one or two utterances, and seven were a single utterance of up to 251 words. Those chunks cannot get smaller without smaller utterances.

**With a 60-word split as well (and "map finely"), chunks got smaller.** The two maps had 21 and 22 chunks, and the largest single-utterance chunk was 136 words. The first map separates moments every single-call map lumped together: the classmate's story, the "mathematics is cheap" remark, dating-app incentives, the fitness watch telling him to run faster, the Stanford semester. Six such claims were checked against the transcript; all were present. With two runs, this shows the setting can produce finer maps, not that it does so reliably.

**At a 40-word split, the two runs disagreed (15 and 30 chunks).** In the 30-chunk map, 19 chunks are a single utterance. Some are short turns the production prompt says to fold into a neighbour: "Awesome.", "Yeah, sorry, what did you ask?", one-line host prompts. Those turns are their own utterances at every split, because each is a speaker change. Filing them as separate chunks was the model's choice in that run, not something the split created.

## Defects that remain in the merged maps

- **Topics still end at window boundaries.** Despite the instruction, the merge did not join a topic across a boundary in the maps read. "Pivot to programming" (end of window 3) and "Shift to programming" (start of window 4) sit under different topics.
- **Tiers get thin or skipped.** Without "map finely", 2–7 ideas per map repeat a single chunk. With it, 6 of 7 maps have no idea tier, and in 4 of 7 the arc has a single theme child. One of the two 60-word maps also has no topic tier: its 21 chunks sit directly under 4 themes. The single-child rule is in the merge prompt and is not followed reliably. The same pass-through pattern was counted in the 2026-11-03 single-call maps.
- **Grain varies between runs** at every setting with more than one run (for example 13–18 chunks at today's split with "map finely", 15 and 30 at 40 words). Two runs at 60 words cannot show whether that setting is steadier.

## How this relates to ADR-073 (glance, then detail)

`integ/sites-combined` is open into `main` as #261. The 2026-11-26 WORKLOG says the live Site is built from it. It carries ADR-073 and `lct_app/src/services/cloud/glanceDetailPipeline.js`. The ADR's own status line still reads "proposed … awaiting live run and review". Whether the deployed Site build includes the pipeline was not checked here. The design:

1. A **glance** call reads the whole transcript and writes arcs, themes and topics, with each topic citing utterance ranges.
2. **Detail** calls fill in ideas and chunks. Each segment holds whole topics up to 2,800 words (`DEFAULT_SEGMENT_MAX_WORDS`); a larger topic is split across segments by turns.

The ADR rejected fixed windows because "the top tiers (arcs, themes) described windows, not the conversation". Plain windows here showed the same thing. What carries over:

- **The utterance floor applies to detail calls.** `segmentSource` sends a detail call the bundle's own utterances, one token each, and maps the reply back by position. A detail chunk can therefore be no smaller than a stored utterance. The finer chunks here needed a 60-word split (together with windows, merge and "map finely"). Whether detail calls would gain the same way is untested.
- **On this transcript, detail is close to a single call.** At 3,492 words and a 2,800-word budget, planSegments makes one or two detail segments. The windows here were about 870 words. A fair test of whether glance-detail can be as fine needs a smaller segment budget as well as the default.
- **Names in detail calls are untested.** Here, names survived because each window got a note naming the people. A detail call gets segment topics (id, name, summary), and `segmentSource` labels each turn `turn-N`, so "the model never sees speakers". Whether detail summaries drift to "the speaker" is worth counting. The ADR does not report it either way.
- **Bottom-up merging did not join topics across boundaries.** ADR-073 decides topics before detail. That should avoid the problem when a topic fits in one segment. A topic split by turns across segments is not covered by that argument. Neither case is measured here.

**Changing the utterance split is a transcript decision, not a generation setting.** Maps cite utterance ids and keep `source_excerpt` empty, so a map is only meaningful against the utterances it cited. Detail maps back to stored utterances by position. A finer split therefore has to become the stored transcript's split. `createRecordingTranscript` builds utterances for live recordings, saved files, glance and detail alike, and decides ids only from tokens already seen. Changing the constants changes ids for any transcript rebuilt from its tokens. Whether any saved artifact is rebuilt that way was not checked. The safe options are a finer split for new recordings and imports only, or a recorded split version per transcript.

Pacing, from the code: server-key routes admit one attempt per 10 s with at most two in flight (`openRouterPolicy.js`). Detail calls on server-key routes run one at a time, 10.5 s apart (`detailPacing`). On personal-key routes they run up to three at once, 1.6 s apart, under the Worker's personal pacing (six in flight, 0.5 s guard). Windows plus merge here was six calls, measured without any admission limit.

## Proposal

Do not build windows plus merge. Measure the pipeline the Site's branch already has, and fill in the cells this study left out.

1. **Run glance-detail on this transcript** with the same validator, and no harness repairs:
   - at today's split and at a 60-word split;
   - with the default 2,800-word segments and with segments of about 900 words;
   - 3 runs per cell to start.

   Record per map: chunks with median and range; how many chunks are one utterance; tier counts and single-child counts; summaries saying "the speaker"; whether topics hold across segment boundaries; valid rate; wall time without admission; and billed cost with cached tokens logged.
2. **Fill in the missing cells** in the same batch: windows + merge at 60 words without "map finely", and one call with "map finely" at today's split. This separates the prompt from the split.
3. **If smaller utterances matter**, decide how transcripts adopt them: for new recordings and imports only, or with a stored split version. This is a product decision because it changes utterance ids.

Expected cost for steps 1–2 is about $0.30–0.50, inside the weekly test budget. The only decision this needs now is go or no-go on that spend.

## Limits

- One transcript, a two-person podcast that is mostly long answers from the guest. Conversations with short turns may already be finer with one call.
- Two or three runs per setting. Chunk counts are examples, not estimates of a distribution.
- Three changes were combined in the best runs, and their effects were not separated.
- Windows + merge maps were validated after harness repairs. Single calls were not repaired.
- Window boundaries were cut by time (every 5 minutes), not by topic.
- Quality was judged by counts and by reading some maps against the transcript, not by a blind comparison or a second reader.
- The harness bypasses the Worker. Times leave out admission, and costs leave out retries.

## Correction recorded during this study

An earlier reading in this study said a map had misread the guest as struggling at school, because one transcript sentence reads "I was actually very good at studies". The same turn goes on about praying to pass the 10th exams, being "really bad at languages" and, later, "I don't think I was a smart kid". The speech-to-text almost certainly dropped a "not", and the map was right. Judge a summary against the whole passage, not one sentence.

## Review

Gemini 4 Argon (High) via Antigravity (`agy --mode plan --model gemini-4-argon-high`), packet on stdin: this note, the measurement log, per-map granularity counts, the harness and code excerpts. Round 1 (packet sha256 fb6fd192…): NO-GO. This version adopts its findings:

- disclosed the harness repairs and the "map finely" confound;
- corrected the idea-tier, arc and topic-tier counts;
- used valid-only time and cost ranges;
- reworded "evenly sized";
- corrected the cause of the 40-word one-line chunks;
- added the 2,800-word detail budget and positional mapping;
- added the ADR's status line;
- replaced the generation-only split with a transcript-level decision.

Round 2 (packet sha256 b189b9dd…): GO. It confirmed all round-1 findings fixed and raised two low items, both adopted: the run order in the first table row, and counting dropped thread steps (none) instead of calling them unknown.

Also fixed: two counts from the first draft (13 of 18 chunks, not 15; "the speaker" in 3 and 6 summaries per plain-window run, not up to 10).

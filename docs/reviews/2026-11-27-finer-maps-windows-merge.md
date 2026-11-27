# Finer maps: windows, a merge pass and smaller utterances, measured 2026-11-26/27

**Question (owner):** can a 20-minute map show finer moments than a single generation call gives today, and at what cost in time, money and reliability?

**Answer, on one benchmark transcript with small samples:** in the first part, the only setting where every run gave more than 20 chunks combined three changes:

1. map the conversation in 5-minute windows, then build the upper tiers in one merge call;
2. add a "map finely" sentence to the window prompt;
3. cut speaker turns into smaller utterances (about 60 words or 24 s, not 150 words or 60 s).

Two runs with all three gave 21 and 22 chunks (median 155 words, range 25–417), against 11 and 7 chunks (median 247 and 514 words) from the two valid single calls. They took 13.6 s and cost about $0.024 each. Chunk count is not a quality ranking: higher counts appeared elsewhere (30 in one 40-word run, against 15 in the other; 41 in a degenerate one-chunk-per-utterance single call), and some extra chunks in those maps are isolated acknowledgements. Two of the changes were tested apart:

- smaller utterances alone left a single call as coarse;
- windows without a merge pass broke speaker names and repeated the arc.

The design never separated "map finely" from the 60-word split. Windows + merge was not run at 60 words without "map finely", and a single call was never run with it. So how much of the gain each change gives was unknown. The follow-up filled both cells. In those runs, neither change alone took windows + merge past 18 chunks (13 and 15 at 60 words without "map finely"; 13–18 with it at today's split). Together they gave 21 and 22. With 2–3 runs per cell, that shows the combination did more in these runs, not how large each effect is.

This first part measures `main`'s single-call code path, from a local harness.

**Follow-up (same day, see "Follow-up: the live pipeline and the missing cells"):**

- **In these runs, the live branch's pipeline gave more chunks than one call at a lower billed cost.** That pipeline is ADR-073 glance → detail, from `integ/sites-combined`, run locally with only the transport replaced and no harness repairs. At its defaults it gave 20, 17 and 12 chunks (16, 14 and 11 without filler chunks), against 11 and 7 from one call, for $0.010–0.012 per map. The deployed build, Worker retries and production reliability were not tested.
- **Smaller utterances and smaller segments did not make it clearly finer.** Two defects showed up only in some cells, and neither is shown to be caused by the setting: filler chunks appeared only at the defaults, and the glance missed the introduction only at today's split (2 of 6 glances; 0 of 5 at 60 words). Segment size cannot affect the introduction, because the glance runs before segments exist.
- **The two missing cells were filled.** Without "map finely", windows + merge at 60 words gave 15 and 13 chunks. With it at today's split it gave 13–18. Of the 150- and 60-word cells, only the combination passed 18 (21 and 22). In a single call, "map finely" gave 9, 10 and then a degenerate one-chunk-per-utterance map.
- **The glance often writes more than one arc:** 2 or 5 arcs in 5 of 11 glance-detail maps in the follow-up (all four valid detail-prompt maps had one, so 5 of 15 overall). The skeleton prompt permits several root arcs, so whether that is a defect is a product question.

A detail-prompt test that followed made maps somewhat finer (15–26 non-filler chunks against 11–16 at the defaults) but did not fix the filler chunks, and two maps called the guest "the speaker" in some summaries (3 and 1; none at the defaults). The revised proposal keeps glance → detail and leaves the next lever to the owner. The options are a narrower fold-rule prompt, a deterministic fold of acknowledgement chunks, or the defaults, plus two glance fixes.

## Method

- Code under test: the generation and transcript modules in `lct_app/src/services/cloud/`. They are identical at `origin/main` 2bc1a0b2 and `origin/codex/lct-inference-choice` (checked with `git diff`). The experiments bundled them from b214a47b with esbuild and called them from a local Node harness. The harness is not the Worker: it skips admission, the attempt ledger, retries and storage. Real OpenRouter calls only; replies and maps are kept locally, not committed.
- Model and route as in production: `google/gemini-3.5-flash-lite`, `provider.only: ["google-vertex"]`, `data_collection: "deny"`, `require_parameters: true`, `allow_fallbacks: false`, 90 s timeout. Single calls used `max_tokens: 16384` (the approved long-input cap); window, context and merge calls used 8,192 or less.
- Input: the first 20 minutes of the public podcast transcript also used by the 2026-11-03 study (`lct_app/public/experiments/overlapping.threads`): 294 segments, 3,492 words, two speakers, segments joined with spaces. With today's split rule the transcript builder makes 41 utterances, the longest 316 words. 12 of the 41 are over 150 words.
- **Validity.** A single-call map is valid if the raw model output passes `recordingThreadsFromOpenRouterResponse`, the Worker's response validator. A windows + merge map is assembled by harness code first. That step:
  - drops window parent links that do not point to an idea in the same window;
  - drops upper-tier parent links that point to a missing node;
  - drops utterance ids a window cited from outside its window;
  - adds each child's evidence to its parent's (a window idea keeps any evidence of its own);
  - removes nodes with no evidence (3 upper nodes, in 2 runs at today's split);
  - drops thread steps that point to a missing node, and fills step evidence from the step's node;
  - clears secondary parents.

  The assembled map is then validated against the full 20-minute source. So "valid" for windows + merge means valid after these repairs. A single call gets no repairs, and its two rejections are exactly the kind of broken parent link the assembly drops. The window outputs were not saved, so how often the window-level repairs fired is unknown. In the saved merge outputs, no upper-tier parent link and no assignment pointed at a missing node. All 52 thread steps the merge wrote survived into the maps, and each points at a node in the final map (counted in the saved maps; the step filter runs before empty nodes are removed, so this was checked rather than assumed).
- Times are wall-clock from the harness to OpenRouter, with no Worker admission waits.
- **Costs** are as billed (`usage.cost`). Vertex discounts repeated identical input (`cached_tokens`). The single-call logs show that discount on repeats. At list price ($0.30 per million input tokens, $2.50 per million output tokens) the two valid single calls at today's split cost $0.016 and $0.019. Cached tokens were not logged for the windows + merge runs. Their context-pass input and the shared window prompt repeat across runs, so their billed costs may also be discounted.

### The approaches

- **One call:** the production request, unchanged.
- **Plain windows:** the production request run separately on each 5-minute window (cut at segment start times), with no shared context. Each run gives four separate maps.
- **Windows + merge** (six calls; stage 2's four calls run in parallel):
  1. **Context pass.** The whole transcript goes in, with a small strict schema. The output is a note naming who takes part (names as the conversation gives them, plus roles) and summarising each window in two or three sentences. It takes 2.3–3.0 s.
  2. **Four window calls in parallel.** Each is the production prompt and schema, with two changes. The tier sentence becomes "Use only the chunk (1) and idea (2) tiers; topics, themes and the arc are built later across the whole conversation, so leave idea parent_id null." The schema is narrowed to those two tiers. A second system message adds: "part k of N", the context note, "refer to people by name… rather than as 'the speaker'", the earlier and later window summaries (for orientation only), and "use an empty conversation_threads array". Windows are cut at utterance boundaries, so window utterance ids are the full transcript's ids. They take 3.3–7.1 s for the slowest window.
  3. **Merge call.** It sees the context pass's note on who takes part, and the window chunks and ideas: id, tier, name, summary, existing idea parent, and utterance range. It never sees transcript text. Its strict schema returns topic, theme and arc nodes, an `assignments` list that files each parentless node under one of them, edges, threads and metadata. The prompt says a topic that continues across a window boundary is one topic, and repeats the production single-child rule. It takes 4.7–8.7 s.
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
- Speaker names were lost after the first window. Windows 2–4 never saw the introduction. 3 and 5 summaries per run say "the speaker" instead of the guest's name (counted as "the speaker" not followed by "s").
- Each window wrote its own arc, so each run had four near-identical "personal background" arcs.
- The same topic appeared on both sides of a boundary: the move to programming ends window 3 and starts window 4.
- Grain varied widely: the same window gave 2 chunks in one run and 9 in the next.

**The context pass and merge call fixed names and the single arc.** No merged map has a summary saying "the speaker". One map names the guest in 21 summaries. The context pass named host and guest correctly (both names checked against the transcript). Each merged map has one arc and one title.

**Windows plus merge at today's split was already finer than one call** (10–18 chunks), but many chunks were a single long utterance. In the 18-chunk "map finely" map, 13 of 18 chunks were one or two utterances, and seven were a single utterance of up to 251 words. Those chunks cannot get smaller without smaller utterances.

**With a 60-word split as well (and "map finely"), chunks got smaller.** The two maps had 21 and 22 chunks, and the largest single-utterance chunk was 136 words. The first map separates moments every single-call map lumped together: the classmate's story, the "mathematics is cheap" remark, dating-app incentives, the fitness watch telling him to run faster, the Stanford semester. Six such claims were checked against the transcript; all were present. With two runs, this shows the setting can produce finer maps, not that it does so reliably.

**At a 40-word split, the two runs disagreed (15 and 30 chunks).** In the 30-chunk map, 19 chunks are a single utterance. Some are short turns the production prompt says to fold into a neighbour: "Awesome.", "Yeah, sorry, what did you ask?", one-line host prompts. Those turns are their own utterances at every split, because each is a speaker change. Filing them as separate chunks was the model's choice in that run, not something the split created.

## Defects that remain in the merged maps

- **Topics still end at window boundaries.** Despite the instruction, the merge did not join a topic across a boundary in the maps read. "Pivot to programming" (end of window 3) and "Shift to programming" (start of window 4) sit under different topics.
- **Tiers get thin or skipped.** Without "map finely", 2–7 ideas per map have a single chunk child (a structural count; whether each repeats its chunk was not read). With it, 6 of 7 maps have no idea tier, and in 4 of 7 the arc has a single theme child. One of the two 60-word maps also has no topic tier: its 21 chunks sit directly under 4 themes. The single-child rule is in the merge prompt and is not followed reliably. The same pass-through pattern was counted in the 2026-11-03 single-call maps.
- **Grain varies between runs** at every setting with more than one run (for example 13–18 chunks at today's split with "map finely", 15 and 30 at 40 words). Two runs at 60 words cannot show whether that setting is steadier.

## How this relates to ADR-073 (glance, then detail)

`integ/sites-combined` is open into `main` as #261. The 2026-11-26 WORKLOG says the live Site is built from it. It carries ADR-073 and `lct_app/src/services/cloud/glanceDetailPipeline.js`. The ADR's own status line still reads "proposed … awaiting live run and review". Whether the deployed Site build includes the pipeline was not checked here. The design:

1. A **glance** call reads the whole transcript and writes arcs, themes and topics, with each topic citing utterance ranges.
2. **Detail** calls fill in ideas and chunks. Each segment holds whole topics up to 2,800 words (`DEFAULT_SEGMENT_MAX_WORDS`); a larger topic is split across segments by turns.

The ADR rejected fixed windows because "the top tiers (arcs, themes) described windows, not the conversation". Plain windows here showed the same thing. What carries over:

- **The utterance floor applies to detail calls.** `segmentSource` builds one synthetic source token per stored utterance for a detail call and maps the reply back by position. A detail chunk can therefore be no smaller than a stored utterance. The windows + merge setting where every run passed 20 chunks used a 60-word split (together with "map finely"). The follow-up tested this: at a 60-word split, glance → detail was not clearly finer (13–17 chunks against 12–20).
- **On this transcript, detail is close to a single call.** At 3,492 words and a 2,800-word budget, planSegments made two detail segments in all six default-budget maps (the greedy planner can make more, depending on topic sizes and order). The windows here were about 870 words. A fair test of whether glance-detail can be as fine needs a smaller segment budget as well as the default.
- **Names in detail calls.** In the windows + merge maps each window got a note naming the people (plain windows got none and had 3 and 5 "the speaker" summaries), and names survived; whether the note is why was not tested. The code builds a detail call from the segment's topics (id, name, summary) and turns labelled `turn-N`, with no speaker names in the turn labels. In the follow-up, names mostly held anyway: 1 "the speaker" summary across 11 glance-detail maps. Why was not checked; the serialized detail request was not inspected.
- **Bottom-up merging did not join topics across boundaries.** ADR-073 decides topics before detail. That should avoid the problem when a topic fits in one segment. When a topic is too big, the planner passes the same topic id to each part, but whether the parts come out as one coherent topic was not measured.

**Changing the utterance split is a transcript decision, not a generation setting.** Maps cite utterance ids and keep `source_excerpt` empty, so a map is only meaningful against the utterances it cited. Detail maps back to stored utterances by position. A finer split therefore has to become the stored transcript's split. `createRecordingTranscript` builds utterances for live recordings, saved files, glance and detail alike, and decides ids only from tokens already seen. Changing the constants can change which text an utterance id points to when a transcript is rebuilt from its tokens; a transcript whose utterance boundaries come out the same is unaffected. Whether any saved artifact is rebuilt that way was not checked. The safe options are a finer split for new recordings and imports only, or a recorded split version per transcript.

Pacing, from the code: server-key routes admit one attempt per 10 s with at most two in flight (`openRouterPolicy.js`). Detail calls on server-key routes run one at a time, with starts scheduled 10.5 s apart (`detailPacing`). On personal-key routes they run up to three at once, with starts scheduled 1.6 s apart, under the Worker's personal pacing (six in flight, 0.5 s guard). Windows plus merge here was six calls, measured without any admission limit.

## Follow-up: the live pipeline and the missing cells (2026-11-27)

The owner approved the measurement proposed in the first version of this note.

### Method

- **Glance → detail** is `runGlanceDetailPipeline` from `integ/sites-combined` e5f2c74c, bundled with esbuild and run unchanged: its prompts, schemas, segment planning, retry and halving rules, merge and placeholders. Only the transport was replaced. The `generate` function builds each request with the branch's own `buildOpenRouterGenerationRequest` (task `skeleton` or `detail`). It calls OpenRouter on the production route with the Worker's token-cap rule (16,384 when a call's source spans more than 5 minutes, else 8,192) and validates with the branch's own `recordingThreadsFromOpenRouterResponse`. There are no harness repairs. The validator's own reference repair did not fire on any of the 60 accepted calls (follow-up and detail-prompt test).
- **Pacing:** detail calls ran under the personal-key setting, up to three at once with starts scheduled 1.6 s apart. Server-key routes run them one at a time, with the first start scheduled 10.5 s after segment planning (which follows the glance) and each later one scheduled 10.5 s after the one before (`runSegments` with `waitFirst`). Each start is reserved before its wait, so waking late leaves that reservation unchanged, but a busy worker can shift later reservations. From the code, the last detail call is scheduled to start 21 s after segment planning with two segments and 52.5 s with five, against 3.2 s and 8 s with the harness settings; a busy worker can only make a start later. The 31.5 s in Proposal step 5 is the difference between those schedules. No server-key run was measured.
- **Grid:** the same 20-minute source, at today's split and the 60-word split, with 2,800-word segments (the default) and 900-word segments, 3 runs per cell. Cached tokens were logged.
- **The two missing cells** used the first study's harnesses: windows + merge at 60 words without "map finely" (2 runs), and one call with "map finely" at today's split (3 runs, with the sentence reworded for a whole conversation).
- **Counting:**
  - "Filler chunks" are chunks of 10 words or fewer.
  - The pipeline never drops a turn silently, and it uses placeholders at two levels:
    - a placeholder **topic**, when the glance leaves turns out of every topic (detail may still turn those turns into ordinary chunks);
    - placeholder **chunks**, when a detail call leaves turns unfiled.

    "Placeholder turns" in the table counts turns that are only in placeholder chunks.
  - "The speaker" counts summaries with that phrase not followed by "s".
  - "Median chunk" in the follow-up tables is the upper middle value when a map has an even number of chunks.

### Results

| Approach | Split / segment | Valid | Seconds | Billed per map | Chunks | Median chunk (min–max) | Filler chunks | Placeholder turns | "The speaker" |
|---|---|---|---|---|---|---|---|---|---|
| Glance → detail | 150 w / 2,800 | 3/3 | 12.0, 13.3, 10.1 | $0.010–0.012 | 20, 17, 12 | 136 (2–789), 162 (2–533), 251 (2–805) w | 4, 3, 1 | 0, 2, 1 | 0, 0, 0 |
| Glance → detail | 150 w / 900 | 3/3 | 19.5, 14.7, 14.9 | $0.011–0.014 | 16, 16, 9 | 154, 199, 336 w | 0, 0, 0 | 1, 0, 0 | 0, 0, 1 |
| Glance → detail | 60 w / 2,800 | 3/3 | 14.0, 15.3, 15.9 | $0.013 | 17, 15, 13 | 209, 197, 256 w | 0, 0, 0 | 1, 3, 0 | 0, 0, 0 |
| Glance → detail | 60 w / 900 | 2/3 | 16.4, 19.1 | $0.015, $0.013 | 17, 15 | 187, 155 w | 0, 0 | 1, 0 | 0, 0 |
| Windows + merge, no "map finely" | 60 w | 2/2 | 18.4, 14.1 | $0.026, $0.024 | 15, 13 | 197 (67–639), 166 (118–643) w | 0, 0 | 0, 0 | 0, 0 |
| One call, "map finely" | 150 w | 3/3 | 11.1, 9.9, 20.4 | $0.010–0.023 | 9, 10, 41 | 306, 271, 40 w | 0, 0, 8 | 0, 0, 0 | 0, 0, 0 |

The rejected glance-detail run failed at the glance (`hierarchy`, 6.0 s, $0.003). The pipeline does not re-ask the glance, so that map failed whole. Every detail call in the 11 valid maps was accepted first time. Billed cost for this follow-up: **$0.235**, the sum of every logged call (grid $0.139, windows + merge $0.050, single calls $0.045). The study total is now about **$0.70**. (An earlier version said $0.25 and $0.72; the logged calls do not support the extra $0.015.)

### What it shows (3 runs per cell; one transcript)

- **At its defaults, glance → detail gave more chunks than one call at a lower billed cost.** It made 12–20 chunks against 7 and 11, at $0.010–0.012 against $0.014–0.019 billed. Leaving out filler chunks (10 words or fewer), that is 11–16 against 7 and 11. It was about as fine as windows + merge at today's split (10–18), at half the cost and without harness repairs. Names held in every glance-detail map but one, which has a single "the speaker" summary.
- **Smaller utterances and smaller segments did not make it clearly finer:** 13–17 chunks at 60 words, 9–17 with 900-word segments (9–16 at today's split). The maps had 3–7 topics (median 4, counting placeholder topics). In the maps read, topics were broad, for example an intro of about 350 words, childhood of about 1,650 and programming and AI safety of about 1,500.
- **Two quality defects:**
  - **Filler chunks** (a detail-call defect) appeared only at the defaults: 1–4 per map, such as "Awesome." and "Right." filed as their own chunks, against the prompt's fold rule. With 3 runs per cell this is suggestive, and the data cannot say whether the split or the segment size is responsible.
  - **A missing introduction** is a glance defect. The glance runs before segment planning and never sees the segment size, so the 2,800- and 900-word cells use the same glance prompt and settings at each split (each run made its own glance). At today's split the glance left the introduction out of every topic in 2 of 6 valid runs; at 60 words, in 0 of 5. That difference is an observation from this sample, not a shown effect of the split. Detail then still mapped those turns, but under a placeholder topic.

  Placeholder chunks holding 1–3 turns appeared at every setting (in 6 of 11 maps).
- **In windows + merge at the 150- and 60-word splits, only "map finely" and the 60-word split together passed 18 chunks.** At 60 words without the sentence: 15 and 13 chunks. With the sentence at today's split: 16, 18 and 13, held back by long single-utterance chunks. With both: 21 and 22. Two or three runs per cell cannot size each effect. In a single call the sentence was unstable: 9, 10, then 41 chunks with exactly one per utterance (8 of them filler), the same degenerate style the 2026-11-03 study reported in 6 of 28 maps.

## Detail-prompt test (2026-11-27)

The owner approved step 1 of the proposal that follows. `DETAIL_PROMPT` already says to fold short acknowledgements into a neighbouring chunk, so the filler chunks above happened despite an existing rule. The test added a two-sentence passage after that rule (a split instruction and a fold instruction) and changed nothing else:

> Map finely: start a new chunk whenever the point, story or question changes, so a long answer that covers several moments becomes several chunks. A one-line acknowledgement or prompt (for example "Right." or "Awesome.") joins the neighbouring chunk rather than standing alone.

It ran 5 maps at the defaults (today's split, 2,800-word segments) with the same harness, and 4 were valid. The fifth failed at the glance (`hierarchy`, 2.5 s, $0.002), which the passage does not touch.

| | Chunks | Non-filler chunks | Filler chunks | Chunks over 300 words | "The speaker" | Introduction under a placeholder topic | Billed per map |
|---|---|---|---|---|---|---|---|
| Defaults (above) | 20, 17, 12 | 16, 14, 11 | 4, 3, 1 | 5, 6, 4 | 0, 0, 0 | 2 of 3 | $0.010–0.012 |
| With the passage | 20, 31, 21, 16 | 20, 26, 20, 15 | 0, 5, 1, 1 | 3, 3, 3, 6 | 0, 0, 1, 3 | 1 of 4 | $0.011–0.015 |

What it showed (4 maps against 3; suggestive only):

- **Somewhat finer, with fewer very large chunks:** 15–26 non-filler chunks against 11–16. Three of the four maps had 3 chunks over 300 words, against 4–6 at the defaults.
- **The filler chunks were not fixed.** One map split into 31 chunks, 25 of them a single utterance. Its 5 filler chunks were "Awesome.", a one-line host prompt, and three short turns that do carry content (a name, an institute, "a voracious reader."). So the filler count is a length count, not a count of fold-rule violations; "Awesome." alone shows isolated acknowledgements persisted. The added passage did not reliably hold the fold rule.
- **Two maps called the guest "the speaker"** in some summaries (3 in one, 1 in another). The defaults had none. The counts do not show that either map lost the name throughout, or that the passage caused it: each run's glance was generated afresh, so segment contents also differed.
- **The glance is unchanged by design.** Its introduction miss (now 3 of 10 valid glances at today's split, from 11 attempts) and its rejections (2 of 17 glance calls across this study, each failing the whole map with no retry) are separate problems.

Billed for this test: $0.055. Study total: about $0.76.

## Proposal (revised after the follow-up and the detail-prompt test)

Keep ADR-073 glance → detail; build neither windows plus merge nor a different utterance split now. This rests on one benchmark. At today's split, glance → detail gave chunk counts overlapping those of windows + merge (12–20 against 10–18) at about half the billed cost, without harness assembly. The two 60-word "map finely" windows + merge maps had more (21 and 22). None of this establishes a general quality advantage.

1. **Do not ship the detail-prompt passage as tested.** It made maps somewhat finer but did not fix filler chunks, and two maps used "the speaker" in some summaries. Choosing the next lever is the owner's call:
   - a narrower prompt change aimed only at the fold rule;
   - a deterministic post-step that folds acknowledgement-only chunks into a neighbour. It would need a definition of "acknowledgement-only" that spares short turns with content (the prompt keeps short consequential turns on purpose), and it must carry the folded chunk's evidence, parent links and thread references. It also edits a model reply after validation, whereas the pipeline's retry rule re-asks a refused segment rather than repairing it;
   - or accepting the defaults.
2. **Look at why the glance can miss the introduction** (3 of 10 valid glances at today's split). The skeleton prompt already asks topics to cover every utterance, so this is a compliance failure. Changing what the glance covers needs a glance-stage change: its prompt or input, or a coverage check that re-asks when topics leave utterances out. The re-ask in step 3 fires only on a refused glance, and these misses were in accepted glances, so it would not reach them. Which of these would work was not tested. A planning change downstream could only change how the missed turns are shown (today, under a placeholder topic). Either way it is a separate small change, with a regression test built from these maps.
3. **Consider re-asking a refused glance once**, as detail calls already are re-asked. Today a rejected glance (2 of 17 here, both hierarchy rejections) fails the whole map. How often a second ask would succeed was not measured.
4. **Leave the utterance split alone for now.** It did not clearly help glance → detail, and changing it can change which text an utterance id points to when a transcript is rebuilt (see above).
5. **Segment size** (900 vs 2,800 words) showed no consistent effect on grain in this sample, and it costs time: the valid 900-word runs used five detail calls each against two, and every valid 900-word run was slower than every 2,800-word run at the same split. On server-key pacing, three extra detail calls add about 31.5 s to the scheduled start of the last detail call (computed from the code, not measured). Keep the default unless the filler chunks turn out to depend on it. (The missing introduction cannot: it happens in the glance, before segments exist.)

Steps 1–3 are product and code decisions for the owner. No further test spend is proposed until one of them is chosen.

## Limits

- One transcript, a two-person podcast that is mostly long answers from the guest. Conversations with short turns may already be finer with one call.
- Two or three runs per setting. Chunk counts are examples, not estimates of a distribution.
- The windows + merge setting where every run passed 20 chunks combined three changes. The follow-up's two extra cells show that, of the 150- and 60-word cells, only the combination passed 18 chunks in these runs; with 2–3 runs per cell the size of each effect is not estimated. The detail-prompt test was 5 attempts (4 valid) against 3 default maps.
- Windows + merge maps were validated after harness repairs. Single calls were not repaired.
- Window boundaries were cut by time (every 5 minutes), not by topic.
- Quality was judged by counts and by reading some maps against the transcript, not by a blind comparison or a second reader.
- The harness bypasses the Worker. Times leave out admission, and costs leave out Worker retries. Glance → detail ran the branch code locally; the deployed Site build was not tested.

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

Round 3 (packet sha256 3b4971fe…), on the added follow-up: NO-GO, all findings adopted:
- the missing introduction is a glance defect, independent of segment size;
- the glance wrote 2 or 5 arcs in 5 of 11 maps;
- the stale Limits line, and the prompt-and-split interaction;
- placeholder topic vs placeholder chunks;
- the chunk range without filler chunks.

Round 4 (packet sha256 1f428aa9…), on the follow-up and the detail-prompt test. Antigravity's quota was exhausted and Grok returned 402, so this round used OpenAI Codex (`codex exec -s read-only --ephemeral`, model gpt-6.2-sol), packet on stdin from an empty directory. NO-GO. It judged round-3 findings 2, 4 and 5 fixed and 1 and 3 partly fixed, and raised further findings. Each was checked against the logs and saved maps, and all were adopted:
- the Answer still credited smaller segments with removing the missing introduction, and its "finest" and "needed both" wording outran the data;
- the follow-up cost was $0.235 by the logged calls, not $0.25 (study total about $0.76, not $0.78);
- the server-key pacing estimate was restated from `runSegments`;
- results are scoped to the branch code run locally, not the deployed build or production reliability;
- the 900-word chunk range is 9–17 across both splits;
- two detail-prompt maps, not one, used "the speaker", with no claim of cause;
- the filler count is a length count, and a deterministic fold needs a definition and must carry evidence, parents and thread steps;
- the introduction denominator (10 valid glances of 11), what a planning fix can and cannot change, and the unmeasured glance re-ask;
- smaller corrections: the merge call also sees the participant note, the evidence step adds to a parent's own evidence, the 52 thread steps were rechecked in the saved maps (all present), the single-child count is structural, segment count is "two in all six maps", and the follow-up median is the upper middle value.

Round 5 (Codex, same model, packet sha256 c7212484…): NO-GO. It found 11 of the 16 round-4 items fixed and 5 partly fixed, and four remaining issues. The pacing figures come from `runSegments`, which round 5's packet lacked, so the excerpt was added for round 6 instead of deleting them. Also: "every 900-word run" became "every valid 900-word run"; the segment cells use the same glance settings, not one glance; the Proposal now names its comparison (today's split, chunk counts, billed cost); the remaining "finest" and "needed" wording is gone; oversized-topic coherence is unmeasured; the split's effect on ids is stated conditionally; and the detail-prompt insertion is called a two-sentence passage.

Round 6 (Codex, same model, packet sha256 4127d708…, now with the `runSegments` excerpt): NO-GO on wording only. Addressed: the pacing figures are now scheduled start times (a busy worker can only delay a start); the glance re-ask fires only on refused glances, so it is not offered as a fix for the missed introductions, which were in accepted glances; "most chunks" was wrong (one 40-word map had 30), now "every run passed 20"; Proposal step 4 states the id effect conditionally; the valid 900-word runs, not all, made five detail calls; "overlapping" ranges; the naming paragraph reports what the code builds and assigns no cause.

Round 7 (Codex, same model, packet sha256 731f497e…): NO-GO on residual wording, all addressed: the first server-key detail start is anchored after segment planning, not the glance; the Answer's "only the combination passed 18" is scoped to the 150- and 60-word cells; "windowed maps" became "windows + merge maps"; the Round 5 record no longer claims the naming fix; and Proposal step 2 now includes a coverage-triggered re-ask as a glance-stage option.

Round 8 (Codex, same model, packet sha256 d2424a15…): NO-GO on one point, addressed: `nextStart` advances the schedule before sleeping, so both pacing paragraphs now describe scheduled starts rather than a guaranteed minimum gap. It found no other discrepancies against the logs and code.

Round 9 (Codex, same model, packet sha256 cf8ac97c…): all round-8 points fixed; NO-GO on one phrase, addressed: "a late start does not push back the next one" overstated it, since a busy worker can shift later reservations.

Round 10 (Codex, same model, packet sha256 a4c63408…): **GO**. It confirmed the round-9 fix and that the earlier fixes still hold, rechecked the pacing figures against `runSegments`, and found no new errors.

Also fixed: two counts from the first draft (13 of 18 chunks, not 15; "the speaker" in 3 and 5 summaries per plain-window run, not up to 10; a looser count that also matched "the speakers" gave 3 and 6).

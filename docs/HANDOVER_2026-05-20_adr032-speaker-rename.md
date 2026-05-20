# Handover: 2026-05-20 — ADR-032 implementation + windowed speaker rename

> File: `docs/HANDOVER_2026-05-20_adr032-speaker-rename.md`
> Covers the **2026-05-19 → 2026-05-20** ADR-032 arc. Earlier work (ADR-030
> pipeline, tech-debt sweep, consumption-prayer MVP, mobile fixes) is handed
> over in `docs/HANDOVER.md` (legacy *stacked* file — entries for 2026-05-18,
> 05-17, 04-03). Built from the full session transcript
> (`b37dd88e…jsonl`, 17,635 records) — message/commit digests are in
> `.tmp_validation/digest_*.txt`.

## Session Summary

This session designed and implemented **ADR-032** — a coordinated rework of
the conversation-graph artifact: a temporal swim-lane layout, a semantic edge
taxonomy (replacing useless temporal-next edges), IndrasNet-backed enrichment
context, node timestamp/excerpt persistence, Cmd+K search, full-state JSON
export, and a windowed speaker-correction endpoint. ADR-032 was written after
a long design discussion (the user's explicit ask: *"rather than immediate
payoff I care about fundamentals and slow steady quality work"*), then
implemented across ~21 commits and validated end-to-end on a 15-min imported
conversation. **9 of 12 ADR-032 backend steps are done; the frontend is ~6 of
8 done.** Parts I/J and most of Part B remain. Nothing pushed.

## Commits — this session's ADR-032 arc (all on `main`, NOT pushed)

`2026-05-20`
- `12130cb` docs(handover): 2026-05-20 ADR-032 (this doc — first draft)
- `2bd27f4` feat(api): windowed speaker-correction endpoint + tests (Part H)
- `3288754` feat(api): full-state JSON export endpoint + tests (Part L)
- `f76e9c1` fix(persist): three issues caught running import + enrichment e2e
- `e3b85a2` fix(enrichment): two bugs caught during e2e validation

`2026-05-19`
- `8deaf85` feat(graph): Tier-1 UX — hide empty Analysis, argument trace, Cmd+K search
- `bb7f544` feat(graph): swim-lane time-axis + edge category styling + temporal toggle
- `d05027c` feat(stt): wire edge enrichment + word-timing request into post-flush
- `0024f80` feat(enrichment): edge-enrichment pipeline + node timestamps + source_excerpt
- `deba5f8` feat(schema): data foundation — source_excerpt + word_timings + speaker_correction_events
- `fd46415` docs(vision): addendum on argument visualization + active learning
- `b4c33d1` docs(adr+vision): ADR-032 v2 comprehensive
- `353dbe4` docs(adr): ADR-032 temporal swim-lane layout + semantic edge taxonomy
- `2d425bf` fix(ui+backend): HUD overflow scroll, summary X button, human audio filename
- `35d8192` fix(graph): drill is double-click, single-click opens drawer
- `cba5457` feat(graph): click-to-drill into a macro node + breadcrumb
- `c82c5d8` feat(graph): persist + surface node parent_id and children_ids
- `5d801e8` fix(graph): auto-fit viewport when displayed semantic tier changes
- `f761f8d` fix(conversation-view): derive temporal chain at read time
- `7fa2646` fix(graph): default canvas to highest populated tier, allow level 5
- `6e873d9` feat(stt): run hierarchy consolidation in live STT post-flush
- `b8c63f0` feat(stt): Option B — thread utterance_id into chunk linkage

**PUSHED: no.** `main` is **35 commits ahead of origin** (this session +
parallel session). Do NOT push without explicit user authorization.

### Parallel session — NOT this session's work
A second concurrent Claude session (transcript `5bb90899…jsonl`) did the
**participant-picker, mobile, Vercel and contacts** work. Its commits include
`6205b17`/`3057f6e`/`82ea2e0`/`b92f75d`/`7326297`/`7a8bc06`/`d9b873d`/`fc8d0d3`
(participant picker), `ced25ae` (paginate contacts), `cf35e80` (Vercel SPA
rewrite), `1d6cdaf`+`89110b7` (contacts caching), `213652f`+`db65e8e` (mobile
footer), `9cced35` (load_dotenv), `cc988e2` (SUPERVISION.md). Attribute
accordingly. Never `git add -A` — stage explicit paths
(memory: `parallel-agent-git-contention`).

## ADR-032 Status — Part by Part

Full spec: `docs/adr/ADR-032-temporal-swim-lane-layout-and-semantic-edges.md`.

| Part | Scope | Status |
|---|---|---|
| **A** | Temporal swim-lane layout (X = `timestamp_start`, Y = thread row) | **DONE** — `bb7f544`; `graphLayout.js` `timeBased` mode |
| **B** | Multi-row TimelineRibbon + 6 thread-filter patterns | **PARTIAL** — only pattern 3 (argument-scaffold trace, `8deaf85`). Multi-row ribbon + patterns 1,2,4,5,6 (thread legend, solo/mute, hier-drilldown lanes, brushable window, lasso) NOT built |
| **C** | Edge taxonomy, persist all edges, suppress temporal by default, fuzzy category styling, per-conv toggle | **DONE** — `bb7f544`; read-time temporal-chain synthesis removed. Edge-category legend *filter* UI: unverified/partial |
| **D** | F3 dedicated `enrich_semantic_edges` prompt + `edge_enrichment.py` | **DONE** — `0024f80`; prompt version `e1-2026-05-19` |
| **E** | IndrasNet `/api/retrieval/search` + `external_llm_ok` privacy filter | **CODE DONE** (`0024f80`) — **BLOCKED** by #106: retrieval times out ~10s, so enrichment runs without context every time (graceful degradation works, but context is never actually used) |
| **F** | Word-level timestamp persistence + `WordSyncedTranscript` (Descript-style) | **BLOCKED** — `Utterance.word_timings` column exists (`deba5f8`); OpenAI `diarized_json` returns NO word data even with `timestamp_granularities[]=word` (#98). `WordSyncedTranscript` component NOT built |
| **G** | Node `source_excerpt`, `timestamp_start/end` persisted at write time, `parent_id`/`children_ids` | **DONE** — `deba5f8`, `f76e9c1`, `c82c5d8` |
| **H** | Speaker rename v1 — windowed correction | **PARTIAL** — backend endpoint + 7 tests DONE + committed (`2bd27f4`). Frontend inline transcript rename + Settings window-size control NOT built (#108) |
| **I** | Calm streaming animations (fade-in, edge-draw, lane stagger, autofollow easing) | **NOT DONE** |
| **J** | Telemetry — per-pass latency/token counts, `pipeline_artifacts` rows, NodeDetail dev strip | **PARTIAL** — enrichment emits `[ENRICHMENT]` log lines; structured `pipeline_artifacts` rows + NodeDetail debug strip NOT built |
| **K** | Cmd+K search across nodes/summaries/excerpts/speakers/edges | **DONE** — `8deaf85`, `SearchDialog.jsx` |
| **L** | Export — full JSON + Obsidian Canvas with swim-lane embed | **PARTIAL** — full JSON export DONE + tested (`3288754`). `.canvas` export updated to embed swim-lane spatial info / edge-taxonomy labels: NOT done |

ADR-032's own implementation order is steps 1–15: **1–9 done**, plus 10 (argument
trace only) and 14 (search). Remaining: rest of 10 (filters), 11 (ribbon),
12 (WordSyncedTranscript), 13 (frontend speaker rename), 15 (animation polish).

## Pending Threads

### Continue Immediately
1. **Speaker rename — frontend (#108, Part H).** Backend DONE + committed
   (`2bd27f4`, 7 tests pass). Build: a clickable speaker label in
   `NodeDetail.jsx`'s "Raw Transcript" section → inline input → `POST
   /api/conversations/{id}/speaker-correction` with
   `{utterance_id, new_speaker, time_window_seconds, source:"node_detail_panel"}`.
   Then a Settings control for the window (default 300s). Endpoint contract:
   `window<=0` = whole conversation; `window>0` = `±window s` around the
   corrected utterance, matching `speaker_id`.

### Blocked
1. **#98 word_timings (Part F).** OpenAI `diarized_json` does not return
   word-level timing even with `timestamp_granularities[]=word`. Inspect a raw
   diarization response; if the format genuinely can't carry it, switch
   approach (WhisperX sidecar already produces word timing per the ADR).
   `WordSyncedTranscript` is blocked behind this.
2. **#106 IndrasNet `/api/retrieval/search` 10s timeout (Part E).** Enrichment
   degrades gracefully but never gets context. Investigate the IndrasNet side
   (ISSUES.md notes IndrasNet flapped under load this session).

### Deferred
1. **#85** auto-promote canvas tier when consolidation adds a level mid-stream.
2. **ADR-032 Part B** — multi-row TimelineRibbon + 5 unbuilt thread-filter
   patterns; **Part I** — calm animations; **Part J** — telemetry dev strip;
   **Part L** — `.canvas` swim-lane embed; edge-category legend filter UI.
3. **`consumption_trigger.py` stays mothballed.**
   `lct_python_backend/services/consumption_trigger.py` +
   `tests/unit/test_consumption_trigger.py` (implicit-detection LLM gate, 41
   tests pass) were *intentionally* left uncommitted — the team picked
   explicit-verbal-trigger as the consumption-prayer MVP (see ISSUES.md and the
   2026-05-18 handover). NOT committed this session, by design.
4. **Consumption-prayer follow-ups** (separate task numbering #5/#8/#9/#17/#18
   in ISSUES.md) — auto-detect path, WS event emission, ADR write-up. Untouched
   this session.

## Open Tasks (#82–#108)
Pending: **#85** (tier auto-promote), **#98** (word_timings parse — blocked),
**#106** (IndrasNet retrieval timeout — blocked). In progress: **#108**
(speaker rename — backend done, frontend pending). All others #82–#107 done.

## Validation State
- End-to-end validation ran on a fresh 15-min import,
  conversation **`5953fd1b-2597-408c-916d-f553f8da57f2`** (id in
  `.tmp_validation/conv_id_fresh.txt`). Trimmed from source `772ac0cc`.
- Verified in Playwright: swim-lane time-axis layout, argument-scaffold trace,
  drill-down, default-to-highest-tier, Cmd+K search, JSON export route.
- Edge enrichment produced **22–39 semantic edges** (supports / exemplifies /
  generalizes / rebuts) per run — confirms the new prompt works.
- `word_timings` empty (Part F blocked); IndrasNet retrieval timed out (Part E
  blocked) — both degrade gracefully.
- `source_excerpt` shows 0 on `5953fd1b` specifically because an enrichment
  re-persist wiped it before the reader fix landed; a fresh import without a
  subsequent enrichment pass will show it populated.

## Key Context
- **Two parallel Claude sessions share this repo.** Never `git add -A`; stage
  explicit paths; verify `git diff --cached --name-only` before committing.
- **`persist_graph` is DESTRUCTIVE** — deletes all Node + Relationship rows
  before re-insert. Never test it against real conversations. This session
  destroyed 225 nodes on conversation `772ac0cc` doing exactly that, then
  recovered via re-derive-from-utterances replay + consolidation
  (memory: `persist-graph-is-destructive`).
- **`external_llm_ok` privacy gate** — LCT must filter retrieval items by this
  flag before sending contact data to remote LLMs; IndrasNet does NOT enforce
  it on retrieval endpoints (memory: `indrasnet-external-llm-ok-privacy-gate`).
- **Backend port mess:** SIX listeners up — `43173` (Vite) and
  `43180`–`43184` (uvicorn). `.backend-port` = **43181** (PID 38784). The
  extras are zombie uvicorn instances from repeated port rotation (`--reload`
  is unreliable on this Windows box — module cache staleness recurred all
  session). Recommend killing zombies and restarting clean on one port.
- **OpenAI key** in `lct_python_backend/.env` line 22 — flagged for user-side
  rotation across multiple handovers; exposure is local-only. Don't commit `.env`.
- **Untracked debug artifacts left on disk by design** (not committed):
  `scripts/{replay_772ac0cc,critique_772,inspect_772,dump_llm_inputs_772,
  ab_test_prompts,enrich_conversation,probe_openai_known_speakers}.py`,
  `scripts/critique_772/`, `scripts/*_observations.json`, root `*.png`
  screenshots, `.tmp_validation/` (now also holds transcript digests).
- **`ISSUES.md` is stale** ("Last updated 2026-05-18") — has no ADR-032
  section. Worth adding one; also lists live runtime/STT/deploy blockers
  unrelated to this session.

## Design Intent / User Direction (so the next instance doesn't re-litigate)
- **Fundamentals over immediate payoff** — slow, steady, principled work; no
  band-aids; discuss tradeoffs before implementing design-shaped work
  (memory: `user-prefers-design-discussion-before-implementation`). For clear
  bug fixes, ship immediately.
- **Swim-lane mental model:** row = thread, column = left-to-right temporal,
  node color encodes *time* (deliberately inverts the usual "position = time"),
  bottom ribbon carries timestamps.
- **Edges must carry meaning** — implication, normative/factual claims,
  interruptions, argument scaffolding — NOT temporal-next (derivable from
  ordering). Persist temporal edges but suppress them visually behind a toggle.
- **Speaker rename is windowed on purpose** — a local correction shouldn't
  always go global, because diarization may be wrong globally; default ±5 min,
  configurable in Settings.
- **Participant picker** = soft escalating prompt (5/10/25/60 min), never
  block-and-enforce (ADR-032 non-goal).
- **Calm streaming** — fade-ins, staggered, autofollow camera, no whiplash.
- **Use flash models by default**; promote to larger models only when
  telemetry shows a quality problem ("measure, don't presume").
- "We learn by doing" — ship v1, document v2 intent, iterate.

## Running Processes
- **uvicorn backends** — PIDs 6028/38784/62984/58024/3804 on ports 43180–43184.
  `.backend-port` = 43181. Most are zombies; verify which is live.
- **Vite dev server** — PID 56344 on port 43173.
- Many `node.exe` processes (Vite workers + parallel-session Playwright).

## Learnings Captured
- [x] No new memory files needed — relevant entries already exist
  (`parallel-agent-git-contention`, `persist-graph-is-destructive`,
  `windows-cp1252-utf8-bug-class`, `indrasnet-external-llm-ok-privacy-gate`,
  `user-prefers-design-discussion-before-implementation`,
  `live-recording-no-auto-consolidation`).
- [ ] `docs/HANDOVER.md` is a stacked single-file (handover-skill
  anti-pattern). This handover is a dated file; future ones should be too.
  Consider migrating `HANDOVER.md` to a thin reverse-chronological index.
- [ ] `ISSUES.md` should get an ADR-032 section (part status + #98/#106 blockers).

## Resume Instructions
1. `git status` — working tree should show only untracked debug artifacts.
2. Pick a backend port — `.backend-port` = 43181 (PID 38784). Verify it's live
   (hit the conversation list / `/health`). Optionally kill the zombie uvicorns
   on 43180/43182/43183/43184 and restart clean.
3. Build the speaker-rename frontend (#108, Part H): clickable speaker label in
   `NodeDetail.jsx` Raw Transcript → `POST .../speaker-correction`; add a
   Settings control for the correction time window (default 300s).
4. Then pick from the deferred ADR-032 parts (B ribbon/filters, I animations,
   J telemetry, L `.canvas` embed) or the #98/#106 blockers.

---
*Handover by Claude Opus 4.7 (1M context) — post-compaction, user requested
an exhaustive /handover; rebuilt from the full session transcript.*

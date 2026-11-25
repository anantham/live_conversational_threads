# Handover — glance→detail maps, live-run fixes, unlisted publish links (2026-11-25, Claude Code)

## TL;DR
- **Branch to continue from:** `integ/sites-combined` @ `7bb5f0a9`, worktree `/private/tmp/lct-sites-combined`
  (git dir: the local clone `/private/tmp/lct-sites-anthropic`). **Local only, nothing pushed, nothing deployed.**
- It is `codex/anthropic-sites` @ `1ee16649` (Antigravity's streaming/live canvas/observability/costs/prompts work)
  **plus 13 commits** (six live-run fixes, integration fixes, unlisted publish links, three review rounds of fixes).
- Proven: a live run of the 93-minute "Andre Catch up" Gemini Notes PDF on this branch (owner's Anthropic key, Claude
  Sonnet 5.5) → overview + 7 detail calls all accepted first time, 196 validated nodes, 3 threads, every turn covered.
- **Not done yet:** branches diverged again (below), nothing published live yet, no deploy.

## What is left, in order
1. **Re-consolidate with Antigravity (it moved on).** `codex/anthropic-sites` gained 2 commits after the combine point:
   `92e85d4e` (calm spatial landscape viewer) and `4a0b9568` (generator stopping rule + background epistemic-v1 pass),
   plus uncommitted `lct_app/src/services/cloud/boundaryLearningStore{,.test}.js` in `/private/tmp/lct-anthropic-work`.
   They overlap 6 files with this branch: `sites/anthropic.js`, `sites/openRouter.js`, `SitesTranscriptImport.jsx`,
   `generationTasks.js`, `openRouterClient.js`, `openRouterGeneration.js`. Decide **one integrator** (owner's call),
   then rebase or merge `integ/sites-combined` onto the new tip. Watch especially: the nested detail format
   (`detail-nested-v2`) vs any prompt/schema changes in `generationTasks.js`, and the detail worker pool in
   `glanceDetailPipeline.js` vs anything new that calls it. Re-run one live import afterwards.
2. **Live check of publishing** (not yet done anywhere): on a preview with `LCT_PUBLIC_THREADS_ENABLED=true`, publish a
   *synthetic* map via "Publish & copy link", open the link, confirm it is absent from the library, remove it from
   the Public page ("Your other links on this device").
3. **Deploy (owner):** apply **migration `0020_public_unlisted_larger` to D1 first**, then deploy the Worker. Site settings:
   `LCT_PUBLIC_THREADS_ENABLED=true`, `LCT_PERSONAL_PROVIDERS_ENABLED=true`, `LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS=12000`.
   Save the Anthropic key in Settings → Providers on the deployed origin (keys are per browser and per origin).
4. **Merge to `main`** via PR. The repo gate needs an independent-family review of the exact PR head; three agy/Gemini rounds
   covered this branch's slices (receipts in `docs/WORKLOG.md`), but re-run on the final head after step 1.
5. **Before sharing the Andre map:** the owner should check with Andre (the link exposes his words to anyone holding it).

## Smaller open items
- Viewer: one jump link per return to a revisited topic; "flag irrelevant / misfiled" buttons on nodes (functions exist:
  `recordUserFlag` in `mapAudit.js`). The audit panel needs a non-Claude provider key to run.
- Cross-run ledger of audit outcomes (each `.threads` keeps its own `audit_signals`).
- Store the transcript once per file (today `utterances` + `source_tokens` + `full_transcript` ≈ 3×). Owner chose
  raising the publish limit instead; still worth doing for size/cost.
- Overview latency: 46–75 s for 830 turns against a 90 s provider deadline; if it times out on longer calls, stream it
  or raise the deadline (it feeds `STALE_ATTEMPT_MS` and the client deadline — change together).
- `ISSUES.md`: window halving in the old `longTranscriptPipeline.js` can desync local/global ids (not used by the import page).
- Policy decision kept, not changed: an invalid edge/thread still refuses the whole reply (tier-safe design). The overview
  no longer writes edges, which removed the failure seen live.

## What changed on this branch (commits on top of `1ee16649`)
| Commit | What |
|---|---|
| `83c10f4e` | Edge refusals name their rule; overview writes no edges |
| `f7361c64` | Re-ask a structurally refused detail segment once, rule named |
| `bd42e7a5` | Nested detail replies (ideas hold chunks; topic_id enum per segment); 3 detail calls in flight on personal keys (`PERSONAL_PACING`); briefer overview |
| `b64d6079` | Unused import |
| `c4d761d2` | Requeue detail calls refused at admission (429, nothing spent) |
| `d13f8d07` | Chunk `thread_id` from thread step evidence (timeline showed 0 threads); counter fix |
| `d36b0c73` | Integration: streaming callback used the old loop's `i` in the pool |
| `2f88cdbb` | Integration: live-node scanner + Prompts viewer understand nested detail (viewer broke the build) |
| `25854164` | Review fixes: empty nested replies refused; pool drains in-flight calls on cancel/failure; parallel halves; stage-specific re-ask; majority thread; stable `built_by` |
| `8abb5330` | Unlisted "Publish & copy link"; migration 0020 (`listed`, 1.5 MiB CHECK); safe copy by default |
| `7bb5f0a9` | Review fixes: unlisted links removable from the Public page; allowlist safe copy; strict visibility; consent reset; double-click guard |

Earlier work (single-pass fixes, ranges, glance→detail, audit, first review) is in `claude/claude-map-failure-details`
(`e74e1076`), whose commits up to `383544cb` Antigravity already built on, and the rest were cherry-picked here.
Design record: `docs/adr/ADR-073-glance-detail-laminar-maps.md`.

## Verification state
- Focused suites: all pass. `src/services` + audit + publish: only the baseline failures that `codex/anthropic-sites`
  also has (conversationArchive, llmClient, serverlessAuth, sttClient, searchTiming, sourceLoadTiming — storage globals
  under Node 26 here), plus `conversationSearch.worker` failing only on Vite "Denied ID" because this worktree's
  `lct_app/node_modules` is a **symlink** to `/private/tmp/lct-anthropic-work/lct_app/node_modules`.
- Settings/page tests: same failures on both branches (6/18 settings; 10/16 public/home pages) — pre-existing.
- Lint clean on all changed files; `npm run build:sites` passes.
- Cross-family reviews (agy, `gemini-4-hydrogen-high`, plan mode, code-only packets, hashes in `docs/WORKLOG.md`):
  three rounds on this work; supported findings fixed with tests that fail on the previous code.

## Environment and running things
- **4175 preview** (`node …/scratchpad/preview-4175-combined.mjs`) serves `integ/sites-combined` @ `7bb5f0a9` with
  `LCT_OPENROUTER_DEBUG=true` and a local-only refused-reply structure dump. It does **not** enable public publishing.
  The owner's Anthropic key is saved in the Chrome profile for the `127.0.0.1:4175` origin.
- **4173 preview** belongs to the Antigravity session (serves `/private/tmp/lct-anthropic-work`). Do not restart it.
- Logs and artifacts from this session (session scratchpad, may be cleared on reboot):
  `/private/tmp/claude-501/-Users-aditya-Documents-Ongoing-Local-code-live-conversational-threads/8e361594-4042-4e33-9b52-1fec50d58952/scratchpad/`
  — `preview-4175.log` (per-call lines for every live run), `review*/` (packets + reviews).
- Owner's files: `~/Downloads/andre catch up.threads` (639 KiB, final run), `… (shareable).threads` (491 KiB),
  `… (public-safe).threads` (475 KiB, no emails/links/notes; recommended for sharing).
- macOS denied this session access to `~/Documents` mid-session, so the main checkout
  (`…/code/live_conversational_threads`, branch `deploy/origin-main`) was not inspected at the end.

## Lessons recorded
- `~/.claude-sync/MISTAKES.md` (2026-11-25): a bulk `sed` over a pattern match rewrote a checked-in real transcript
  (restored, never committed); call-note names had been used in fixtures (replaced).
- drizzle-kit generated two defects in 0020 (copying a new column from the old table; CHECKs qualified with the temp
  table name) — fixed by hand and pinned by `publicUnlistedMigration.test.js`. Check generated rebuild migrations for both.

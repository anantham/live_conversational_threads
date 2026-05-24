# Handover: 2026-05-23 — no-audio guards, STT quota, e2e triage, terminology cleanup

> File: `docs/HANDOVER_2026-05-23_no-audio-guards-e2e-quota.md`
> Continues from `docs/HANDOVER_2026-05-21_reconciler-and-mobile-fixes.md`.
> That doc ended mid-CORS-thread — **that thread is now closed** (see Session
> Summary). The parallel session's speaker / participant-picker / mobile-
> diagnostics arc is its own story; its commits interleave on `main` and are
> listed but not detailed here.

## Session Summary

Resumed from the 2026-05-21 handover and worked five threads to completion:

1. **CORS thread closed.** The 2026-05-21 "blocked by CORS policy" error on
   `threads.adityaarpitha.com` was exactly the predicted masked failure — the
   backend on 43181 was down. Backend is up now (verified end of session),
   error cleared. **No CORS code change was needed.**
2. **Dev-branch fix recovery** (`7b29991`) — salvaged two standalone fixes
   from the abandoned `origin/dev` branch; rest of dev is a dead architecture
   direction. Re-applied fresh (dev is 128 commits behind, line numbers drifted).
3. **Terminology cleanup** (`fda411d`) — renamed the L1 graph tier label
   `chunks` → `moments` and unified the tier vocabulary. UI count string is now
   `12 ideas · 134 moments`.
4. **e2e suite triage + de-flake** (`90c1f98`, `30ce72f`) — baseline was
   45 passed / 9 failed / 2 skipped; both commits dropped 13 dead diag files
   and cured all 9 failures (mix of harness rot and test-bug flake).
   `hierarchy-tabs-visual` and `live-recording-stream` still need work — see
   Pending #1 / #2.
5. **No-audio guard A + B** (`0d70d88`, `ccef872`) — stop streaming dead-air
   to OpenAI. Guard A halts a never-had-audio session; guard B auto-pauses a
   live recording after sustained trailing silence.
6. **STT usage accounting wired** (`02c0e67`) — `QuotaService.record_usage`
   was defined but never called, so free-tier minutes never debited. Now
   called on post-flush, billing only audio actually forwarded.

Also updated `lct_python_backend/.env.example` (this handover task — see
**Uncommitted changes** below) to document the new env knobs.

## Commits This Session — all pushed

`main` is level with `origin/main` (0 ahead, 0 behind). Chronological order:

| Hash | Theme | Touched |
|------|-------|---------|
| `7b29991` | fix: recover back-button z-index + backups/ gitignore from dev branch | `.gitignore`, `lct_app/src/pages/NewConversation.jsx` |
| `fda411d` | refactor(graph): rename L1 tier "chunks" -> "moments", unify tier vocabulary | `graphConstants.js`, `MinimalGraph.jsx`, `ExportCanvas.jsx`, `SearchDialog.jsx`, `settings/ArtifactExportCard.jsx` |
| `90c1f98` | test(e2e): triage baseline — fix networkidle waits, drop diag cruft | 13 deleted diag files; `hierarchy-tabs-visual`, `import-audio`, `quota-recording` specs |
| `30ce72f` | test(e2e): de-flake initialization + d4-color-mode specs | `initialization.spec.ts`, `d4-color-mode-smoke.spec.ts` |
| `0d70d88` | feat(stt): no-audio guard — stop streaming silence to OpenAI | new `services/no_audio_guard.py`; `stt_ws_session.py` (guard A wiring); new `tests/unit/test_no_audio_guard.py` |
| `ccef872` | feat(stt): no-audio guard B — auto-pause on trailing silence | `no_audio_guard.py` (guard B); `stt_ws_session.py` (auto_pause emit); frontend `audioMessages.js`, `useTranscriptSockets.js`, `AudioInput.jsx` |
| `02c0e67` | fix(stt): debit live-STT quota usage — record_usage was never called | `services/quota_service.py` (date bug); `stt_ws_session.py` (`_record_stt_quota_usage` in post-flush finally) |

**Parallel session's commits, interleaved on `main` (theirs, not covered here):**
`872f228`, `7449bc1`, `3c7f02c`, `f6cdd1b`, `56da8b8`, `5e12147`, `638eb57`,
`83c867d`, `d642f61`, `71e3b01`, `d26e4dd` — the speaker / participant-picker /
mobile-diagnostics arc.

### Known wart in `0d70d88`

`0d70d88` (guard A) accidentally `git add`-bundled the parallel session's then-
uncommitted `_run_participant_speaker_inference` WIP in `stt_ws_session.py`.
They later committed the same work cleanly as `638eb57`, so `0d70d88` carries
a *stray duplicate hunk* — messy attribution, **not** destructive, nothing lost.

**Recovery attempt and why it was abandoned (the git-surgery story):**
1. Ran `git reset --soft HEAD~1` intending to un-split `0d70d88`.
2. But by then the parallel session had landed `638eb57` on top, so HEAD~1
   was `0d70d88` itself, not its parent — the reset orphaned `638eb57`.
3. Junk recommit `7dbc185` was created (now discarded).
4. Recovery: `git reset 638eb57` re-landed their commit. Nothing lost.
5. User: "try no" → stopped trying.

Memory `parallel-agent-git-contention` updated with this lesson (2026-05-23
addendum: even `git reset --soft` is unsafe against a live parallel session).

### Uncommitted changes (this handover task)

The following are on disk but **not yet committed**:
- `docs/HANDOVER_2026-05-23_no-audio-guards-e2e-quota.md` — this file.
- `docs/HANDOVER.md` — index updated to point at this file.
- `lct_python_backend/.env.example` — added the no-audio-guard and quota env
  knobs (`STT_NO_AUDIO_*`, `FREE_STT_DAILY_MINUTES`, `FREE_LLM_DAILY_TOKENS`,
  `QUOTA_WARNING_PERCENT`, `BYOK_REQUIRED_AFTER_FREE`).

Stage these explicitly when committing — `git add -A` would sweep the parallel
session's untracked scratch (see Key Context).

## Pending Threads — triaged by context-dependency

### Context-warm — do these with this session's context

1. **#30 — de-flake `hierarchy-tabs-visual.spec.ts` (in progress, not done).**
   `lct_app/tests/e2e/hierarchy-tabs-visual.spec.ts` still has two blind sleeps:
   - **Line 27** `await page.waitForTimeout(4000)` right after `page.goto(...)`
     — replace with an element-wait, e.g.
     `await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30000 })`.
   - **Line 50** `await page.waitForTimeout(1500)` inside the per-tab loop
     (`tabs = ['moments','ideas','topics','themes']`) — wait for *that tab's*
     nodes to render rather than sleeping a fixed 1.5s.
   The test depends on a real backend + the seeded conversation
   `0d6d5d7b-4397-4dbc-89ff-13067ce9fadb` (post-backfill counts moments=4,
   ideas=1, topics=1, themes=1). It is the last structurally-flaky spec.

2. **#30 — gate `live-recording-stream.spec.ts`.** That spec is the 8-minute
   STT-dependent test (`test.setTimeout(8 * 60 * 1000)`, line 85; uses
   `--use-file-for-fake-audio-capture`, `headless:false`). In a normal/CI run
   with no STT it just burns 8 minutes then fails. Add an opt-in skip at the
   top, e.g. `test.skip(!process.env.RUN_STT_E2E, 'set RUN_STT_E2E=1 to run the live STT e2e')`,
   so it only runs when explicitly requested.

3. **#29 — collapse the two Playwright configs.** `lct_app/` has both
   `playwright.config.ts` (canonical — `testDir: './tests/e2e'`, `webServer`
   block present but commented out) and `playwright.config.js` (**dead** —
   `testDir: './tests'`, wrong dir). Delete `playwright.config.js`. Then
   un-comment / wire the `webServer` auto-start in the `.ts` config so the
   suite spins the frontend itself.

4. **`SessionTranscriptOverlay.jsx:178` residual `chunks` label.** In upload
   mode the transcript overlay still reads `{normalizedLines.length} chunks`
   (vs `lines` in live mode). The `fda411d` commit message explicitly puts
   audio-"chunk" naming out of scope, so this is a *known* residual ambiguity,
   not a bug — but a user could see `134 moments` in the graph and `12 chunks`
   in the transcript overlay and wonder if they're the same thing. Worth a
   follow-up: pick `segments` / `pieces` for the upload mode, or just `lines`
   in both modes.

5. **Commit the three uncommitted files** (see *Uncommitted changes* above)
   on an explicit pathspec.

### Blocked / design-pending

1. **#29 CI gate is design-shaped — surface, don't build unilaterally.**
   A GitHub Actions e2e gate needs Postgres + the backend + (for the STT
   spec) a fake-audio STT path stood up in CI. Real infra decision with
   tradeoffs (cost, flake budget, what subset gates a PR vs. runs nightly).
   Per the user's design-discussion preference: present options first. The
   `RUN_STT_E2E` gate from #30.2 is the natural seam — CI runs the suite
   *without* that env var; the live-STT spec stays opt-in / local / nightly.

2. **Stale-branch cleanup pass.** `origin` has **19 stale remote branches**
   (see *Branch triage* in Key Context). Mostly 6+ weeks old refactor/feature
   branches; the dev branch already mined for its salvage in `7b29991`.
   `git branch -r --merged origin/main` will identify safe deletes, but the
   *user decision* on the unmerged ones (especially `feat/graph-ux-progressive-upload`,
   which corresponds to the 2026-04-03 handover's PR #49) needs surfacing.

### Context-cold — safe for a fresh instance

1. Remaining ADR-032 parts (Part B navigation, Part I calm animations, Part J
   telemetry strip, Part L `.canvas` swim-lane embed, edge-category filter UI)
   — all ADR-documented. `#85` auto-promote canvas tier mid-stream — ADR-032.
2. `#98` word_timings — OpenAI `diarized_json` has no word-level timing; the
   real path is WhisperX. Multi-step feature.
3. `#106` IndrasNet `/api/retrieval/search` 500s — host RAM pressure blocks
   the embedding model. Operational (host-side), not LCT code.

### Deferred

- **Graph-legibility ideas not picked.** The user selected "Terminology
  cleanup" within a broader "Graph legibility redesign" question. The other
  legibility threads (aggregation/drill-down UX, edge density, color-mode
  hover semantics) weren't surfaced this session. Memory
  `graph-aggregation-ux-direction` is the standing direction (default to the
  highest-available tier — 1-5 macro nodes — hover/click drills into children).
- `consumption_trigger.py` + `test_consumption_trigger.py` — intentionally
  mothballed, untracked on disk. Leave them.

## Key Context

### CORS-thread closure (diagnostic chain, for the record)
The 2026-05-21 handover diagnosed the "blocked by CORS policy" error as a
masked backend-down. The chain was:
1. Backend `.env` `CORS_ALLOW_ORIGINS` already included
   `https://threads.adityaarpitha.com`. **Allow-list was not the problem.**
2. The running backend's log confirmed `threads.adityaarpitha.com` was in the
   resolved allow-list at startup.
3. `Test-NetConnection 127.0.0.1 -Port 43181` showed **no listener**; only
   stale zombie sockets on 43180/43182/43183.
4. The Vercel frontend hits the backend via Tailscale Serve at
   `asus-strix-scar.tail4741ad.ts.net`. With the backend down, Tailscale Serve
   returns 502; a 502 carries no `Access-Control-Allow-Origin` header → the
   browser surfaces it as a CORS error.
5. **Fix:** restart per memory `lct-backend-windows-startup`. Backend is up
   now (verified `Test-NetConnection 127.0.0.1 -Port 43181` succeeds).

This pattern (backend down ↔ "CORS error" on the deployed frontend) is now in
memory `lct-backend-windows-startup` from the 2026-05-21 session.

### No-audio guard (`0d70d88`, `ccef872`)
- **New file:** `lct_python_backend/services/no_audio_guard.py` — `NoAudioGuard`
  class + `chunk_rms()`. `observe(pcm, sample_rate)` returns
  `{forward, warn, stop, auto_pause, silent_run_s, rms}` and tracks
  `forwarded_audio_s` (seconds of audio actually forwarded — used for billing).
- **Guard A** (no speech *ever*): warn at 20s of silence, halt forwarding at
  60s. Emits `stt_no_audio` WS warnings.
- **Guard B** (speech heard, then trailing silence): emits a one-shot
  `auto_pause` WS message at 300s → the frontend pauses the recording.
- **Env knobs** (now documented in `.env.example`):
  `STT_NO_AUDIO_RMS_THRESHOLD` (90), `STT_NO_AUDIO_WARN_AFTER_S` (20),
  `STT_NO_AUDIO_STOP_AFTER_S` (60), `STT_NO_AUDIO_PAUSE_AFTER_S` (300),
  `STT_NO_AUDIO_GUARD_ENABLED`.
- **Backend wiring** — `stt_ws_session.py::_process_audio_chunk` (~line 1986)
  calls `self._no_audio_guard.observe(...)`, emits `stt_no_audio` warnings +
  `auto_pause` WS message via `_safe_send_json`.
- **Frontend wiring (file:line manifest):**
  - `lct_app/src/components/audio/audioMessages.js:15` — `onAutoPause` param.
  - `lct_app/src/components/audio/audioMessages.js:146-150` — handles
    `message.type === "auto_pause"` → calls `onAutoPause?.(message)`.
  - `lct_app/src/components/audio/useTranscriptSockets.js:39` — `onAutoPause`
    param accepted.
  - `lct_app/src/components/audio/useTranscriptSockets.js:70` — passed
    through into `createBackendMessageHandler`.
  - `lct_app/src/components/AudioInput.jsx:282` — `pauseRecordingRef = useRef(null)`.
  - `lct_app/src/components/AudioInput.jsx:315` —
    `onAutoPause: () => pauseRecordingRef.current?.()` wired into the
    `useTranscriptSockets` call.
  - `lct_app/src/components/AudioInput.jsx:544` —
    `pauseRecordingRef.current = pauseRecording` keeps the ref in sync (the
    auto_pause message handler always sees the latest `pauseRecording`).
- **Tests** — 10 unit tests in `tests/unit/test_no_audio_guard.py`, all pass.

### STT quota wiring (`02c0e67`)
- **The bug:** `QuotaService.record_usage` keyed the row update on a
  `datetime` (`today_datetime`), but `UsageQuota.date` is a `Date` column and
  `check_quota` queries `date.today()`. `datetime != date` ⇒ row never
  matched ⇒ never updated ⇒ minutes never debited. Fixed to key on plain `date`.
- **Wiring:** `stt_ws_session.py` now has `_record_stt_quota_usage()`, called
  from the `finally` of `_run_post_flush_processing` (~lines 2085–2377). It
  bills `guard.forwarded_audio_s` (silence the guard halted is **not**
  billed). BYOK users are skipped. `_quota_owner_id` / `_quota_is_byok` are
  captured at quota-check time (~line 2706) so they're available at post-flush.
- **Env knobs** (now documented in `.env.example`): `FREE_STT_DAILY_MINUTES`
  (10), `FREE_LLM_DAILY_TOKENS` (50000), `QUOTA_WARNING_PERCENT` (80),
  `BYOK_REQUIRED_AFTER_FREE` (true).

### Terminology cleanup (`fda411d`) — scope verified
- The L1 graph tier UI label moved `chunks` → `moments`. **Backend
  `semantic_type` values (`chunk`/`idea`/`topic`/`theme`/`arc`) are unchanged**
  — only the human-facing label moved.
- 5 files changed: `graphConstants.js` (shared `AUTHORED_LEVELS`),
  `MinimalGraph.jsx` (count readout), `ExportCanvas.jsx` (export checkbox),
  `SearchDialog.jsx` (tier labels), `settings/ArtifactExportCard.jsx`.
- The e2e suite caught the rename: `hierarchy-tabs-visual.spec.ts` had a
  hard-coded `chunks` that broke against the new label — fixed in `90c1f98`.
- **Deliberately out of scope** (per the commit message): the legacy-cluster
  fallback vocabulary, ThematicView, **audio-"chunk" naming**, all backend
  `semantic_type` values. Verified by grep — remaining `chunks` references in
  `lct_app/src` are all upload-mode transcript chunks or data-structure keys,
  not L1 tier labels. **One residual UI ambiguity:**
  `SessionTranscriptOverlay.jsx:178` (see Pending #4).

### e2e baseline triage — enumerated
**Baseline (pre-`90c1f98`):** 45 passed / 9 failed / 2 skipped.

| Spec | Failure | Cured by | How |
|------|---------|----------|-----|
| `quota-recording.spec.ts` | `page.goto(..., {waitUntil:'networkidle'})` on `/new` (persistent WS) → 30s goto timeout (×4 cases) | `90c1f98` | `'networkidle'` → `'domcontentloaded'` |
| `import-audio.spec.ts` | same networkidle on `/new` | `90c1f98` | same |
| `import-audio.spec.ts` | `BACKEND_URL` default `43180` (dead socket) | `90c1f98` | bumped to `43181` |
| `hierarchy-tabs-visual.spec.ts` | `tabs=['chunks',…]` hardcoded; `fda411d` renamed it | `90c1f98` | `['chunks',…]` → `['moments',…]` (moments=4 / ideas=1 / topics=1 / themes=1) |
| `initialization.spec.ts` | route-nav read `body.textContent()` right after `domcontentloaded`, catching mid-mount loading text | `30ce72f` | retrying `toContainText` assertion |
| `d4-color-mode-smoke.spec.ts` | blind `waitForTimeout(4000)` "settle graph" sleep loses under parallel-suite load (passes in isolation) | `30ce72f` | wait for the graph to actually render |

**Diag/debug cruft dropped in `90c1f98`** (13 files): `DIAGNOSTIC_PLAN.md`,
`DIAGNOSTIC_RESULTS.md`, `debug-console.spec.ts`, `diag-canvas.spec.ts`,
`diag-h1-reactflow.spec.ts`, `diag-h2-router.spec.ts`, `diag-h4-css.spec.ts`,
`diag-h5-browser-apis.spec.ts`, `diag-h6-network.spec.ts`,
`diag-h7-incremental.spec.ts`, `diag-h8-strictmode.spec.ts`,
`diag-summary.spec.ts`, `simple-debug.spec.ts`. (~1,625 LOC of one-off
debugging leftovers — none were feature tests.)

**Surviving specs (10):** `d4-color-mode-smoke`, `d6-autosave-smoke`,
`fullscreen-button`, `graph-visualization`, `hierarchy-tabs-visual`,
`import-audio`, `initialization`, `live-recording-stream`, `mobile-audit`,
`quota-recording`. After both commits: `hierarchy-tabs-visual` and
`live-recording-stream` still have known issues (Pending #1 / #2); the
others were green at last suite-run.

### Branch triage — `origin/dev` mined; 19 stale branches remain
Sorted by last commit date:

| Last commit | Branch | Status |
|-------------|--------|--------|
| 2026-05-04 | `origin/dev` | Dead architecture direction; the 2 salvage commits (back-button z-50, `backups/` gitignore) are now on main via `7b29991`. **Safe to delete after user confirmation.** |
| 2026-04-03 | `origin/feat/graph-ux-progressive-upload` | Corresponds to 2026-04-03 handover's PR #49. Likely merged or superseded — needs verification. |
| 2026-04-02 | `origin/codex/fix-stt-cloud-test-observability` | Old codex branch. |
| 2026-03-13 | `origin/feat/active-config-summary` | 6+ weeks old. |
| 2026-03-12 | `origin/refactor/stt-diagnostics-split`, `origin/refactor/merge-llm-panels` | 6+ weeks old refactor branches. |
| 2026-03-08 | `origin/refactor/extract-prompt-editor` | 6+ weeks old. |
| 2026-03-06 | `origin/refactor/import-bulk-pipeline-split`, `origin/refactor/stt-ws-session-extract`, `origin/feat/edge-click-inspect`, `origin/refactor/file-transcriber-split` | 6+ weeks old. |
| 2026-03-05 | 8 more `feat/*`, `fix/*`, `refactor/*` branches | 6+ weeks old; the bulk of the stale set. |

Recommended next step: `git branch -r --merged origin/main` to identify safe
deletes. Don't delete unilaterally — user decision per the
*safety-rules-actions* protocol (modifying shared infra).

### Standing hazards
- **Never do `git reset` (any flag) while the parallel session is committing.**
  Even `--soft` is unsafe — HEAD~1 moves when they land a commit on top. This
  session's example: a `--soft HEAD~1` from `7dbc185`'s parent orphaned
  `638eb57` because the parallel session had committed it just before my
  reset. Always `git log --oneline -5` first and confirm HEAD~1 is what you
  think it is. Better: don't surgically un-split contended commits — messy
  attribution is cheaper than recovery risk. (Memory
  `parallel-agent-git-contention` updated with this.)
- **The parallel session is very active on `main`** — its commits interleave
  with yours. Never `git add -A` / `git add .`. Stage explicit pathspecs and
  run `git diff --cached --name-only` before every commit.
- **Untracked scratch on disk is intentional — leave it:** validation
  screenshots (`*.png` — `adr032-*`, `macro-view-*`, `mobile-footer-*`,
  `double-click-drill.png`, `drilldown-themes.png`), `scripts/` investigation
  scripts (`replay_772ac0cc.py`, `critique_772.py`, `inspect_772.py`,
  `enrich_conversation.py`, `dump_llm_inputs_772.py`, `ab_test_prompts.py`,
  `probe_openai_known_speakers.py`, `consolidation_observations.json`,
  `replay_observations.json`, `critique_772/`), `.tmp_validation/`, and
  `consumption_trigger.py` + its test (mothballed). All from prior sessions
  or the parallel session — not deliverables.
- Memories worth re-reading: `lct-backend-windows-startup` (clean restart;
  a down 43181 backend masquerades as a CORS error),
  `parallel-agent-git-contention` (now with the LCT addendum and the
  `--soft` reset lesson), `persist-graph-is-destructive`,
  `indrasnet-external-llm-ok-privacy-gate`, `vite-must-bind-all-interfaces`,
  `graph-aggregation-ux-direction`.

## Learnings Captured

- [x] **Memory updated:** `parallel-agent-git-contention.md` — added LCT
  addendum (the parallel session is now active in LCT too, not just
  TemporalCoordination) + `git reset --soft` hazard with the
  `0d70d88`/`638eb57` worked example.
- [x] **`.env.example` updated** — `STT_NO_AUDIO_*` guard knobs and quota
  knobs (`FREE_STT_DAILY_MINUTES`, `FREE_LLM_DAILY_TOKENS`,
  `QUOTA_WARNING_PERCENT`, `BYOK_REQUIRED_AFTER_FREE`) now documented for
  operators. Uncommitted — see *Uncommitted changes*.
- [x] CORS-error-as-masked-backend-down is already in memory
  `lct-backend-windows-startup` (from the 2026-05-21 session) — confirmed
  true again this session.

## Running Processes

- **LCT backend (uvicorn) — UP.** Port 43181 has a listener (verified end of
  session). Started per memory `lct-backend-windows-startup`: from the repo
  root, `uvicorn lct_python_backend.backend:lct_app --host 0.0.0.0 --port 43181`,
  detached, **no `--reload`**. `start_services.ps1` is stale — don't use it.
- **Vite dev server** — port 43173 (if the user's local dev frontend is up).
  Must bind `--host 0.0.0.0` for Tailscale Serve (memory
  `vite-must-bind-all-interfaces`).

## Resume Instructions

1. **Read this handover** + `MEMORY.md` (auto-loaded). The active task list is
   #29 (pending) and #30 (in progress).
2. **Commit the three uncommitted files** on an explicit pathspec — this
   handover, `docs/HANDOVER.md`, and `lct_python_backend/.env.example`.
   `git diff --cached --name-only` before committing (parallel session is live).
3. **#30 — finish the e2e de-flake** (context-warm, do next):
   - `hierarchy-tabs-visual.spec.ts`: replace the line-27 `waitForTimeout(4000)`
     with an element-wait on `.react-flow__node`; harden the line-50 per-tab
     `waitForTimeout(1500)`.
   - `live-recording-stream.spec.ts`: add a `test.skip(!process.env.RUN_STT_E2E, …)`
     gate so the 8-minute STT test is opt-in.
4. **#29 — config consolidation:** delete the dead `lct_app/playwright.config.js`;
   wire the `webServer` auto-start in `playwright.config.ts`.
5. **#29 CI gate — discuss before building.** Present options to the user
   (what gates a PR vs. runs nightly, how STT is handled, flake budget).
   Don't build the workflow unilaterally — it's design-shaped.
6. **Branch cleanup** — run `git branch -r --merged origin/main`, present the
   safe-delete list to the user. Don't delete unilaterally.
7. **Optional:** decide the `SessionTranscriptOverlay.jsx:178` `chunks`
   residual (Pending #4) — small UX call; pick once and ship.

---
*Handover by Claude Opus 4.7 (1M context). Session ran 2026-05-22 → 2026-05-23;
all 7 of this session's commits are pushed. User requested explicit /handover
and then asked for exhaustive fill-in of triage detail, memory updates, and
env-doc updates — this revision captures all of that.*

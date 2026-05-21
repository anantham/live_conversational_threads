# Handover: 2026-05-21 — live link reconciler, Speaker-section retirement, mobile fixes, deploy

> File: `docs/HANDOVER_2026-05-21_reconciler-and-mobile-fixes.md`
> Continues the long ADR-032 session. Earlier arcs are in
> `docs/HANDOVER_2026-05-20_adr032-speaker-rename.md` (Part H + reconciler design)
> and the parallel session's `02f838a` handover (participant picker / pause-resume).

## Session Summary

Closed the speaker thread end-to-end: built the **live utterance↔node
reconciler** (`4fe154c`) that fixed the root cause of the "SPEAKER_00 not found"
rename bug on live recordings, **retired** the redundant/buggy NodeDetail global
Speaker section (`8bd07a4`, option A), shipped the **Part H** transcript-inline
rename frontend (`dd8ee43`). Then pushed the speaker stack + restarted the
backend cleanly on 43181. Added a **private-beta gate** (`0976a9e`) and fixed two
mobile critiques — **autostart** (`c0b09d2`, #116) and **upload status**
(`4da94b3`, #115). **#114 (mobile stats panel) is mid-flight** — a curation
proposal is on the table awaiting the user's confirm.

## Commits This Session (post the 2026-05-20 handover)

- `dd8ee43` feat(ui): windowed speaker rename in NodeDetail transcript (Part H) — *pushed*
- `4fe154c` fix(stt): reconcile live utterance↔node links after final persist — *pushed*
- `8bd07a4` refactor(ui): retire the old global Speaker section in NodeDetail — *pushed*
- `0976a9e` feat(ui): private-beta gate when the backend is unreachable — **NOT pushed**
- `c0b09d2` fix(audio): skip live-recording autostart on touch devices (#116) — **NOT pushed**
- `4da94b3` feat(ui): show upload status on /new from the start of processing (#115) — **NOT pushed**

**PUSHED:** partial. `main` is **9 ahead of origin** — 3 mine (`0976a9e`,
`c0b09d2`, `4da94b3`) + 6 the parallel session's. Clean fast-forward (0 behind).
Not pushed this session — no fresh push authorization after the speaker-stack
push. Pushing triggers Vercel's frontend auto-deploy.

## Pending Threads — triaged by context-dependency

The user asked: spend session-context on the tasks that *need* it; let a fresh
instance take the rest from the ADRs/docs.

### Context-warm — do these with this session's context

1. **#114 Mobile stats panel — IN PROGRESS.** A curation proposal is on the
   table, awaiting the user's confirm/tweak:
   - *Proposed mobile expanded HUD:* status line + the 3 state chips
     (Backend/STT/Graph) + any "Latest error" — **nothing else**. Hide all dev
     telemetry (timings, latencies, queue waits, ms counters, provider/model,
     segment counts). Desktop keeps the full panel.
   - *Also a real bug:* the detail panel overflows off the **right edge** on
     mobile — it's `absolute left-0` relative to the HUD container, but the HUD
     sits on the right of the footer. Fix the positioning.
   - File: `lct_app/src/components/audio/LiveSessionHud.jsx` (mobile glyph is the
     `sm:hidden` block; `details` is an array of `{title, rows:[{label,value}]}`).
   - Next: user confirms keep-list → build positioning fix + curated mobile view.

2. **Auto-assign 1-speaker→contact.** User's idea: when diarization yields
   exactly one speaker and exactly one participant contact was selected,
   auto-set the speaker name (no manual rename). Now feasible — the reconciler
   gives nodes real `speaker_info`. Context: the participant-picker →
   `known_speakers` flow and the reconciler were traced this session; a fresh
   instance would re-trace. A post-diarization step.

### Blocked

1. **#98 word_timings.** OpenAI `diarized_json` doesn't carry word-level timing;
   `stt_response_parsers.py` only extracts segment-level. Real path = WhisperX
   (word timing native). Multi-step feature, not a quick fix.
2. **#106 IndrasNet retrieval.** `/api/retrieval/search` 500s — host RAM ~91%
   blocks LM Studio loading the embedding model. **Operational (host-side), not
   LCT code.** Fully diagnosed; LCT degrades gracefully.

### Context-cold — safe for a fresh instance (ADR/docs cover them)

1. **#85** auto-promote canvas tier mid-stream — ADR-032, pending.
2. **Remaining ADR-032 parts** — Part B navigation (thread filters + multi-row
   ribbon), Part I calm animations, Part J telemetry strip, Part L `.canvas`
   swim-lane embed, edge-category filter UI. All ADR-documented.
3. **Push + deploy** the 3 unpushed commits (#115/#116/beta-gate) — needs the
   user's go-ahead; Vercel auto-deploys the frontend on push.

### Deferred

- `consumption_trigger.py` + its test — intentionally mothballed, untracked on disk.
- The user is in rapid-fire critique mode ("I'll keep the critiques coming") —
  expect more mobile UX issues.

## Key Context

- **Backend** is freshly restarted on **43181** (detached `Start-Process`, **no
  `--reload`**, current code — has the reconciler + speaker-correction routes).
  43181 is the Tailscale-served port. See memory `lct-backend-windows-startup`.
- **`start_services.ps1` is stale** — wrong module path; would `ModuleNotFoundError`.
  Restart via the repo-root `lct_python_backend.backend:lct_app` invocation.
- **#115/#116 are committed but not verified on mobile** — they need a
  push→Vercel-deploy round-trip; the user verifies on their phone after.
- **The parallel session is very active** (segment-and-stitch pause/resume,
  guest speakers, elapsed timer) — its commits are interleaved on `main`; never
  `git add -A`, stage explicit paths.
- The backfill reconciled 3 of 14 live conversations (`e845e79c` fixed); 9 old
  ones lack `source_excerpt`/timestamps and can't be linked. Run
  `scripts/backfill_live_utterance_links.py --apply` for the live backlog.
- Standing hazards (memories): `persist_graph` is destructive;
  `external_llm_ok` privacy gate; Vite/Tailscale binding.

## Learnings Captured

- [x] Memory `lct-backend-windows-startup` — how to restart the backend cleanly;
  zombie backends come from `run_in_background` launches; `start_services.ps1` stale.
- [x] Memory `user-prefers-context-triaged-handovers` — triage task lists by
  context-dependency, not a flat dump.

## Running Processes

- **LCT backend** — detached `cmd`/uvicorn on **43181** (started this session,
  no `--reload`). Log: `.run/backend.log`. Health: `GET /api/import/health`.
- **Vite dev server** — port 43173 (the user's local dev frontend).
- Phantom zombie sockets on 43180/82/83 — dead processes, kernel-reclaimed; ignore.

## Resume Instructions

1. **#114** — get the user's confirm on the mobile HUD keep-list (status line +
   3 chips + errors), then build it in `LiveSessionHud.jsx` (curated mobile view
   + fix the right-edge overflow).
2. Offer to **push** when the user's ready — 9 commits, clean fast-forward;
   Vercel auto-deploys the frontend.
3. Expect more mobile critiques from the user — triage into the task list.

---
*Handover by Claude Opus 4.7 (1M context) — user-requested wrap-up.*

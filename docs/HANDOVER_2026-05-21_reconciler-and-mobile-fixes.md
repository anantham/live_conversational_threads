# Handover: 2026-05-21 — live link reconciler, Speaker-section retirement, mobile fixes, deploy

> File: `docs/HANDOVER_2026-05-21_reconciler-and-mobile-fixes.md`
> Continues the long ADR-032 session. Earlier arcs:
> `docs/HANDOVER_2026-05-20_adr032-speaker-rename.md` (Part H + reconciler design).
> The parallel session's work is in
> `docs/HANDOVER_2026-05-20_participant-picker-pause-resume.md`.
> **Updated 2026-05-21 (end of session)** — supersedes the mid-session snapshot
> that was committed as `e3e036b`.

## Session Summary

Closed the speaker thread end-to-end: built the **live utterance↔node
reconciler** (`4fe154c`) that fixed the root cause of the "SPEAKER_00 not found"
rename bug on live recordings, **retired** the redundant/buggy NodeDetail global
Speaker section (`8bd07a4`), shipped the **Part H** transcript-inline rename UI
(`dd8ee43`). Added a **private-beta gate** (`0976a9e`) and shipped all three
mobile critiques — **autostart** (`c0b09d2`, #116), **upload status** (`4da94b3`,
#115), and the **mobile-curated stats panel** (`055736a`, #114). **All 8 commits
are pushed**; pushing triggered Vercel's frontend auto-deploy.

The session's final open thread is a **"blocked by CORS policy" error on the
deployed `threads.adityaarpitha.com`** — diagnosed but not resolved. See Pending
Threads #1.

## Commits This Session — all pushed

- `dd8ee43` feat(ui): windowed speaker rename in NodeDetail transcript (ADR-032 Part H)
- `4fe154c` fix(stt): reconcile live utterance↔node links after final persist
- `8bd07a4` refactor(ui): retire the old global Speaker section in NodeDetail
- `0976a9e` feat(ui): private-beta gate when the backend is unreachable
- `c0b09d2` fix(audio): skip live-recording autostart on touch devices (#116)
- `4da94b3` feat(ui): show upload status on /new from the start of processing (#115)
- `e3e036b` docs(handover): 2026-05-21 reconciler + mobile fixes session (mid-session snapshot)
- `055736a` feat(ui): mobile-curated stats panel — fix overflow + trim content (#114)

**PUSHED: yes — all 8.** `main` is level with `origin/main` (0 ahead, 0 behind).
The parallel session's commits (`b9d5d59` graph round-trip, `d3602ec` elapsed
timer, `21f8de0` guest speakers, `aeb41da`/`865d2c6` segment-and-stitch, etc.)
are interleaved on `main` — see *their* handover doc; not covered here.

## Pending Threads — triaged by context-dependency

### Context-warm — do these with this session's context

1. **CORS error on `threads.adityaarpitha.com` — TOP PRIORITY, diagnosed not fixed.**
   - The user reported the deployed Vercel frontend is "blocked by CORS policy."
   - **Ruled out — the backend CORS allow-list is correct.** `.env` has
     `CORS_ALLOW_ORIGINS=https://threads.adityaarpitha.com,...` plus
     `CORS_ALLOW_ORIGIN_REGEX=https://.*\.vercel\.app`; the running backend's log
     confirmed `threads.adityaarpitha.com` was in the resolved allow-list. Do
     **not** re-investigate the allow-list.
   - **Most likely cause (found while writing this handover): the backend on
     port 43181 is DOWN.** Verified — nothing listening on 43181; only stale
     zombie sockets on 43180/82/83. The Vercel frontend calls the backend over
     the Tailscale URL; with the backend down, Tailscale Serve returns 502, and a
     502 carries no `Access-Control-Allow-Origin` header — so the browser
     surfaces it as a CORS error. This matches the symptom exactly.
   - **Next:** restart the backend on 43181 (memory `lct-backend-windows-startup`),
     reload `threads.adityaarpitha.com`. If the error clears — done. If it
     persists with the backend up: get the user's **exact console error line**
     (distinguishes "No 'Access-Control-Allow-Origin' header" from a network
     failure) and confirm Tailscale Serve routes
     `asus-strix-scar.tail4741ad.ts.net` → backend :43181.

2. **Auto-assign 1-speaker→contact.** User's idea: when diarization yields
   exactly one speaker and exactly one participant contact was selected,
   auto-set the speaker name (no manual rename). Design confirmed: exactly 1
   speaker + exactly 1 contact → set `utterance.speaker_name`,
   `speaker_source="participant_inferred"`. Feasible now — the reconciler gives
   nodes real `speaker_info`. A post-diarization step; the participant-picker →
   `known_speakers` flow was traced this session.

### Blocked

1. **#98 word_timings.** OpenAI `diarized_json` carries no word-level timing;
   `stt_response_parsers.py` extracts segment-level only. Real path = WhisperX
   (word timing native). Multi-step feature, not a quick fix.
2. **#106 IndrasNet retrieval.** `/api/retrieval/search` 500s — host RAM
   pressure blocks LM Studio loading the embedding model. Operational
   (host-side), not LCT code. LCT degrades gracefully.

### Context-cold — safe for a fresh instance (ADR/docs cover them)

1. **#85** auto-promote canvas tier mid-stream — ADR-032, pending.
2. **Remaining ADR-032 parts** — Part B navigation (thread filters + multi-row
   ribbon), Part I calm animations, Part J telemetry strip, Part L `.canvas`
   swim-lane embed, edge-category filter UI. All ADR-documented.

### Deferred

- `consumption_trigger.py` + its test — intentionally mothballed, untracked on disk.
- The user is in rapid-fire mobile-critique mode — expect more UX issues.

## Key Context

- **The backend is DOWN.** Port 43181 has no listener (verified end of session).
  Restart per memory `lct-backend-windows-startup`: from the repo root,
  `uvicorn lct_python_backend.backend:lct_app --host 0.0.0.0 --port 43181`,
  launched as a *detached* `Start-Process`, **no `--reload`**. `start_services.ps1`
  is stale (wrong module path — would `ModuleNotFoundError`).
- **The CORS config is correct** — the "blocked by CORS policy" error is a
  *masked* backend-down failure, not a missing-origin problem.
- **The parallel session is very active** — its commits interleave on `main`;
  never `git add -A`, always stage explicit paths.
- **Untracked scratch on disk** (intentional — not deliverables, leave them):
  validation screenshots (`*.png`), `scripts/` investigation scripts
  (`replay_772ac0cc.py`, `critique_772.py`, `inspect_772.py`, etc.),
  `.tmp_validation/`, and `consumption_trigger.py` + its test (mothballed).
- The backfill reconciled the live conversations that carry `source_excerpt` +
  timestamps; ~9 old pre-ADR-032 conversations can't be linked (no match key) —
  documented limitation, not a bug. Run
  `scripts/backfill_live_utterance_links.py --apply` for the live backlog.
- Standing hazards (memories): `persist_graph` is destructive; the
  `external_llm_ok` privacy gate; Vite must bind `0.0.0.0` for Tailscale Serve.

## Learnings Captured

- [x] Memory `lct-backend-windows-startup` — clean backend restart; zombie
  backends come from `run_in_background` launches; **added**: a down 43181
  backend surfaces as a "CORS policy" error on the deployed frontend.
- [x] Memory `user-prefers-context-triaged-handovers` — triage task lists by
  context-dependency, not a flat dump.
- [x] Memory `shared-ai-services-registry` — the canonical machine-wide AI
  services registry; consult before STT/LLM/service-path/GPU work.

## Running Processes

- **LCT backend — NOT running.** Port 43181 has no listener. Stale zombie
  sockets linger on 43180/43182/43183 (dead processes, kernel-reclaimed — ignore).
- **Vite dev server** — port 43173 (the user's local dev frontend, if still up).

## Resume Instructions

1. **Restart the backend on 43181** — memory `lct-backend-windows-startup` has
   the exact invocation. This is the first move; it almost certainly clears the
   CORS error.
2. **Reload `threads.adityaarpitha.com`** — confirm the CORS error is gone.
3. If CORS persists with the backend up: get the user's exact browser console
   error text, and verify Tailscale Serve routes
   `asus-strix-scar.tail4741ad.ts.net` → backend :43181.
4. Then: **auto-assign 1-speaker→contact** (context-warm).
5. Expect more mobile critiques from the user — triage into the task list.

---
*Handover by Claude Opus 4.7 (1M context) — end-of-session; supersedes the
mid-session snapshot in `e3e036b`.*

# Handover: 2026-05-20 — ADR-032 implementation + windowed speaker rename

> File: `docs/HANDOVER_2026-05-20_adr032-speaker-rename.md`
> Note: `docs/HANDOVER.md` is a legacy *stacked* handover file (the skill's
> documented anti-pattern). Per the handover skill, new handovers are dated
> files. Find the latest with `ls docs/HANDOVER_*.md | sort -r | head -1`.

## Session Summary

Implemented the bulk of **ADR-032** (temporal swim-lane graph layout,
semantic edge enrichment, node timestamps/excerpts, full-state JSON export)
across backend + frontend, validated end-to-end on a 15-min imported
conversation, then built **ADR-032 Part H v1 — windowed speaker correction**.
The speaker-correction backend endpoint + 7 pytest cases are now committed
(`2bd27f4`); the frontend transcript inline-rename UI is the immediate next
step. ~22 commits on `main` this session, none pushed.

## Commits This Session (all on `main`, NOT pushed)

This turn:
- `2bd27f4` feat(api): windowed speaker-correction endpoint + tests (ADR-032 Part H)

ADR-032 arc earlier this session (`7fa2646` → `3288754`, ~21 commits):
schema foundation (`deba5f8`), edge-enrichment pipeline (`0024f80`), live-STT
enrichment wire (`d05027c`), swim-lane + edge styling (`bb7f544`), Tier-1 UX /
argument trace / Cmd+K search (`8deaf85`), end-to-end validation bug fixes
(`e3b85a2`, `f76e9c1`), full-state JSON export (`3288754`), plus graph UX
(`f761f8d`, `5d801e8`, `c82c5d8`, `cba5457`, `35d8192`, `2d425bf`) and ADR/docs
(`353dbe4`, `b4c33d1`, `fd46415`, `cc988e2`).

**PUSHED: no.** `main` is **35 commits ahead of origin** (mix of this session
and the parallel session below). Do NOT push without explicit user authorization.

### Parallel session — NOT this session's work
A second Claude session (transcript `5bb90899…jsonl`) ran concurrently on this
repo doing mobile/Vercel/contacts work. Its commits — `cf35e80` (Vercel SPA
rewrite), `1d6cdaf` + `89110b7` (contacts caching/timeout), `213652f` (mobile
footer) — are theirs. Attribute accordingly; stage files explicitly.

## Pending Threads

### Continue Immediately
1. **Speaker rename — frontend (#108).** Backend is DONE + committed (`2bd27f4`,
   7 tests pass). Remaining: a clickable speaker label in `NodeDetail.jsx`'s
   "Raw Transcript" section that calls
   `POST /api/conversations/{id}/speaker-correction` with body
   `{utterance_id, new_speaker, time_window_seconds, source:"node_detail_panel"}`.
   The user wants the time window (default 300s) configurable in Settings —
   add that too. Endpoint contract: `window<=0` = whole conversation;
   `window>0` = `±window s` around the corrected utterance's timestamp,
   matching `speaker_id`.

### Blocked
1. **#98 word_timings.** OpenAI's `diarized_json` does NOT return word-level
   timing even with `timestamp_granularities[]=word` — `Utterance.word_timings`
   stays empty. Need to inspect a raw diarization response to find the word
   data, or conclude the format can't carry it and switch approach (the user
   asked for Descript-style audio↔transcript word sync).
2. **#106 IndrasNet `/api/retrieval/search` 10s timeout.** Edge enrichment
   degrades gracefully (proceeds with no context) but the retrieval context is
   never actually used. Investigate the IndrasNet side.

### Deferred
1. **#85** auto-promote canvas tier when consolidation adds a level mid-stream.
2. **Remaining ADR-032 parts:** multi-row TimelineRibbon, 5 thread-filter
   patterns, edge-category filter UI, WordSyncedTranscript (Descript-style),
   streaming animation budgets, telemetry dev-UI strip.
3. **`consumption_trigger.py` stays mothballed.** `lct_python_backend/services/
   consumption_trigger.py` + `tests/unit/test_consumption_trigger.py` —
   implicit-detection LLM gate, 41 tests pass — were *intentionally* left
   uncommitted across multiple sessions (team picked explicit-verbal-trigger as
   the MVP; see the 2026-05-18 handover in `docs/HANDOVER.md`). NOT committed
   this session, by design. Revive only if the implicit path becomes interesting.

## Key Context

- **Two parallel Claude sessions share this repo.** Never `git add -A` —
  stage files explicitly and verify `git diff --cached --name-only` before
  committing (memory: `parallel-agent-git-contention`).
- **`persist_graph` is DESTRUCTIVE** — deletes all Node + Relationship rows
  before re-insert. Never test it against real conversations
  (memory: `persist-graph-is-destructive`).
- **Validation conversation:** `5953fd1b-2597-408c-916d-f553f8da57f2`.
- **Backend port mess:** SIX listeners are up — `43173` (Vite) and
  `43180`/`43181`/`43182`/`43183`/`43184` (uvicorn). `.backend-port` = **43181**
  (PID 38784). The extras are zombie uvicorn instances from repeated port
  rotation (`--reload` is unreliable on this Windows box). Recommend killing
  the stale ones and restarting clean on one port.
- **`external_llm_ok` privacy gate** — filter retrieval items before sending
  contact data to remote LLMs (memory: `indrasnet-external-llm-ok-privacy-gate`).
- **OpenAI key** in `lct_python_backend/.env` line 22 — flagged for user-side
  rotation; exposure is local-only. Don't commit `.env`.
- **Untracked debug artifacts left on disk by design** (not committed):
  `scripts/{replay_772ac0cc,critique_772,inspect_772,dump_llm_inputs_772,
  ab_test_prompts,enrich_conversation,probe_openai_known_speakers}.py`,
  `scripts/critique_772/`, `*.png` screenshots in repo root, `.tmp_validation/`.

## Learnings Captured
- [x] No new memory files needed — relevant entries already exist
  (`parallel-agent-git-contention`, `persist-graph-is-destructive`,
  `windows-cp1252-utf8-bug-class`, `user-prefers-design-discussion-before-implementation`).
- [ ] Process note: `docs/HANDOVER.md` is a stacked single-file (skill
  anti-pattern). This handover is a dated file; future ones should be too.
  Consider migrating `HANDOVER.md` to a thin reverse-chronological index.

## Running Processes
- **uvicorn backends** — PIDs 6028/38784/62984/58024/3804 on ports
  43180–43184. `.backend-port` = 43181. Most are zombies; verify which is live.
- **Vite dev server** — PID 56344 on port 43173.
- Many `node.exe` processes (Vite workers + parallel-session Playwright).

## Resume Instructions
1. `git status` — working tree should show only untracked debug artifacts
   (the `2bd27f4` commit captured the speaker-correction work).
2. Pick a backend port — `.backend-port` = 43181 (PID 38784). Verify it's alive
   (hit the conversation list / `/health`). Optionally kill zombies on
   43180/43182/43183/43184 and restart clean.
3. Build the speaker-rename frontend: clickable speaker label in
   `NodeDetail.jsx` Raw Transcript → `POST .../speaker-correction`.
4. Add a Settings control for the correction time window (default 300s).

---
*Handover by Claude Opus 4.7 (1M context) — post-compaction, user requested explicit /handover.*

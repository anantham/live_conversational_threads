# Handover: 2026-05-25 — consumption auto-detect wired, ADR-033, staleness audit

> File: `docs/HANDOVER_2026-05-25_auto-detect-and-staleness-audit.md`

## Session Summary

Audited the 2026-05-18 handover entry against current code (it was substantially stale — 3 items done, 2 superseded, 2 still pending). Then closed the 2 actually-pending items: wired the agenda-query detector into the live STT finalized-segment path (task #17) and authored ADR-033 documenting the two-trigger consumption-prayer architecture (task #9). Also closed the ADR-033 known-limitation #3 by resolving the fallback `_consumption_contact_ref` from the conversation's participants. Four commits landed on `origin/main`.

## Commits This Session (all pushed to origin/main)

- `6c974b3` feat(consumption): auto-detect agenda-query runner + WS wiring (#17) — 7 files, +662 LOC
- `a85439e` docs(adr): ADR-033 consumption prayer matching (#9) — +82 LOC
- `61684a3` docs(handover): refresh 2026-05-18 staleness audit — ±3 LOC
- `9e348dd` feat(consumption): resolve fallback contact_ref from conversation participants — +65 LOC

**PUSHED: yes** (`origin/main` is at `9e348dd`).

## Pending Threads

### Continue Immediately

None — clean stopping point. All in-flight work is committed and pushed.

### Blocked (Waiting on User)

1. **Browser-verify the auto-detect path** — needs `AGENDA_QUERY_DETECTOR_ENABLED=true` in the LCT backend env, then a live recording session with a contact in `Conversation.participants`. ADR-033 explicitly flags this as "not yet exercised in a real recording session." Two paths to validate:
   - Name-grounded: speak "what's pending with [contact in your top-50]" — should fire chip with that contact's items.
   - Contact-agnostic: speak "what was pending again" — should fire chip with the conversation's first non-self participant's items.

2. **Browser-verify the manual selection-toolbar path** — pending from the 2026-05-18 handover, never explicitly closed (only the code was verified, not the UX). Steps in LCT `ISSUES.md`: `cd lct_app && npm run dev`, open `/new`, drag-select a sentence, walk through toolbar → contact picker → "Show agenda".

### Deferred (Acknowledged but Parked)

1. **Mothballed `consumption_trigger.py` + tests** — still uncommitted on disk (`lct_python_backend/services/consumption_trigger.py` + `tests/unit/test_consumption_trigger.py`). Implicit-detection LLM gate, 41 tests pass, intentionally not in git because the explicit-verbal-trigger path was picked as MVP. Either commit as `[mothballed]` or delete; current in-between state is the legacy of the May 18 decision. **Decision-pending:** user side.

2. **Original IndrasNet-agent conversation share** — the user mentioned in the May 18 session that they wanted to share another conversation with the IndrasNet agent. Predates this session's arc and was not actioned. Still on the queue if relevant.

3. **Singleton prayer type in the toolbar** — Recommend-consumption is the only active slot; Formalism / SendTo / Remind / Connect are documented placeholders in `TranscriptSelectionToolbar`. Comes back when each one's semantics are designed (ADR-033 known limitation #3 — renumbered from #4).

## Key Context

- **`AGENDA_QUERY_DETECTOR_ENABLED` is the opt-in switch.** Both `agenda_query_detector.is_enabled()` and `consumption_match_runner.should_run()` gate on it; the WS session checks `should_run_consumption_match()` before scheduling the task, so when the flag is off there is zero per-final overhead.
- **The `consumption_match` WS event** is the unified shape for both manual (HTTP response body included) and auto (WS push) paths. Frontend's `handleConsumptionMatch` in `NewConversation.jsx` updates the chip without auto-opening the drawer — auto-fire is chip-only by deliberate UX choice (2026-05-24); manual stays auto-open because it's user-initiated.
- **Per-session dedupe is 30s** keyed on `(phrase, contact_ref)` — refinement passes re-finalize the same utterance under new speaker labels, so without dedupe the chip would refresh redundantly.
- **The fallback `_consumption_contact_ref` is snapshotted at first final**, not live. Mid-recording participant changes won't re-resolve. The toolbar's manual-trigger always supplies its own ref, so this only affects auto.
- **The two memory files written this session** are auto-loaded into future contexts via `MEMORY.md`:
  - `handover-stale-by-week-audit-before-trusting` — audit handover docs older than ~3 days before quoting their pending lists.
  - `pytest-disable-hypothesis-plugin-on-windows` — anaconda env crashes on `_hypothesis_pytestplugin`; always pass `-p no:hypothesispytest`.
- **Untracked files on disk are NOT from this session.** PNGs, ad-hoc `scripts/*.py` files, `consumption_trigger.py`, etc. predate this session. Don't `git add` them blindly.

## Learnings Captured

- [x] Memory: `handover-stale-by-week-audit-before-trusting.md` (feedback) — added to MEMORY.md index.
- [x] Memory: `pytest-disable-hypothesis-plugin-on-windows.md` (project) — added to MEMORY.md index.
- [x] ADR-033 captures the consumption-prayer design (manual + auto paths, contact resolution, privacy gate, alternatives considered, known limitations).
- [x] HANDOVER.md 2026-05-18 entry annotated with a staleness audit block at the top so future readers don't act on outdated pending lists.
- [ ] No skill update needed — `/handover` skill behavior already handled this session well; the staleness pattern was caught by user prompting ("isnt it stale did you check code"), worth noting that a future skill iteration could surface "audit before trusting" as an explicit checklist item for handovers older than N days.

## Running Processes

None started or owned by this session. The pre-existing supervisor/STT/IndrasNet processes documented in the 2026-05-18 entry may or may not still be running — check with `tasklist` if needed for the next action.

## Resume Instructions

1. **If user opts into browser-verify the auto path:** set `AGENDA_QUERY_DETECTOR_ENABLED=true` in `lct_python_backend/.env`, restart the LCT backend, start a `/new` recording with at least one named participant, and speak one of the trigger phrases. Watch for the `consumption_match` WS event in the browser dev-tools network tab and the chip lighting up.
2. **If user opts to commit/delete the mothballed `consumption_trigger.py`:** confirm intent, then either `git add lct_python_backend/services/consumption_trigger.py lct_python_backend/tests/unit/test_consumption_trigger.py && git commit -m "chore: archive mothballed implicit-detection consumption_trigger"` OR `rm` both files.
3. **If user shares the IndrasNet-agent conversation:** read it; scan for design constraints that supersede ADR-033 or the existing wiring; report findings before changing anything.
4. **Otherwise:** clean stopping point — close session safely.

---
*Handover by Claude Opus 4.7 at ~76% context — explicit `/handover` invocation, not auto-triggered.*

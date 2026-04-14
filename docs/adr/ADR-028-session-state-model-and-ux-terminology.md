# ADR-028: Session State Model and UX Terminology for Live Conversations

**Date:** 2026-04-14
**Status:** Approved
**Group:** product + presentation
**Related decisions:** ADR-021 (browser-local draft recovery), ADR-026 (two-phase live flush contract)

---

## Issue

The live conversation UX had drifted into ambiguous language:

- `Resume` was used for restoring a browser-local draft, even though users could
  reasonably read it as "resume the same live recording runtime."
- `Pause` or color-only recording controls were implied in discussion, but the
  actual runtime behavior on `/new` is a full stop/finalize of the active capture
  session.
- The product lacked a clear distinction between:
  - an active recording runtime
  - a stopped but still-editable current session
  - a previously persisted local draft restored after interruption
  - a finalized saved conversation artifact

Without a shared state model, UI copy becomes misleading and future features such
as true pause/resume become harder to introduce cleanly.

---

## Decision

The product will use the following **state model** and **terminology contract**
for live conversation flows.

### Canonical objects

1. **Recording Runtime**
   - microphone capture + websocket STT runtime currently active
2. **Session Draft**
   - the current conversation-in-progress on `/new` after capture has stopped,
     but before explicit final save/discard
3. **Recovered Draft**
   - a browser-local draft restored after reload, navigation, or interruption
4. **Saved Conversation**
   - an intentionally finalized artifact persisted for later review

### Canonical states

1. **Idle**
   - no active runtime
   - no current session draft loaded

2. **Recording**
   - runtime active
   - transcript/graph are live or provisional

3. **Stopped Draft**
   - runtime inactive
   - current session draft remains loaded and editable

4. **Recovered Draft**
   - a previously persisted local draft has been restored into `/new`
   - runtime is not active

5. **Saved**
   - current draft has been intentionally persisted as a saved conversation

### Vocabulary rules

Use these labels consistently:

- **Start Recording**
  only when beginning an active mic/STT runtime
- **Stop Recording**
  only when ending the active runtime
- **Draft available**
  for recoverable local state surfaced outside `/new`
- **Restore Draft**
  for loading a recoverable browser-local draft
- **Session Draft**
  for the current stopped-but-editable conversation in `/new`
- **Save & Exit**
  for finalizing the current draft and leaving
- **Save & Start New**
  for finalizing the current draft and beginning a new recording flow
- **Discard Draft**
  for deleting current unrecovered/recovered draft state
- **Saved Conversation**
  for the finalized persisted artifact

### Reserved terms

The following terms are **reserved** and must not be used unless the runtime
behavior actually exists:

- **Pause**
  only if the same live transport/runtime can be paused and resumed
- **Resume**
  only if the same live recording/session can continue without semantic reset
- **Resume Recording**
  only if the backend restores enough runtime context for a truthful continuation

Current implication:

- The existing Home `/new` recovery action is **Restore Draft**, not **Resume**
- The current active recording control is **Stop Recording**, not **Pause**

---

## Rationale

- Users need language that matches the actual system object they are acting on.
- Browser-local draft recovery and live-session continuation are different
  capabilities and should not share the same verb.
- Reserving `Pause/Resume` keeps room for a future true resumable runtime without
  forcing another terminology rewrite.
- Explicit states make save/discard/restore/start-new flows easier to design,
  test, and document consistently.

---

## Consequences

Positive:

- Home, `/new`, and future saved-session flows can use one consistent mental model.
- The UI no longer implies capabilities the backend does not currently support.
- Future true pause/resume work can be introduced cleanly under reserved terms.

Tradeoffs:

- Some existing copy and components may need renaming to align with this contract.
- "Session Draft" and "Recovered Draft" are slightly more explicit than the
  shorter but ambiguous `Resume`.

Non-goals:

- This ADR does **not** claim that a true resumable runtime already exists.
- This ADR does **not** require the current stopped-session flow to support
  continuation of the same websocket session.

Follow-up work:

1. Rename Home and `/new` recovery affordances from `Resume` to `Restore Draft`.
2. Audit recording controls so active-state copy says `Stop Recording` rather than
   implying pause semantics.
3. If true pause/resume is desired, add a backend/runtime ADR for context hydration
   and safe session continuation before adopting `Pause` / `Resume Recording` in UI.

---

## UI Mapping

### Home

- Badge: **Draft available**
- Primary action: **Restore Draft**

### `/new` while active

- Control: **Start Recording** / **Stop Recording**
- Status: **Recording**

### `/new` after stop

- Tray title: **Session Draft**
- Actions:
  - **Save & Exit**
  - **Save & Start New**
  - **Discard Draft**

### `/new` after local recovery

- Banner title: **Recovered Draft**
- Actions:
  - **Restore Draft**
  - **Discard Draft**
  - optional recovery/save actions

---

## Related Artifacts

- [`lct_app/src/pages/Home.jsx`](../../lct_app/src/pages/Home.jsx)
- [`lct_app/src/pages/NewConversation.jsx`](../../lct_app/src/pages/NewConversation.jsx)
- [`lct_app/src/hooks/useLocalConversationDraft.js`](../../lct_app/src/hooks/useLocalConversationDraft.js)
- [`lct_app/src/services/localDraftStore.js`](../../lct_app/src/services/localDraftStore.js)
- [`lct_app/src/components/AudioInput.jsx`](../../lct_app/src/components/AudioInput.jsx)
- [`docs/adr/ADR-021-browser-local-draft-recovery.md`](./ADR-021-browser-local-draft-recovery.md)
- [`docs/adr/ADR-026-two-phase-live-flush-contract.md`](./ADR-026-two-phase-live-flush-contract.md)

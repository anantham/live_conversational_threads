# ADR-021: Browser-Local Draft Recovery for Interrupted Conversation Sessions

**Date:** 2026-04-03  
**Status:** Approved  
**Group:** presentation + data

## Issue

The app can export conversations and can save conversation JSON through the backend, but it has no
browser-local recovery path. That leaves a user-visible reliability gap:

- anonymous users can lose work on refresh, crash, or temporary backend/network failure;
- auth-backed saved conversations are not implemented yet, so server persistence is not yet a full
  answer for “come back later” behavior;
- `/new` already owns the draft graph/chunk state in the browser, but there is no durable browser
  store for that state.

The team explicitly wants a low-friction safety net before the auth project lands: if the user has
already generated graph/transcript state in the browser, it should not disappear just because the
server path failed or the tab closed.

## Context

- ADR-019 made backend-owned transcript/graph persistence the canonical runtime path, but it did not
  provide browser-local recovery for interrupted sessions.
- Current export options already cover:
  - manual `.canvas` + `.txt` downloads;
  - backend JSON save with server-local fallback when GCS is unavailable.
- Those options are not equivalent to browser-local recovery. The failure mode addressed here is:
  “the browser had meaningful state, but the user could still lose it before or without a trusted
  server save.”
- The `/new` route already centralizes:
  - finalized graph state,
  - draft graph patches,
  - chunk dictionaries,
  - file name and message state.

## Decision

- Persist the latest meaningful local conversation draft in browser IndexedDB.
- Scope the first slice to **latest-draft recovery only**:
  - one latest draft record;
  - no multi-draft picker yet;
  - no raw-audio persistence.
- Restore behavior:
  - when `/new` opens and a latest local draft exists, show an explicit `Resume / Discard` prompt;
  - restoring hydrates graph/chunk/name/message state only;
  - live recording/upload transports do **not** auto-resume.
- Security/privacy constraints:
  - never persist BYOK raw keys, BYOK session tokens, auth tokens, or websocket state in browser
    storage;
  - keep this slice frontend-only so it can ship independently of the backend auth rollout.

## Consequences

- Anonymous and signed-out users get a meaningful “not lost” safety net before account auth ships.
- Browser-local draft recovery complements, rather than replaces, backend save/export paths.
- Restored drafts are session state only; they can be resumed, inspected, or exported, but they do
  not imply resumable microphone capture or resumable backend upload jobs.
- The home screen can surface a lightweight “resume available” affordance without forcing a more
  complex draft library UX.
- Because this slice stores only the latest draft, starting many separate local-only sessions will
  overwrite older interrupted work until a later ADR expands this into multi-draft persistence.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Latest-draft IndexedDB recovery only (chosen) | Fastest reliability win, frontend-only, low UX complexity | Only one recoverable draft, no raw audio |
| B | Multi-draft IndexedDB recovery with picker | Better long-term local UX | More UI/state complexity before auth lands |
| C | Persist raw audio blobs and try to resume recording/upload | Maximum recovery ambition | High quota risk, more corruption modes, misleading “resume recording” semantics |

## Notes

- Related ADRs: ADR-019, ADR-020.
- Follow-up ADR candidate: authenticated saved conversations with owner-scoped server persistence.

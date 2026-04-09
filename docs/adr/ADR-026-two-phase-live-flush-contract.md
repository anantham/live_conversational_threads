# ADR-026: Two-Phase Live Flush Contract for `/ws/transcripts`

- Status: Approved
- Date: 2026-04-09
- Group: integration / websocket protocol

## Context

The `/ws/transcripts` websocket powers the browser live transcription experience. For backend-websocket STT providers such as orchestrated Whisper, important transcript events can arrive during post-flush work after the client sends `final_flush`.

Previously, the backend sent `flush_ack` immediately when flush processing started, and the frontend treated `flush_ack` as permission to close the socket. That created a semantic mismatch:

- `flush_ack` really meant "flush accepted"
- the frontend interpreted it as "all transcript events are finished"

This was acceptable for simpler flows, but it is incorrect for backend-websocket Whisper because late `transcript_final` events can be generated during flush processing.

## Decision

The websocket contract will use two explicit flush messages:

- `flush_ack`: the server accepted the flush request
- `flush_complete`: the server finished post-flush transcript delivery and no more transcript events should be expected for the session

Clients must wait for `flush_complete` before closing the live transcription websocket.

## Positions Considered

### 1. Redefine `flush_ack` to mean completion

Rejected.

This would overload an existing message and make it harder to preserve the fast acknowledgment behavior already used by the UI.

### 2. Add explicit `flush_complete`

Accepted.

This keeps the protocol unambiguous and preserves fast acceptance signaling.

### 3. Use a client-side timeout/idle heuristic after `flush_ack`

Rejected.

That would be brittle under latency variation and would keep the contract implicit.

## Rationale

- The protocol should say what it means.
- Backend-websocket STT can produce transcript events after flush acceptance but before completion.
- An explicit completion message is clearer than timing guesses and safer than closing on `flush_ack`.

## Consequences

### Positive

- End-of-session transcript delivery is no longer truncated just because the client closed early.
- The frontend and backend have a clearer contract for live websocket shutdown.
- Fast `flush_ack` remains available for telemetry and responsiveness.

### Negative

- Clients must understand one more websocket message type.
- Existing tests and any external clients need to align with the two-phase contract.

## Implementation Notes

- Backend:
  - `lct_python_backend/services/stt_ws_session.py`
- Frontend:
  - `lct_app/src/components/audio/audioMessages.js`
  - `lct_app/src/components/audio/useTranscriptSockets.js`
- Tests:
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`

## Follow-ups

- Investigate the newly exposed post-flush `badly formed hexadecimal UUID string` failure in Whisper end-to-end runs.
- Decide whether `flush_complete` should mean "no more transcript events" only, or "all graph processing complete" as well. The current implementation scopes it to transcript/post-flush delivery completion.

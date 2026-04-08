# ADR-023: Orchestrated Live Whisper Websocket and Async Diarization

**Date:** 2026-04-08  
**Status:** Approved  
**Group:** integration + observability

## Issue

The verified Whisper route for live STT currently points at the IndrasNet orchestrator on `http://100.81.65.74:7777/api/transcribe`, but the live path still behaved like chunked HTTP transcription:

1. perceived latency was dominated by per-request orchestration and non-streaming behavior;
2. live diarization requirements kept the fast caption lane coupled to the slow path;
3. bypassing the orchestrator would improve latency but would let multiple GPU consumers fight over the single RTX 3080.

We need a lower-latency live path that preserves coordinator ownership of the shared GPU while letting text appear first and speaker attribution arrive later.

## Context

- ADR-012 already chose late-binding speaker attribution as the desired shape.
- ADR-014 and ADR-017 established stage-based routing and a capability-oriented live runtime, but the Whisper branch was still using HTTP chunk uploads as its effective live contract.
- The remote Windows/Tailscale host has an active IndrasNet orchestrator and a separate WhisperX streaming server. The orchestrator must remain the first-class control plane because the GPU is shared across workloads.
- The user approved a text-first architecture where live captions must not wait on diarization.
- Existing browser behavior through `/ws/transcripts` should remain stable; the browser should not need to know about remote Whisper websocket details.

## Decision

Adopt an **orchestrated backend-websocket live Whisper path** for fast captions and move Whisper diarization to a **non-blocking post-flush refinement lane**.

### Chosen runtime shape

1. Keep the browser contract unchanged: browser audio still goes to backend `/ws/transcripts`.
2. When the selected Whisper candidate exposes a websocket endpoint, LCT upgrades from backend HTTP chunking to a backend websocket runtime.
3. The orchestrator exposes `/api/transcribe/stream`, acquires a `CRITICAL` WhisperX coordinator slot, and proxies frames to the underlying WhisperX `/v1/audio/stream` server.
4. The live websocket lane is text-first and does not block on diarization.
5. When live diarization is required for this Whisper path, LCT retains audio, finalizes it after flush, and runs a background refinement pass from the finalized WAV file.
6. HTTP fallback remains in place if the websocket runtime cannot start.

### Explicit non-goals in this slice

- No hard-kill preemption of already-running WhisperX work.
- No browser-direct connection to the remote WhisperX server.
- No overlap/dedupe rewrite in the live caption lane yet; v1 relies on the upstream streaming server contract and post-flush refinement.

## Positions considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep HTTP chunking and only patch orchestrator bugs | Minimal code movement | Preserves latency ceiling and per-request orchestration overhead |
| B | Orchestrated websocket live captions with async diarization (chosen) | Best latency while preserving GPU coordination and browser contract | Still depends on cooperative preemption; requires stored audio for refinement |
| C | Bypass orchestrator and talk directly to WhisperX | Simplest low-latency transport | Sacrifices centralized GPU arbitration |
| D | Hard-preempt in-flight WhisperX work for `CRITICAL` live requests | Best tail responsiveness | Highest operational risk; not implemented in this slice |

## Consequences

### Positive

- Live Whisper sessions now have a first-class backend streaming lane.
- Text appears on the latency-sensitive path without waiting for speaker labels.
- The orchestrator remains the owner of GPU admission, so LCT does not become a rogue consumer.
- The browser/backend contract stays stable while backend internals become more capability-oriented.

### Tradeoffs

- Async diarization now depends on persisted audio for this path.
- Speaker labels lag behind live text by design.
- `CRITICAL` admission still cannot forcibly stop an already-running non-cooperative WhisperX job; startup delay can still occur when the GPU is monopolized.
- The backend session orchestration remains too monolithic and needs continued decomposition.

## Assumptions

1. Fast readable live text is more important than immediate speaker labels.
2. Retaining finalized session audio is acceptable when live diarization is required.
3. The orchestrator-owned websocket route is safer operationally than direct browser access to remote WhisperX.
4. The current WhisperX streaming server is stable enough to serve as the first backend websocket adapter.

## Constraints

1. `/ws/transcripts` remains the only browser-facing live STT entrypoint.
2. The shared RTX 3080 must remain coordinator-governed.
3. Fallback behavior must stay loud and descriptive; silent degradation is not acceptable.
4. This slice must remain reversible back to HTTP fallback if the websocket runtime fails.

## Follow-up implications

1. If in-flight background WhisperX work still delays session start too much, the next decision is stronger cooperative chunking or reserved live capacity, not more client-side chunk tuning.
2. If a second backend streaming provider lands, split `stt_backend_realtime.py` into transport and event-normalization modules.
3. If overlap is introduced later, add explicit dedupe/revision semantics rather than concatenating overlapped text blindly.

## Related

- `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md`
- `docs/adr/ADR-014-stage-based-runtime-settings-and-explicit-live-fallback-order.md`
- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md`
- `lct_python_backend/services/stt_live_provider_selection.py`
- `lct_python_backend/services/stt_live_runtime.py`
- `lct_python_backend/services/stt_ws_session.py`

# ADR-010: Real-Time Speaker Diarization Sidecar for Local Speech-to-Graph

**Date:** 2026-02-10  
**Status:** Proposed  
**Group:** integration

## Issue

The current local STT pipeline streams partial/final text into `/ws/transcripts`, but speaker attribution is static (`speaker_1`) and does not reflect real-time multi-speaker conversations. We need low-latency diarization that:

1. Runs local-first on Apple Silicon.
2. Preserves existing ASR responsiveness.
3. Avoids tight coupling between transcript generation and speaker attribution.
4. Remains reversible (feature can be disabled without breaking transcript flow).

## Context

- Existing text ingest path is append-only (`transcript_events`) and optimized for low-latency graph updates.
- Streaming diarization output is delayed relative to ASR text and may revise speaker identity as context accumulates.
- Apple Silicon is the default runtime target; CUDA-only solutions are not a safe default.
- Model/license constraints matter for local distribution and commercial use.

## Decision

Adopt a **dual-stream late-binding architecture** where diarization runs as a parallel sidecar and enriches ASR transcript events after timestamp-based reconciliation.

### Chosen architecture

1. Keep current ASR websocket path as transcript source of truth.
2. Add a diarization sidecar pipeline that consumes the same microphone stream in parallel.
3. Reconcile streams in a bounded alignment buffer using timestamp overlap.
4. Emit speaker updates keyed by stable `event_id` with versioned corrections.
5. Use server-side monotonic timing as canonical clock basis for reconciliation and latency metrics.

### Default stack by phase

- **Phase 1 (MVP):** Diart stock streaming on CPU with pyannote segmentation/embedding.
- **Phase 2 (Hardening):** Replace heavy embedding path with Silero VAD + WeSpeaker ECAPA-TDNN ONNX (CoreML EP where available), keep incremental clustering contract stable.
- **Phase 3 (Polish):** Speaker persistence across sessions, adaptive windowing, bounded post-correction signals.

### Event contract additions

Transcript events and/or derived utterance payloads include:

- `event_id`
- `speaker_id`
- `speaker_confidence`
- `speaker_change`
- `diarization_version`
- optional `speaker_segment` (`start_ms`, `end_ms`, `is_overlap`)

Additional control events:

- `speaker_merge` (old id -> new id mapping)
- `diarization_reset` (sidecar restart; speaker IDs renumbered)

### Buffering and correction policy

- Use a 2-second reconciliation window for assigning speaker labels to recent ASR text.
- Allow bounded retroactive correction within that window only.
- After window closure, speaker assignment is final for that event revision.

## Positions considered

1. **Diart + pyannote (CPU default):** best integration speed and low implementation risk.
2. **Custom ONNX streaming stack (Silero + WeSpeaker + incremental clustering):** best Apple Silicon performance control, higher integration effort.
3. **NVIDIA Sortformer v2:** strongest speed/accuracy on CUDA, not local-default compatible with Apple Silicon.
4. **Offline/batch stacks (WhisperX/SpeechBrain offline recipes):** unsuitable for live graph updates due to latency.
5. **Research EEND variants:** promising but not production-ready for this codebase and deployment profile.

## Consequences

### Positive

- Preserves transcript responsiveness by decoupling diarization from ASR.
- Enables gradual rollout under feature flag with minimal regression risk.
- Keeps vendor lock-in low and allows hardware-adaptive backends.
- Provides explicit correction semantics for UI consistency.

### Tradeoffs

- Added system complexity (sidecar process + alignment layer).
- Streaming DER/WDER is expected to be worse than offline upper bounds.
- Early-session speaker labels may be unstable before clustering warms up.

## Assumptions

1. ASR keeps delivering word/segment timestamps suitable for overlap matching.
2. Typical sessions are 1-4 active speakers.
3. Local CPU budget is sufficient for sidecar at configured step/window.
4. Frontend can render speculative-to-stable speaker state transitions.

## Constraints

1. Local-first operation on Apple Silicon is the default.
2. No hard runtime dependency on CUDA or cloud diarization APIs.
3. Licensing must remain compatible with project distribution model.
4. Existing `/ws/transcripts` flow must remain backward compatible when diarization is disabled.

## Validation

Primary success criteria:

- DER (no collar, overlap scored): MVP <= 25%, target <= 20%.
- WDER: target <= 10-12% on in-domain meetings.
- Speaker switch latency (P95): MVP <= 3s, target <= 2s.
- End-to-end speaker assignment latency (P95): MVP <= 4s, target <= 2.5s.
- RTF: < 0.5 MVP, < 0.3 target.

Validation protocol:

1. Offline reference run against fixed corpus.
2. Streaming replay simulation with identical corpus.
3. On-device load and thermal profile validation on Apple Silicon hardware tiers.

## Risks and mitigations

1. **CPU budget miss on M1-class devices:** increase step size, reduce model load, or temporarily run dominant-speaker mode.
2. **Label jitter/flicker:** bounded correction window + confidence gating + warm-up indicator.
3. **Overlap attribution errors:** mark overlap regions explicitly and lower confidence.
4. **Model/license drift:** pin model versions and maintain a third-party attribution inventory.

## Confidence and fallback

- **Confidence:** 0.78 overall (high on architecture pattern, medium on first-pass tuning).
- **Fallback:** if latency or stability targets miss, keep diarization degraded (`speaker_id=null` or dominant-speaker only) while preserving transcript path and feature-flag rollback.

## Related

- `docs/adr/ADR-008-local-stt-transcripts.md`
- `docs/adr/ADR-009-local-llm-defaults.md`
- `LOCAL_STT_SERVICES.md`
- `lct_python_backend/stt_api.py`
- `lct_python_backend/services/stt_session.py`
- `lct_python_backend/services/transcript_processing.py`

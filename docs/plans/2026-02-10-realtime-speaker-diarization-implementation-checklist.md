# Real-Time Speaker Diarization Implementation Checklist (File-by-File)

**Date:** 2026-02-10  
**Status:** Draft (ready for implementation)  
**ADR:** `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md`

## Scope

Implement real-time speaker diarization as a **parallel sidecar** to the existing `/ws/transcripts` ASR flow, with bounded late-binding reconciliation and reversible rollout.

## Assumptions

1. Transcript ASR remains the source of truth for text content and event ordering.
2. Apple Silicon local runtime is the default deployment target.
3. Speaker attribution can lag text by up to the reconciliation window without breaking UX.

## Predicted outcomes

1. MVP can ship with diarization behind a feature flag in 2-3 sprints.
2. End-to-end speaker assignment latency (P95) should remain below 4s in MVP.
3. Phase 2 ONNX hardening should reduce CPU load and improve RTF on M-series devices.

## Phase 1: MVP (Diart sidecar + late binding)

### Backend files

- [ ] `lct_python_backend/stt_api.py`
  - Wire diarization sidecar lifecycle into websocket session start/stop.
  - Emit speaker update events keyed by transcript `event_id`.
  - Enforce canonical server clock basis for reconciliation timestamps.
- [ ] `lct_python_backend/services/stt_session.py`
  - Persist transcript event IDs and metadata needed for diarization revisions.
  - Add helper for bounded retroactive speaker corrections (`diarization_version` increments).
- [ ] `lct_python_backend/services/stt_config.py`
  - Add diarization settings defaults (`enabled`, window/step sizes, reconciliation window, timeout).
  - Keep safe fallback when diarization is disabled.
- [ ] `lct_python_backend/services/conversation_reader.py`
  - Extend utterance serialization payload with diarization fields used by timeline/UI (`speaker_confidence`, overlap flags, version if persisted).
- [ ] `lct_python_backend/conversations_api.py`
  - Ensure `/api/conversations/{id}/utterances` returns new speaker metadata fields.

### New backend modules (add)

- [ ] `lct_python_backend/services/diarization/__init__.py`
- [ ] `lct_python_backend/services/diarization/types.py`
  - Shared DTOs for diarization segments, speaker updates, merge/reset events.
- [ ] `lct_python_backend/services/diarization/diart_engine.py`
  - Diart adapter (CPU mode) with start/stop and streaming segment callbacks.
- [ ] `lct_python_backend/services/diarization/alignment_buffer.py`
  - 2-second reconciliation window; timestamp overlap assignment logic.
- [ ] `lct_python_backend/services/diarization/sidecar.py`
  - Session-scoped orchestrator connecting engine output to alignment buffer.

### Frontend files

- [ ] `lct_app/src/components/audio/audioMessages.js`
  - Parse speaker update events and apply idempotent updates by `event_id` + `diarization_version`.
- [ ] `lct_app/src/components/AudioInput.jsx`
  - Pass diarization config/session metadata on websocket setup.
  - Handle degraded mode cleanly when diarization sidecar times out.
- [ ] `lct_app/src/components/HorizontalTimeline.jsx`
  - Render speculative vs stable speaker state (placeholder style then stable color).
  - Display overlap/uncertain states using confidence thresholds.
- [ ] `lct_app/src/components/Legend.jsx`
  - Add legend entries for speculative speaker state and overlap indicators.
- [ ] `lct_app/src/components/SttSettingsPanel.jsx`
  - Add diarization toggles/parameters (enabled, reconciliation window, engine mode).
- [ ] `lct_app/src/services/sttSettingsApi.js`
  - Support any new diarization settings keys in GET/PUT flow.

### Tests (Phase 1)

- [ ] `lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - Add websocket integration tests for speaker update emission and bounded correction window behavior.
- [ ] `lct_python_backend/tests/unit/test_stt_api_settings.py`
  - Add coverage for diarization settings defaults/validation and telemetry shape additions.
- [ ] `lct_python_backend/tests/unit/test_stt_config.py`
  - Validate diarization config merge behavior (env defaults + DB overrides).
- [ ] `lct_python_backend/tests/unit/test_diarization.py`
  - Add/update invariants around speaker stability and participant count under streaming corrections.
- [ ] `lct_python_backend/tests/unit/test_diarization_alignment.py` (new)
  - Pure unit coverage for overlap assignment + split-when-merged behavior.

## Phase 2: Hardening (ONNX optimization on Apple Silicon)

### Backend files

- [ ] `lct_python_backend/services/diarization/silero_vad.py` (new)
  - ONNX Runtime wrapper for Silero VAD iterator.
- [ ] `lct_python_backend/services/diarization/wespeaker_embeddings.py` (new)
  - ONNX/CoreML EP embedding extraction wrapper.
- [ ] `lct_python_backend/services/diarization/incremental_clustering.py` (new)
  - Centroid-based streaming clustering with overlap-aware cannot-link constraints.
- [ ] `lct_python_backend/services/diarization/sidecar.py`
  - Swap engine internals behind same sidecar contract.
- [ ] `lct_python_backend/services/stt_config.py`
  - Add engine selector and per-engine tuning parameters.
- [ ] `lct_python_backend/stt_api.py`
  - Add health/readiness introspection endpoint for diarization sidecar.

### Tests and performance checks

- [ ] `lct_python_backend/tests/unit/test_diarization_alignment.py`
  - Extend tests for ONNX pipeline edge cases (silence, rapid turn switches, overlaps).
- [ ] `lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - Add regression for sidecar timeout/degraded mode.
- [ ] `lct_python_backend/performance_benchmark.py`
  - Add diarization RTF/latency benchmark entrypoints for M1/M2/M3 class machines.

## Phase 3: Production polish (speaker persistence + adaptive behavior)

### Data model and migrations

- [ ] `lct_python_backend/models.py`
  - Add `SpeakerProfile` (or equivalent) model for persistent speaker centroids across sessions.
- [ ] `lct_python_backend/alembic/versions/<new_revision>_add_speaker_profiles.py` (new)
  - Migration for speaker profile table and required indexes.

### Backend files

- [ ] `lct_python_backend/services/diarization/speaker_profiles.py` (new)
  - Load/store/update profile centroids with confidence and recency metadata.
- [ ] `lct_python_backend/services/diarization/sidecar.py`
  - Pre-seed clustering from known speakers; emit `speaker_merge` and `diarization_reset`.
- [ ] `lct_python_backend/stt_api.py`
  - Surface speaker merge/reset events to clients.

### Frontend files

- [ ] `lct_app/src/components/HorizontalTimeline.jsx`
  - Apply speaker merge remaps without relabel flicker.
- [ ] `lct_app/src/pages/ViewConversation.jsx`
  - Refresh/reconcile timeline state when merge/reset events arrive.
- [ ] `lct_app/src/components/Legend.jsx`
  - Show active speaker mapping and merge indicators where applicable.

## Documentation files

- [ ] `docs/adr/INDEX.md`
  - Keep ADR index current as status evolves (`Proposed` -> `Approved` when accepted).
- [ ] `docs/WORKLOG.md`
  - Log each implementation leg with timestamps, files touched, validation results.
- [ ] `LOCAL_STT_SERVICES.md`
  - Document runtime dependencies and local execution profile for diarization engines.

## Validation gate checklist (must pass before default-on)

- [ ] DER/JER pipeline benchmark scripts run on fixed corpus.
- [ ] P95 latency + RTF thresholds met on at least one baseline Apple Silicon target.
- [ ] Websocket integration tests pass with diarization enabled and disabled.
- [ ] Degraded mode verified (`speaker_id` null/unknown path does not break graph flow).
- [ ] Feature flag rollback verified in one command/config change.

## Confidence and fallback

- **Confidence:** 0.75  
- **Fallback plan:** if Phase 1 misses latency/stability targets, keep diarization as optional flag, run dominant-speaker-only labeling, and keep transcript path unchanged while Phase 2 tuning proceeds.

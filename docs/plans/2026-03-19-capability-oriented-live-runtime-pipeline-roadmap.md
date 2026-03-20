# Capability-Oriented Live Runtime Pipeline Roadmap

**Date:** 2026-03-19  
**Status:** Approved architecture, implementation deferred  
**ADR:** `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md`

## Purpose

Capture the approved implementation sequence for a modular live runtime that can support many STT, diarization, and graph-generation providers without hardcoding the pipeline around one vendor.

This document is intentionally design-only for now.

## Explicit non-goals for this work session

- Do **not** add new runtime dependencies yet.
- Do **not** widen the current OpenAI stabilization slice into a provider expansion project.
- Do **not** treat this roadmap as approval to silently refactor large runtime modules without a scoped implementation pass.

## Product shape being targeted

The intended runtime behavior is:

1. microphone audio enters one backend-owned pipeline;
2. users see live text quickly;
3. background passes improve transcript quality, speaker attribution, chunking, and graph structure over time;
4. graph updates happen as smooth deformations rather than jittery replacement;
5. telemetry records what happened, when, why, and with which provider.

## Phase 0 — Documentation and contract freeze

**Goal:** approve the architecture before adding new providers or dependencies.

### Deliverables

- [x] ADR-017 defining the stage-based capability-oriented runtime.
- [x] This roadmap documenting phased implementation.
- [ ] Follow-up implementation slice selection by the human.

### No-code outputs

- canonical stage list
- canonical event types
- agreement that provider additions come after seam extraction

## Phase 1 — Extract backend stage seams without changing UX

**Goal:** create stable contracts around the current runtime before changing providers.

### Existing files likely to change

- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/stt_http_transcriber.py`
- `lct_python_backend/services/transcript_processing.py`
- `lct_python_backend/services/stt_config.py`
- `lct_python_backend/stt_api.py`

### Likely new backend modules

- `lct_python_backend/services/runtime_pipeline/types.py`
- `lct_python_backend/services/runtime_pipeline/events.py`
- `lct_python_backend/services/runtime_pipeline/reconciliation.py`
- `lct_python_backend/services/stt_adapters/base.py`

### Target outcome

- websocket session becomes thin orchestration glue
- provider-specific request logic moves behind adapter interfaces
- transcript, speaker, and graph updates gain stable event semantics

### Acceptance gate

- current OpenAI/HTTP path still works through the new interfaces
- no user-visible regression required for this phase to count as successful

## Phase 2 — Add one first-class streaming caption lane

**Goal:** prove the new seam with one real streaming provider.

### Human gate still required

Pick the first provider only when implementation starts. Current shortlist:

- `Deepgram`
- `AssemblyAI`
- `Speechmatics`
- `Gladia`

### Existing files likely to change

- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/stt_config.py`
- `lct_python_backend/services/stt_live_provider_selection.py`
- `lct_app/src/components/audio/useTranscriptSockets.js`
- `lct_app/src/components/audio/useLiveSessionStatus.js`
- `lct_app/src/components/audio/LiveSessionHud.jsx`

### Likely new backend modules

- `lct_python_backend/services/stt_adapters/streaming_<provider>.py`
- `lct_python_backend/services/stt_adapters/adapter_registry.py`

### Target outcome

- live captions come from a streaming adapter rather than chunked HTTP fallback logic
- the HUD focuses on caption latency rather than backend transport latency

### Acceptance gate

- `time_to_first_caption_ms` drops materially versus the current fallback path
- provider failures are fully visible in logs and telemetry

## Phase 3 — Add a refinement lane for diarization and transcript correction

**Goal:** keep the first caption fast while allowing richer later correction.

### Existing files likely to change

- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/transcript_processing.py`
- `lct_python_backend/services/stt_session.py`
- `lct_python_backend/models/` transcript-event persistence paths
- `lct_app/src/components/audio/audioMessages.js`

### Likely new backend modules

- `lct_python_backend/services/refinement/base.py`
- `lct_python_backend/services/refinement/diarization_lane.py`
- `lct_python_backend/services/refinement/transcript_revision_lane.py`

### Target outcome

- slower providers can emit `speaker_update` and `transcript_revision` events
- refinement no longer blocks first visible text

### Acceptance gate

- first caption remains fast even when speaker-aware refinement is slow
- refinement events can arrive after draft/final transcript events without breaking ordering

## Phase 4 — Make graph generation incremental

**Goal:** let the graph appear early and improve smoothly.

### Existing files likely to change

- `lct_python_backend/services/transcript_processing.py`
- `lct_app/src/components/AudioInput.jsx`
- `lct_app/src/components/MinimalGraph.jsx`
- `lct_app/src/components/TimelineRibbon.jsx`

### Likely new frontend/backend modules

- `lct_python_backend/services/graph_pipeline/draft_graph.py`
- `lct_python_backend/services/graph_pipeline/graph_patch_builder.py`
- `lct_app/src/components/graph/useGraphPatches.js`

### Target outcome

- draft nodes can appear from partial transcript evidence
- finalized text produces stable nodes
- later compression merges or relabels nodes without flicker

### Acceptance gate

- frontend receives graph patches rather than only full replacements
- node identity is preserved across refinement where possible

## Phase 5 — Telemetry, benchmarking, and health semantics

**Goal:** make the system diagnosable and comparable across providers.

### Existing files likely to change

- `lct_python_backend/services/stt_telemetry_service.py`
- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/instrumentation/`
- `lct_app/src/components/ServiceStatus.jsx`
- `lct_app/src/components/audio/useLiveSessionStatus.js`

### Metrics to persist

- `time_to_first_caption_ms`
- `time_to_final_caption_ms`
- `time_to_first_draft_node_ms`
- `time_to_first_stable_node_ms`
- `time_to_graph_update_ms`
- fallback order, failure cause, and per-attempt latency
- p50 / p95 / jitter by mode, provider, and model

### Target outcome

- health colors become principled:
  - `green` = selected mode usable
  - `orange` = usable but degraded
  - `red` = unusable
  - `gray` = checking or misconfigured

### Acceptance gate

- health chips no longer rely on legacy import probes for live runtime truth
- ETA and benchmark displays are based on empirical history, not invented numbers

## Phase 6 — Provider expansion

**Goal:** add more online and offline providers after the seams are proven.

### Candidate providers

- online streaming: Deepgram, AssemblyAI, Speechmatics, Rev.ai, Gladia
- online refinement: OpenAI diarize, Speechmatics, Gladia
- offline/local: NeMo, WhisperX, Parakeet + sidecar diarization

### Acceptance gate

- each provider is an adapter implementation, not a pipeline rewrite
- settings and telemetry report capability and failures consistently across providers

## Guiding constraints for all phases

1. Keep `online` and `offline` as user-facing modes.
2. Prefer capability-oriented configuration over vendor-oriented configuration.
3. Keep descriptive backend logs for every lane and every provider attempt.
4. Preserve append-only transcript-event compatibility during migration.
5. Do not add dependencies until the relevant phase is explicitly approved.

## Likely large-file refactor pressure

The following files are already known mixed-concern hotspots and should be treated carefully in implementation:

- `lct_python_backend/services/stt_http_transcriber.py`
- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/transcript_processing.py`
- `lct_app/src/components/audio/useLiveSessionStatus.js`
- `lct_app/src/components/ServiceStatus.jsx`

## First implementation slice recommendation

When implementation resumes, start with:

1. backend runtime event/type contracts
2. seam extraction around current STT runtime
3. one streaming caption adapter
4. HUD updates for caption latency

Do **not** start with multi-provider expansion or background graph refinement in the same slice.

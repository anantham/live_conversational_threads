# ADR-017: Capability-Oriented Live Runtime Pipeline

**Date:** 2026-03-19  
**Status:** Approved  
**Group:** integration + interaction + observability

## Issue

The current live runtime evolved from a backend-owned STT websocket flow into a mixed system with:

- provider-specific STT routing and fallback logic;
- chunked HTTP transcription paths optimized for the current providers rather than for a stable contract;
- graph generation that still largely starts from finalized transcript text;
- growing pressure to support many online and offline providers without locking the architecture to one vendor.

The product direction is now clearer than the implementation shape:

1. audio should enter one backend-owned pipeline;
2. the user should see something fast;
3. richer transcript correction, speaker diarization, and graph quality can arrive later as background refinement;
4. the graph should evolve through smooth deformations, not jittery replacement;
5. providers must become pluggable at contract boundaries rather than being baked into the live session orchestration.

## Context

- ADR-008 established backend-owned transcript ingestion and append-only transcript events.
- ADR-012 already chose a sidecar-style late-binding diarization pattern for local-first speaker attribution.
- ADR-014 and ADR-015 moved runtime settings toward stage-based mental models, but current backend internals still remain provider-centric.
- The current STT cloud settings and fallback flow are useful for immediate operations, but they are not yet a scalable abstraction for Deepgram, AssemblyAI, Speechmatics, Gladia, NeMo, WhisperX, or future providers.
- The product now needs a runtime architecture that supports both `offline` and `online` modes while allowing different providers to serve different capabilities:
  - fast live captions,
  - slower speaker-aware refinement,
  - graph generation and graph compression,
  - benchmarking and failure diagnosis.
- This decision is documentation-first. The architecture is approved now, but implementation and dependency additions are explicitly deferred.

## Decision

Adopt a **capability-oriented, multi-pass live runtime pipeline** with explicit stage contracts and stable event semantics.

### 1. Model the live runtime as stages, not vendors

The live conversation pipeline is defined as these stages:

1. `capture ingress`
2. `live caption lane`
3. `refinement lane`
4. `chunking / segmentation lane`
5. `graph synthesis lane`
6. `reconciliation / render lane`
7. `telemetry / benchmarking lane`

Providers integrate at one or more stage contracts rather than owning the whole flow.

### 2. Choose providers by capability, not by brand

Provider adapters must be described by capabilities such as:

- `supports_streaming_partials`
- `supports_finals`
- `supports_diarization`
- `supports_known_speakers`
- `supports_word_timestamps`
- `supports_local_execution`
- `supports_low_latency`
- `supports_revision_events`

This allows different providers to be combined in the same session:

- one provider for fast live captions,
- another for slower speaker-aware refinement,
- another for graph-oriented enrichment if needed.

### 3. Separate fast feedback from slow refinement

The default runtime shape is:

- a **fast lane** that prioritizes visible captions quickly;
- a **refinement lane** that can revise transcript quality and speaker attribution later;
- a **graph lane** that starts from lightweight draft structure and becomes richer over time.

This explicitly avoids coupling first visible output to the slowest or richest provider in the stack.

### 4. Standardize canonical event types

The runtime contract should converge on stable event types:

- `transcript_draft`
- `transcript_final`
- `transcript_revision`
- `speaker_update`
- `chunk_boundary`
- `graph_patch`

All events should carry stable IDs and provenance metadata including provider, model, latency, confidence, revision number, and fallback/refinement status where applicable.

### 5. Treat the graph as progressively refined state

The graph must not behave like a series of destructive redraws. The intended behavior is:

- draft nodes appear early from partial transcript evidence;
- stable nodes and edges arrive from stronger transcript boundaries;
- later passes can merge, relabel, recolor, or compress nodes while preserving continuity;
- frontend updates should be patch-based so the graph deforms smoothly rather than flickering.

### 6. Keep `online` and `offline` as top-level runtime modes

The user-facing mode model remains useful:

- `offline` prioritizes local execution, privacy, and low external dependency;
- `online` prioritizes quality, resilience, and external provider availability.

However, the implementation beneath those modes must be stage-based and capability-oriented rather than a single hardcoded provider tree.

### 7. Defer implementation and dependency additions

This ADR approves the architecture and the sequencing direction only.

It does **not** approve:

- immediate provider SDK additions;
- dependency changes for streaming STT vendors;
- broad runtime rewrites in this work session.

Those remain follow-up implementation slices gated by explicit human approval.

## Consequences

### Positive

- Provider lock-in decreases because integration seams become explicit.
- Supporting many endpoints becomes adapter work instead of websocket-session surgery.
- Fast captions and richer diarization stop competing for the same latency budget.
- Runtime telemetry can become comparable across providers because the contracts are normalized.
- The frontend gets a principled path to smooth graph evolution rather than full replacement on every improvement pass.

### Tradeoffs

- The architecture is more explicit and therefore more complex than the current single-runtime flow.
- Stable event IDs, revision semantics, and graph patching introduce coordination cost between backend and frontend.
- Some current settings/UI concepts are still provider-centric and will need later reconciliation with this model.
- Existing large modules will need decomposition before this architecture is comfortable to implement.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep extending current provider-first fallback architecture | Lowest near-term effort | Hardens vendor assumptions, weak seams, difficult future provider expansion |
| B | Build a faster OpenAI-first runtime and defer generalization | Fastest path for one vendor | Over-indexes on OpenAI, repeats current coupling problem |
| C | Adopt a capability-oriented multi-pass pipeline and defer implementation details (chosen) | Strong modularity, clear provider seams, aligns with product direction | Requires interface-first refactor work before visible provider expansion |
| D | Add many providers immediately without new contracts | Broad feature surface quickly | High complexity, weak observability, likely inconsistent UX |

## Assumptions

1. The product benefits more from early visible feedback than from immediate perfect diarization.
2. Speaker attribution and graph quality can lag the first visible caption without breaking user trust if the UI remains smooth.
3. Multiple providers will continue to matter across online and offline modes.
4. Stable IDs and patch semantics are achievable within the current append-only transcript-event model.

## Constraints

1. Existing `/ws/transcripts` compatibility should be preserved during migration.
2. The architecture must continue to support both local/offline and remote/online execution.
3. No new provider dependency should be introduced without explicit approval in the relevant implementation slice.
4. Telemetry and failure states must remain descriptive; silent degradation is not acceptable.

## Approved roadmap summary

1. Freeze contracts and event model in docs.
2. Extract backend stage seams without changing user-visible behavior.
3. Add one first-class streaming caption adapter behind the new contract.
4. Add a refinement lane for diarization and transcript correction.
5. Move graph generation toward draft/stable/patch semantics.
6. Add benchmark-grade telemetry and principled runtime health states.
7. Expand providers only after the adapter layer proves out.

Detailed sequencing is captured in:

- `docs/plans/2026-03-19-capability-oriented-live-runtime-pipeline-roadmap.md`

## Notes

- This ADR is intentionally approved before implementation so the current OpenAI-specific stabilization work can finish without prematurely widening scope.
- If a future implementation slice chooses the first streaming provider, record that choice as a follow-up ADR amendment or a new ADR if the decision materially constrains future providers.

## Related

- `docs/adr/ADR-008-local-stt-transcripts.md`
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md`
- `docs/adr/ADR-011-minimal-live-conversation-ui.md`
- `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md`
- `docs/adr/ADR-014-stage-based-runtime-settings-and-explicit-live-fallback-order.md`
- `docs/adr/ADR-015-settings-route-split-and-progressive-disclosure.md`

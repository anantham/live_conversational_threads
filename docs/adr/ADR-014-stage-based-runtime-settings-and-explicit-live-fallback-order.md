# ADR-014: Stage-Based Runtime Settings and Explicit Live STT Fallback Order

**Date:** 2026-03-13  
**Status:** Approved  
**Group:** interaction + integration

## Context

The Settings page currently mixes prompt editing with runtime routing. That makes it harder to reason
about the live conversation pipeline because the app's operational stages are not surfaced in the same
order they actually execute.

At the same time, live STT fallback behavior has grown more sophisticated than the Settings UX:

- the backend already supports multiple live fallback routes after the primary STT provider fails;
- the order of those STT routes was previously hardcoded in backend selection logic;
- graph-generation LLM routing already exposes an explicit ordered provider list;
- the live health HUD now describes failures by pipeline stage (`Backend`, `STT`, `Graph`), which
  increases the cost of keeping Settings vendor-centric or opaque.

We need a runtime configuration model that is debuggable, matches user mental models, and keeps prompt
authoring distinct from transport and model routing.

## Decision

- Organize runtime settings by pipeline stage rather than by vendor:
  - `Live STT`
  - `Graph LLM Routing`
  - `Graph Models & Embeddings`
  - `Prompt Library` as a separate authoring section
- Persist an explicit `live_fallback_priority` list for live STT routes.
- Surface that ordered STT fallback list in Settings, with the primary live provider always running
  first and the ordered routes applied only after failure/degradation.
- Keep the current live fallback route categories explicit:
  - `remote_whisper`
  - `external_http`
  - `openai_audio`
  - `openrouter_audio`
- Keep generic external HTTP routing as a route category; do not make Modal a first-class STT
  provider as part of this decision.

## Consequences

- Live STT routing is now inspectable and user-controlled instead of being implied by backend code.
- STT routing becomes structurally closer to graph LLM routing, reducing conceptual mismatch across
  settings panels.
- Prompt editing remains available without dominating the page's information architecture.
- Future work can add route-order presets (`local first`, `best diarization`, `most resilient`) on
  top of the persisted explicit order without changing backend semantics.
- A future split between `Live STT` and `Import STT` remains available if those pipelines continue to
  diverge in latency and diarization requirements.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep hardcoded STT fallback order and only document it | Low effort | Runtime behavior stays opaque in Settings |
| B | Organize Settings by vendor/provider | Mirrors infrastructure layout | Weak user mental model; hides pipeline stages |
| C | Organize Settings by pipeline stage and persist explicit STT fallback order (chosen) | Matches runtime behavior, easier debugging, aligns with live HUD | Requires UI and settings-schema updates |

## Notes

- Related ADRs: ADR-008, ADR-009, ADR-011.
- If Modal-hosted WhisperX becomes a stable first-class live STT dependency, capture that as a
  follow-up ADR rather than overloading the generic `external_http` route.

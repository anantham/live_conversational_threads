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

## Amendment: Implicit Routing Decisions (2026-03-19)

The following decisions are embedded in `stt_live_provider_selection.py` and were not
captured in the original ADR. Documented here for reference:

1. **`local_only=True` is the default** — prevents accidental cloud API calls. No fallback
   routes are evaluated unless explicitly opted out.

2. **`live_require_diarization=True` is the default** — blocks OpenRouter (which has no
   diarization support) unless the user explicitly allows text-only fallback.

3. **OpenAI is preferred before remote Whisper in online-style setups** — when the selected
   provider is `whisper` with a remote HTTP URL (not localhost), and OpenAI is enabled with
   diarization required, OpenAI is tried first to avoid slow/unavailable Whisper timeouts.
   Added 2026-03-20. Test: `test_resolve_live_stt_candidates_prefers_openai_before_remote_whisper`.

4. **Empty transcripts are treated as failures** — if a provider returns HTTP 200 but no
   text, the next candidate is tried. This prevents wasting the session on providers that
   accept requests but return nothing useful.

5. **`stt_provider_error` fires at most once per session** — the `stt_unready_notified` flag
   prevents repeated error messages when no STT URL is configured. Reset by each `session_meta`.

6. **Fallback priority is user-configurable** — `normalize_live_fallback_priority()` reorders
   candidates per the user's `live_fallback_priority` setting. Missing routes are appended
   in default order.

7. **Health checks are separate from candidate selection** — the fallback system tries
   candidates sequentially regardless of health status. Health probing is used for the
   Settings UI pre-flight check, not for runtime routing.

8. **Cloud provider smoke tests are separate from session-time transcription** —
   `smoke_test_stt_candidate()` generates test audio and runs one transcription for the
   Settings UI "Test" button without affecting live sessions.

## Notes

- Related ADRs: ADR-008, ADR-009, ADR-011, ADR-017.
- If Modal-hosted WhisperX becomes a stable first-class live STT dependency, capture that as a
  follow-up ADR rather than overloading the generic `external_http` route.
- ADR-017 approves a capability-oriented pipeline that will eventually supersede the
  provider-centric fallback model. The decisions above remain valid during the transition.

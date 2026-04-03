# ADR-020: Session-Scoped OpenAI BYOK for Live/Import STT and Graph Generation

**Date:** 2026-04-03  
**Status:** Approved  
**Group:** integration + security

## Issue

The app now supports session-scoped BYOK for STT, but graph generation still uses the server-hosted
LLM configuration. That leaves a real product mismatch:

- users can protect the wallet for long audio transcription, but not for transcript-to-graph work;
- the browser and backend already have a short-lived BYOK token flow, yet graph generation ignores it;
- live and import do not route LLMs the same way today, so the same visible settings can yield
  different actual providers.

The team explicitly wants the lowest-friction BYOK path: one OpenAI key, one bill owner, no
credential persistence, and no requirement that end users trust the browser with extra provider
config surfaces.

## Context

- ADR-014 made STT fallback order explicit but did not address per-session user-owned credentials.
- ADR-017 approved a capability-oriented live runtime where backend-owned orchestration remains the
  source of truth for audio/session flow.
- The STT BYOK MVP already mints opaque short-lived session tokens and keeps raw keys out of
  Postgres and global settings.
- Investigation on 2026-04-03 confirmed a routing mismatch:
  - import graph generation already accepts provider lists;
  - live websocket graph generation only loaded `llm_config` and ignored provider lists;
  - `mode=online` still takes the Gemini env-key path first, which is the wrong mental model for
    a single-key OpenAI BYOK experience.

## Decision

- Extend the existing BYOK session-token model so one OpenAI key can cover:
  - live STT
  - import STT
  - live transcript-to-graph generation
  - import transcript-to-graph generation
- Keep BYOK credentials session-scoped only:
  - raw key remains in browser memory and server memory only;
  - raw key is never written to Postgres, browser storage, or global settings.
- For BYOK graph generation, route through the provider-fallback path with an ephemeral OpenAI
  provider record rather than the Gemini-first `mode=online` path.
- Standardize live and import runtime LLM plumbing so both paths can accept the same runtime
  provider overlay.
- Keep embeddings out of scope for this decision. If a later slice needs BYOK embeddings, that is a
  follow-up ADR.

## Consequences

- Users only paste one OpenAI key for BYOK mode, which matches the desired low-friction product
  story.
- Hosted trial mode remains possible, but long-running audio and graph cost can move to the user's
  key when desired.
- Session tokens expire aggressively and are invalidated on server restart. This is acceptable for a
  single-instance VPS MVP and preferable to persisting secrets.
- Multi-instance deployment will require a shared ephemeral store such as Redis before this design
  can scale horizontally.
- BYOK graph generation no longer depends on Gemini env credentials, reducing hidden provider
  coupling.
- Embeddings and other secondary spend paths still use hosted/server configuration until a later
  decision extends BYOK scope.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep BYOK limited to STT and leave graph generation hosted | Smallest change | Still leaks major wallet cost back to the server |
| B | Use one OpenAI BYOK key for STT + graph with session-scoped runtime provider overlays (chosen) | Simple mental model, no persisted user secrets, fits backend-owned audio pipeline | Requires runtime provider plumbing, server-memory session store, and restart invalidation |
| C | Push BYOK graph calls directly to the browser and avoid server mediation | Server never sees the raw key after validation | Conflicts with backend-owned websocket/audio orchestration and complicates client runtime behavior |

## Notes

- Related ADRs: ADR-014, ADR-017, ADR-019.
- Follow-up ADR candidate: BYOK for embeddings or other analysis backends if/when user demand
  justifies the larger blast radius.

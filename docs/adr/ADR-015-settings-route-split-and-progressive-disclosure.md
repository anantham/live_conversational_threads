# ADR-015: Settings Route Split and Progressive Disclosure

**Date:** 2026-03-14  
**Status:** Approved  
**Group:** interaction

## Context

The previous Settings page mixed runtime configuration, diagnostics, and prompt authoring into a
single long scroll surface. Validation showed that the page required users to scan multiple viewport
heights of one-time setup details in order to reach the settings they actually adjust regularly.

ADR-014 established stage-based runtime settings and explicit live STT fallback ordering, but that
still left the page visually flat. The remaining UX problem was information density, not routing
semantics.

We need a configuration surface that:

- keeps `/settings` as a stable entry point;
- makes runtime configuration legible at a glance;
- moves prompt authoring out of the runtime flow;
- lazy-loads diagnostics so collapsed pages do not behave like operator dashboards.

## Decision

- Split settings into nested routes under a shared settings layout:
  - `/settings/runtime`
  - `/settings/prompts`
- Keep `/settings` as the public entry and redirect it to `/settings/runtime`.
- Use compact runtime cards with progressive disclosure:
  - keep frequently changed controls visible;
  - move raw endpoints, cloud credentials, and diagnostics behind one-level disclosures;
  - lazy-mount telemetry and manual health checks only when the diagnostics disclosure is opened.
- Add unsaved-change guards for prompt authoring route transitions.

## Consequences

- The collapsed runtime page fits in a much smaller vertical footprint and exposes the most relevant
  configuration first.
- Prompt authoring becomes a distinct task surface instead of competing with runtime routing.
- Settings navigation gains a small amount of route complexity in exchange for a much clearer
  operator mental model.
- Future work can move heavy disclosures into drawers without changing the route contract.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep a single long settings page | Lowest implementation effort | Persistent scroll wall; poor visual prioritization |
| B | Split settings into runtime/prompts routes with progressive disclosure (chosen) | Clear task separation, compact runtime page, stable `/settings` entry | More route and component structure than a single page |
| C | Full summary-plus-drawer editing from the start | Strongest visual minimalism | Higher implementation cost and more routing/state complexity upfront |

## Notes

- Related ADRs: ADR-014.
- If diagnostics continue to grow, a future ADR can split `/settings/diagnostics` into its own route.

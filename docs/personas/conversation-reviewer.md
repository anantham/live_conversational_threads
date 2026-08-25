# Conversation reviewer

**Status:** inferred and validated against the current LCT product documents and
the 2026-08-25 real-artifact walkthrough.

The primary reader is the author of a recorded conversation or a close
collaborator. They are comfortable with ideas, claims, evidence, and graph
structure, but should not need to understand ReactFlow or LCT's storage model.
They move between a desk and a phone and want to orient at the arc/theme level,
drill into a specific argument, and audit it against exact utterances.

The secondary reader is a first-time recipient of a shared `.threads` file.
They need an obvious open path, a calm initial overview, and confidence that the
artifact is local/private unless they intentionally connect a backend.

## Jobs to be done

- Understand what the conversation was broadly about without reading the full transcript.
- Follow an interesting arc down through themes, topics, ideas, and moments.
- Inspect claims, cruxes, evidence, objections, and their relationships.
- Jump from a summary back to attributable transcript evidence and recording time.
- Reopen a previously viewed artifact from this browser.

## Context and constraints

- Phone use is usually an orientation or targeted-review session, not a miniature desktop editing session.
- Touch has no hover, and controls must remain understandable without tooltips.
- The graph is intrinsically larger than the phone viewport; readable cards plus deliberate panning are preferable to fitting the whole graph as illegible thumbnails.
- Long meeting titles, participant names, thread labels, and filenames are normal data, not edge cases.
- Motion should communicate a change of context, never decorate an already dense analytic surface.

## Success signals

- A phone opens on one readable card at the active semantic level.
- Overview and timeline can be collapsed without losing their recovery controls.
- All primary actions and tier controls remain reachable without page-level horizontal overflow.
- Opening details feels like a mobile sheet; dismissing it returns to the same graph context.
- Desktop retains the richer overview, resizable thread gutter, and multi-card map.

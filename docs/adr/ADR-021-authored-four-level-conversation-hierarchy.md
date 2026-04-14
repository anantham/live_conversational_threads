# ADR-021: Authored Four-Level Conversation Hierarchy for the Primary Graph View

**Date:** 2026-04-13
**Status:** Approved and partially implemented
**Group:** presentation + data
**Supersedes in practice:** frontend-only semantic inference for the primary graph view

---

## Issue

The primary conversation graph currently mixes two incompatible ideas:

1. The backend emits a flat list of "topic shift" nodes.
2. The frontend then invents zoom levels by clustering that flat graph into
   `sentences`, `topics`, and `themes`.

This produces misleading semantics. A zoom level may look like "topics" in the UI while
really being a heuristic cluster of low-level nodes. It also allows nodes that are too
fine-grained for review, including fragment-like units that are not useful attention
objects.

The user-approved target model is a human-attention hierarchy:

- Level 1: `chunk` — a few words minimum, clause-sized if needed, never a stray single word
- Level 2: `idea` — a complete monologue beat or clear thought
- Level 3: `topic` — a paragraph-like local subject made of adjacent ideas
- Level 4: `theme` — a longer discourse region, tangent, or sustained thread

---

## Decision

The primary graph view will move to **backend-authored semantic levels**.

The backend prompt contract now asks the model to emit explicit nodes with:

- `semantic_level`
- `semantic_type`
- `parent_id`
- `children_ids`
- same-level `predecessor` / `successor`

The primary frontend graph (`MinimalGraph`) now prefers these authored levels when they
are present and falls back to legacy clustering only for older conversations that do not
yet carry authored hierarchy metadata.

---

## Rationale

- The hierarchy should be semantically authored, not visually inferred.
- Review navigation depends on stable attention units, not post-hoc clustering heuristics.
- Backward compatibility matters: older saved conversations must still render.
- The current `Node`/JSON payload shape already has enough metadata surface to ship a
  first pass without an immediate DB migration.

---

## Consequences

Positive:

- Zoom levels in the primary graph can correspond to meaningful discourse units.
- The UI can label levels honestly as `chunks`, `ideas`, `topics`, and `themes`.
- The live/saved graph payload can evolve without breaking older saved artifacts.

Tradeoffs:

- `MinimalGraph.jsx` is now carrying both authored-hierarchy mode and legacy fallback mode.
- The first pass does not yet remove legacy clustering code.
- Timeline and detail surfaces still operate on the existing node payload and will need
  further refinement as parent-child navigation becomes richer.

Follow-up decisions likely needed:

- Whether canonical higher-level nodes should be generated only from the slower corrected
  transcript lane rather than from live-final transcript.
- Whether hierarchy metadata should be persisted into normalized DB rows as first-class
  queryable semantics rather than only flowing through the graph payload.

---

## Related Artifacts

- [`lct_python_backend/services/transcript_prompts.py`](../../lct_python_backend/services/transcript_prompts.py)
- [`lct_python_backend/services/transcript_normalizer.py`](../../lct_python_backend/services/transcript_normalizer.py)
- [`lct_app/src/components/MinimalGraph.jsx`](../../lct_app/src/components/MinimalGraph.jsx)
- [`lct_app/src/components/TimelineRibbon.jsx`](../../lct_app/src/components/TimelineRibbon.jsx)
- [`lct_app/src/pages/NewConversation.jsx`](../../lct_app/src/pages/NewConversation.jsx)
- [`lct_app/src/pages/ViewConversation.jsx`](../../lct_app/src/pages/ViewConversation.jsx)


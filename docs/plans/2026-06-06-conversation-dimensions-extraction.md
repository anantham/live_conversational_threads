# Build Plan: Conversation-Dimension Extraction (action items, agreements, disagreements, surprises)

**Date:** 2026-06-06
**Status:** Proposed (for codex review before implementation)
**Goal:** Make the `.threads` artifact capture the dimensions that make a post-call review valuable — beyond cruxes + tangents (already captured), add **action items, agreements, disagreements, surprises/new-info** — and render them in a way that is visually easy to browse.
**Test bed:** a real Vatsal call (STT cached to `.tmp_transcript_cache_VatsalCatchup_May17.pkl`), assessed against Aditya's ground-truth memory.

## Current state

Node-level boolean flags exist + render: `is_tangent`, `is_crux`, `is_bookmark`, `is_contextual_progress`
(`models/graph.py`, `ConversationNode.jsx:14-17,42-72`). They are authored by the graph-gen prompt,
carried by `transcript_normalizer`, written by `graph_persistence`, propagated up tiers by
`propagate_flags_upward` (landed 25ad1df), and rendered as visual markers. **The 4 new dimensions
have no representation anywhere.** This plan extends that same pipeline.

## Design decisions (for review)

### D1 — Representation: node-boolean columns (v1) vs generalized `markers`
- **Option A (recommended for v1): four new boolean columns** — `is_action_item`, `is_agreement`,
  `is_disagreement`, `is_surprise`. Consistent with the existing `is_*` pattern end-to-end; the
  frontend already renders booleans as markers. Cost: one alembic migration + carry-through in 4 places.
- **Option B: a generalized `markers TEXT[]`** (or JSON) column — future dimensions (claim-type,
  fallacy, …) need no migration. More flexible, but a mixed model (existing booleans + new array) is a
  messy transition, and the frontend renderer would need a marker-registry rewrite.
- **Lean:** A now (ships fast, consistent), with B noted as the refactor if dimensions keep growing.
  Codex: is the migration cost worth consistency, or start the markers-array now?

### D2 — Agreements/disagreements: node flags vs edges
ADR-032's edge taxonomy already has `supports` (≈ agreement) and `rebuts` (≈ disagreement) relation
types — agreement/disagreement is inherently *relational* (X agrees/disagrees with Y). So there are two
representations: (a) **node flag** "this node is a point of (dis)agreement" — simple to browse; (b)
**edge relation** supports/rebuts between two nodes — captures structure.
- **Lean:** node flags for v1 (browsable, simple), since the artifact's value is "show me where we
  agreed/disagreed," not the full argument graph. Keep the edge representation as the richer future layer.
  Codex: does double-representing (flag + edge) cause inconsistency we should avoid?

### D3 — Propagation up tiers
Add the 4 flags to `_UPWARD_PROPAGATED_FLAGS` so a zoomed-out topic/theme shows "contains an action
item / a disagreement." `any(child)` semantics. Action items especially benefit (find the topic that
holds the commitments). Confirm this is desired for all 4.

### D4 — Prompt authoring + criteria
Extend the graph-gen prompt (local `generate_conversation_hierarchy_local` in prompts.json +
`transcript_prompts.py` spec) with criteria for each, mirroring the tangent/crux rules:
- **action_item:** an explicit task/commitment/next-step someone agreed to do (owner + action).
- **agreement:** an explicit point of alignment/affirmation between speakers.
- **disagreement:** an explicit point of friction/divergence/objection between speakers.
- **surprise:** new information, a realization, or something that changed a speaker's mind.
- Conservative: flag the genuine ones, not everything. (Same discipline that kept the File A logistics
  topic correctly unflagged.)
Note: the gpt-4 streaming + refine prompts already don't author tangent/crux (audit H3) — decide whether
to fix all paths now or keep this local-path-only for the quality test.

## Files to change (Option A)

1. `alembic/versions/<new>_add_conversation_dimension_flags.py` — add 4 boolean columns (default false).
2. `models/graph.py` — 4 columns on `Node`.
3. `services/transcript_normalizer.py` — carry the 4 in `_normalize_generated_output`; add to `_UPWARD_PROPAGATED_FLAGS`.
4. `services/graph_persistence.py` — write the 4 in the `Node(...)` constructor.
5. `prompts.json` + `services/transcript_prompts.py` — authoring criteria + output-shape fields (local graph-gen prompt; spec).
6. `services/graph_query_service.py` / `conversation_reader.py` — surface the 4 in the served payload + `.threads` export (so the viewer gets them).
7. `lct_app/src/components/graph/ConversationNode.jsx` — visual markers for the 4 (distinct, legible).
8. `lct_app/src/components/MinimalLegend.jsx` (+ optional filter) — legend entries; optionally a filter to isolate "action items" / "disagreements".
9. Tests: normalizer carry + propagation; a persistence round-trip.

## Verification

1. Run graph-gen (branch code, qwen3.6) on the cached Vatsal transcript → `.threads` artifact.
2. **Rubric-against-ground-truth:** Aditya lists the real action items / agreements / disagreements /
   surprises from the call; we score the artifact's capture (precision + recall), same method as the
   File A tangent review. The fresh call = reliable ground truth.
3. Playwright: load the artifact at `/view`, confirm the new markers render + are legible, zero `/api/`.
4. Honest assessment: where it over/under-flags, and tune the prompt criteria.

## Open questions for the user / codex
- D1 (booleans vs markers-array), D2 (flags vs edges for agree/disagree), D3 (propagate all 4?),
  D4 (fix all prompt paths or local-only for now).
- Migration safety: the running adopted LCT backend on 43181 is likely on `main` (pre-branch); the new
  columns + branch code must be used for the test (run via harness, or merge + restart the backend).

## Build order
STT cache (running) → assess current capture on Vatsal → codex-review THIS plan → migration + model +
carry-through → prompt criteria → frontend markers → run + rubric assessment → tune.

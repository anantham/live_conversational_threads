# ADR-032: Temporal Swim-Lane Layout + Semantic Edge Taxonomy

**Status**: Proposed (2026-05-19)
**Author**: anantham + Claude
**Supersedes**: portions of the `~/.claude/plans/inherited-tickling-swan.md` planning doc

## Context

Conversations of any meaningful length produce many nodes — a 25-minute live recording typically yields 100+ chunk-level nodes after streaming, plus 20+ ideas, ~9 topics, 4-5 themes, and 2-5 arcs after consolidation (ADR-031). The drill-down UX (ADR landed in `cba5457`) lets users start at the macro tier and dive into clusters, which solves the *first-screen overload* problem.

But two structural issues remain unsolved at every tier:

### 1. The default 2D layout doesn't reflect conversational structure

`MinimalGraph.jsx` currently flows through `layoutByThread` (`graphLayout.js:37`) when ≥2 threads exist, falling back to `layoutWithDagre`. `layoutByThread` already groups by `thread_id` into rows — a real step forward. **But its X-axis is column-index-within-thread, not time.** Result: if thread A spoke at t=60s, t=300s, t=1200s, all three nodes sit at adjacent X positions, erasing the actual rhythm of the conversation. Threads visually collide because their columns overlap even though their timestamps don't.

User formulation (verbatim, 2026-05-19): *"I want to see the interleaving rhythm of how conversations often have tangent 1 then 2 then 3 then you come back to 1 then a little bit of 2 then more of 3 ... so you should be able to see that row 1 has nodes then no nodes then nodes again since that topic is back from a certain timestamp."*

### 2. ~100% of authored edges are temporal-next (useless)

Empirical sample on conversation `772ac0cc-fde1-4d98-8f68-a1e3a85257c5` (124 nodes, post-consolidation):

| Edge metadata | Count |
|---|---|
| `successor` populated (temporal next) | 119 / 124 |
| `predecessor` populated (temporal prev) | 119 / 124 |
| `contextual_relation` non-empty | **0** |
| `edge_relations[]` non-empty | **0** |

Two causes:

1. **The streaming prompt** (`prompts.json:generate_conversation_hierarchy_local`) asks for `edge_relations: []` with a one-line guideline ("should primarily connect nodes at the SAME semantic_level") and no taxonomy, no examples. Model takes the path of least resistance and emits empty arrays.
2. **The read-time fallback** (`conversation_reader.py:265+`, added in `f761f8d`) synthesizes a temporal chain from `timestamp_start` ordering when no chain was authored. This was originally a fix for live STT (which can't reference future-batch IDs), but it now masks the absence of semantic edges by filling the API response with edges that are pure restatements of `timestamp_start`.

User formulation: *"Edges that are basically info we can get from the audio transcription [are] useless. The point of the edges is to capture meaningful stuff like implication, normative claims, factual claims, interruptions."*

## Decision

Two coordinated changes:

### Part A — Temporal swim-lane as the canonical layout

**Coordinate model:**
- **X-axis**: `timestamp_start` (continuous, in seconds). The full conversation duration maps to the canvas width.
- **Y-axis**: thread row index. Threads sorted by total activity (most-active at top). Empty Y space between rows == "this thread is silent during this time window."
- **Node**: rendered as a card whose left edge anchors at `timestamp_start`, width proportional to `duration_seconds` (with a minimum readable width).

**Behavior across tiers:**
- L1 chunks: many nodes, narrow widths, gaps reveal interleaving.
- L2-L5 (ideas → arcs): fewer, wider nodes spanning the time range of their descendants. Still on swim-lanes. An arc's row might span the full conversation if its themes are distributed.
- **Drilling INTO a node** (ADR-cba5457) filters the swim-lane to descendants of that node. X-axis re-scales to that node's `[timestamp_start, timestamp_end]` window.

**Implementation:**
- Extend `graphLayout.js:layoutByThread` to accept a `timeBased: true` mode. New keys: `pixelsPerSecond` (computed from canvas width / total duration), `rowHeight`, `minNodeWidth`.
- `MinimalGraph.jsx` switches to `timeBased: true` for all tier views.
- Falls back to the existing column-index mode when nodes lack `timestamp_start` (legacy / non-recorded conversations).

### Part B — Temporal ribbon (extend TimelineRibbon)

The existing `TimelineRibbon.jsx` is today a single-row strip of dots spaced by INDEX. Two extensions:

1. **Multi-row** — one row per thread, same Y-axis convention as the canvas swim-lane. Visual symmetry: ribbon mirrors canvas at lower resolution.
2. **Time-axis** — dots positioned by `timestamp_start` (not index), so gaps in the ribbon mirror gaps in the canvas.

**Return-to-thread visual:** when the same `thread_id` resumes after a gap of more than `RETURN_GAP_SECONDS` (default 60), the post-gap nodes render in a deeper saturation of the same hue. A subtle dotted arc connects the last pre-gap node to the first post-gap node.

**Thread-navigation affordance** (user request, verbatim: *"teleport to all instances of THAT thread quickly"*):
- Clicking a thread's row label highlights all that thread's nodes (both canvas + ribbon).
- A small `‹ ›` pair appears next to the highlighted thread for prev/next-occurrence navigation. Each press scrolls the canvas to center the next instance of the thread.
- Pressing `Escape` clears the highlight.

**Open question (default chosen):** the ribbon will live BELOW the canvas as a dedicated strip, with the audio scrubber below it. The current single-row ribbon (the `TimelineRibbon` component as it is) will be replaced in place — same file, same mount point in `ViewConversation.jsx`.

### Part C — Semantic edge taxonomy

**Drop the temporal-chain fallback from API output.** The read-time synthesis at `conversation_reader.py:265+` will be removed for the edge rendering path. Temporal information stays on each node as `timestamp_start` / `timestamp_end` (which the swim-lane uses for positioning anyway). It will NOT be rendered as edges.

**New edge taxonomy** (DB schema already supports any string via `Relationship.relationship_type` + `relationship_subtype`):

| Category | Edge type | Description |
|---|---|---|
| **Logical** | `implies` | X claims something that entails Y |
| | `rebuts` | X and Y are incompatible claims |
| | `supports` | X strengthens Y's claim |
| | `clarifies` | Y restates X with more precision |
| | `generalizes` | Y is the broader version of X |
| | `exemplifies` | X is a concrete case of Y |
| **Conversational** | `asks` | X is a question Y attempts to answer |
| | `interrupts` | X cuts off Y mid-thought |
| | `agrees` | speaker B affirms speaker A |
| | `disagrees` | speaker B opposes speaker A |
| | `references_back` | Y points to an earlier X |
| **Causal** | `causes` | X causes Y |
| | `enables` | X makes Y possible |
| | `prevents` | X blocks Y |
| **Thread flow** (already in `refine_conversation_subthreads` prompt) | `tangent` | Y is a digression from X |
| | `return_to_thread` | Y resumes an earlier thread |

**Epistemic markers are node attributes, not edges.** A node may carry `claim_kind: factual | normative | predictive | hypothetical | anecdote`. These don't relate two nodes; they label one. Future-work item.

**Extraction path (chosen: Path A from the discussion):**
- Wire the existing `refine_conversation_subthreads` prompt into the live-STT post-flush sequence, the same way hierarchy consolidation was wired (commit `6e873d9`).
- That prompt already knows about 6 edge types: `supports`, `rebuts`, `clarifies`, `asks`, `tangent`, `return_to_thread`. Ship Path A as v1; if quality is good, expand the prompt to cover the full taxonomy above (Path B/C).
- Cost: one extra LLM call per session, ~$0.05.

### Part D — Frontend edge rendering

Edges must be visually distinguishable by type:

| Edge type | Color | Line style |
|---|---|---|
| `implies`, `causes`, `enables` | indigo | solid arrow |
| `rebuts`, `disagrees`, `prevents` | red | solid arrow |
| `supports`, `agrees` | green | solid arrow |
| `clarifies`, `exemplifies`, `references_back` | gray | dashed |
| `asks` ↔ answer | amber | dotted, no arrow |
| `interrupts` | orange | zigzag |
| `tangent`, `return_to_thread` | thread's own color | dotted curve |

A toggle in the legend lets the user filter to one category at a time ("show only logical edges").

## Why now

Without this, the canvas is unusable past ~30 nodes:
- All-at-once 2D layout overlaps tangents.
- All-edges-are-temporal hides the semantic structure that LLM time was spent producing.

The drill-down (cba5457) made the macro view usable. The swim-lane + semantic edges make the *zoomed-in* view (a single arc's themes, or a single theme's topics, or a single topic's chunks) actually informative.

## Out of scope / explicit non-goals

- **Audio playback following a node** (separate `Following`-button question). Adjacent; will get its own follow-up.
- **Authored manual edges** (user draws an edge between two nodes via the UI). Not in this ADR.
- **Cross-conversation edges** (an idea from session A relates to an idea from session B). Future ADR.
- **The `Following` button on saved conversations** — currently dead weight per user observation, hide-when-saved is a one-line fix outside this ADR.

## Open questions (will resolve through iteration, not blocking shipping v1)

1. **Tangent depth**: is `thread_id` flat (top-level tangents only) or hierarchical (tangents within tangents)? v1: flat. We'll see if users need sub-tangents.
2. **Drill-down within swim-lane**: when drilling into a node whose descendants span the whole conversation, do we keep the full time-axis or zoom into the descendants' actual span? v1: zoom into descendants' span; provide a "show full timeline" toggle.
3. **Cross-thread semantic edges**: an `implies` edge from a node in thread A to a node in thread B — does the edge cross row boundaries in the swim-lane, or do we surface it only in a "related conversations" sidebar? v1: cross row boundaries, render the line.

## Verification plan

After implementation:

| Check | How |
|---|---|
| Swim-lane positions match timestamps | Open `/conversation/772ac0cc-...`, hover any node, confirm tooltip timestamp aligns with X position |
| Interleaving rhythm is visible | Same conversation, scroll through ribbon — should see gaps where threads are dormant |
| Return-to-thread is visible | Find a thread that resumes mid-conversation; confirm darker-saturation post-gap nodes + arc |
| Thread-jump nav works | Click a thread row label, use `‹ ›` — canvas should center each occurrence |
| Semantic edges exist | Re-record OR re-process 772ac0cc through new live STT post-flush sequence; verify Relationship rows include non-temporal types |
| Edge colors map to type | Click a non-temporal edge, confirm the label matches one of the taxonomy entries above |

## Files this ADR will touch (implementation order)

1. `lct_app/src/components/graphLayout.js` — add `timeBased` mode to `layoutByThread`
2. `lct_app/src/components/MinimalGraph.jsx` — wire `timeBased: true` in `authoredViews`
3. `lct_app/src/components/TimelineRibbon.jsx` — multi-row + time-axis + return-to-thread visual + thread-jump nav
4. `lct_python_backend/services/stt_ws_session.py` — wire `refine_conversation_subthreads` into post-flush (mirrors `_run_hierarchy_consolidation_locked`)
5. `lct_python_backend/services/conversation_reader.py` — remove temporal-chain read-time synthesis from the edge path (keep timestamps on nodes)
6. `lct_app/src/components/MinimalGraph.jsx` — edge styling by `relationship_type`
7. New legend toggle for edge category filter

## Related ADRs

- ADR-002 (hierarchical coarse-graining) — the tier model this layout renders
- ADR-016 (review experience MVP) — thematic-zoom intent that this ADR operationalizes
- ADR-021 (authored four-level conversation hierarchy) — schema this builds on
- ADR-027 (prompt-manager canonical) — where the edge-enrichment prompt lives
- ADR-030 (system invariants) — `persist_graph` contract for Relationship rows
- ADR-031 (post-streaming hierarchy consolidation) — the pass we'll mirror for edges

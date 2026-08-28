# ADR-032: Temporal Swim-Lane Layout + Semantic Edge Taxonomy + Enrichment Context

**Status**: Accepted (2026-05-19, v2 after design discussion)
**Author**: anantham + Claude
**Supersedes**: portions of `~/.claude/plans/inherited-tickling-swan.md`; the v1 draft of this ADR.

## Context

Conversations of any length produce many nodes — a 25-min live recording yields ~100 chunks, ~20 ideas, ~7 topics, ~4 themes, ~2 arcs after consolidation (ADR-031). The drill-down UX (commit `cba5457`) solved the *first-screen overload* problem. Three structural issues remain:

1. **The 2D layout doesn't reflect conversational structure.** Current `layoutByThread` uses column-index-within-thread as X-axis, erasing the interleaving rhythm of how tangents actually unfold in time.
2. **~100% of edges are temporal-next** — useless info derivable from `timestamp_start` ordering. The LLM time spent producing them adds no value because the streaming prompt doesn't ask for semantic edges with any seriousness.
3. **The enrichment LLM sees only the transcript** — no shared context, no glossary, no prior conversations. For in-group nerd conversations this guarantees shallow output.

User formulation (verbatim, 2026-05-19): *"What's the point of seeing a canvas with 100s of nodes sure it looks cool but its not practical. Edges that are basically info we can get from the audio transcription are useless. The point of the edges is to capture meaningful stuff like implication, normative claims, factual claims, interruptions."* And: *"Expecting an LLM to make sense of a very involved niche conversation by nerds is unexpected unless we give it all the context both nerds have."*

## Decision

A coordinated rework across layout, edge semantics, and enrichment pipeline:

### Part A — Temporal swim-lane as the canonical layout

**Coordinate model:**
- **X-axis**: `timestamp_start` (continuous, in seconds). Total conversation duration maps to canvas width.
- **Y-axis**: thread row index. Threads sorted by total activity (most-active at top).
- **Node**: rendered as a card anchored at `timestamp_start`, width ∝ `duration_seconds` (with a min readable width).

**Behavior across tiers:**
- All tiers use the swim-lane. Higher-tier nodes (ideas → arcs) span the time range of their descendants.
- **Drilling INTO a node rescales the X-axis to that node's `[timestamp_start, timestamp_end]` window.** Optional "show full timeline" toggle.

**Implementation:**
- Extend `graphLayout.js:layoutByThread` to accept `timeBased: true`. New keys: `pixelsPerSecond` (= canvas width / total duration), `rowHeight`, `minNodeWidth`.
- Fallback: when nodes lack `timestamp_start`, use column-index mode (legacy + non-recorded conversations).

### Part B — Temporal ribbon (multi-row, time-axis)

Extend the existing `TimelineRibbon.jsx` (today: single row of dots spaced by index):

1. **Multi-row** — one row per thread, mirroring canvas swim-lanes.
2. **Time-axis** — dots positioned by `timestamp_start`. Gaps in the ribbon mirror gaps in the canvas.
3. **Return-to-thread color shift** — after a gap of more than `RETURN_GAP_SECONDS` (default 60), post-gap nodes render in deeper saturation of the same hue. Dotted arc connects last pre-gap to first post-gap node.
4. **Thread-jump nav** — clicking a thread row label highlights all that thread's nodes; `‹ ›` buttons appear for prev/next-occurrence navigation; `Escape` clears.

**Six thread-filter patterns** (build all):

1. Multi-select thread legend (chip row at top of canvas)
2. Solo / Mute per thread row (DAW pattern)
3. Argument-scaffold trace (click payoff node X → walk ancestors)
4. Hierarchical drilldown on thread lanes (sub-threads as nested rows)
5. Brushable time window (strip beneath the swim-lane)
6. Lasso region select (Shift+drag for thread × time bounding box)

### Part C — Edge semantics + visibility

**Edge data model decisions:**
- **Persist all edges**, including temporal-next, in `Relationship` rows.
- **Suppress temporal edges visually by default**; expose via per-conversation toggle stored in `Conversation.display_preferences`.
- **Free-text `relationship_type`** stays. LLMs may invent new types. Frontend styles via fuzzy category matching with a fallback for unknown types.

**Edge taxonomy** (LLM is encouraged to use, can extend):

| Category | Edge type | Description |
|---|---|---|
| **Logical** | `implies`, `rebuts`, `supports`, `clarifies`, `generalizes`, `exemplifies` | Claim relationships |
| **Conversational** | `asks`, `interrupts`, `agrees`, `disagrees`, `references_back` | Dialogue dynamics |
| **Causal** | `causes`, `enables`, `prevents`, `triggers` | What makes what happen |
| **Thread flow** | `tangent`, `return_to_thread` | Topic shifts |

**Cross-tier edges allowed** — argument scaffolding often spans tiers (chunk supports idea supports theme). Persistence and rendering must handle these.

**Argument-scaffold trace** (Part B pattern 3):
- Default: walks only `supports / implies / clarifies` edges, incoming direction, depth limit 3.
- "Broaden" toggle: adds conversational + causal categories.

**Read-time temporal-chain synthesis** (in `conversation_reader.py:265+`, added in `f761f8d`) is REMOVED from edge output. Temporal info stays on nodes as `timestamp_start`/`timestamp_end`; the swim-lane uses those for positioning. Don't double-emit.

**Frontend edge rendering** — color-coded by category, intended to surface argument scaffolding (the A, B, C → payoff X pattern):

| Category | Color | Line style |
|---|---|---|
| Logical (`supports`, `agrees`) | green | solid arrow |
| Logical (`rebuts`, `disagrees`, `prevents`) | red | solid arrow |
| Logical (`implies`, `causes`, `enables`) | indigo | solid arrow |
| Logical-meta (`clarifies`, `exemplifies`, `references_back`) | gray | dashed |
| Conversational (`asks`) | amber | dotted |
| Conversational (`interrupts`) | orange | zigzag |
| Thread-flow (`tangent`, `return_to_thread`) | thread's own color | dotted curve |
| Temporal (when toggle on) | very light gray | thin solid, no arrowhead |

A legend toggle filters by category.

### Part D — Enrichment passes (F3: dedicated edge prompt)

Live STT post-flush sequence (extends the consolidation work from `6e873d9`):

```
async with self.processor_lock:
    if final_text_for_post_flush:
        await self._processor_handle_final_text(...)
    await self.processor.flush()
    await self._clear_pending_draft_graph(reason="flush")
    context_pack = await self._fetch_indrasnet_context()       # Part E
    await self._run_hierarchy_consolidation_locked(extra_context=context_pack)
    await self._run_edge_enrichment_locked(extra_context=context_pack)
await self._ensure_graph_persisted(reason="final_flush")
await self._kick_off_word_timing_alignment()                   # async, doesn't block
```

**New dedicated prompt: `enrich_semantic_edges`** (F3 chosen — separate from `refine_conversation_subthreads`):
- Input: full node list (chunks + ideas + topics + themes + arcs after consolidation) + retrieved context pack.
- Output: ONLY edge additions. No node mutation. Shape: `[{from_node_id, to_node_id, relation_type, explanation}, ...]`.
- Persistence: appended to `Relationship` rows. `relationship_subtype` set to the LLM-authored value verbatim (free-text).

`refine_conversation_subthreads` stays as-is for the import-densify path.

**Sync vs async**: enrichment runs synchronously inside the post-flush sequence (after `flush_complete` is sent to the client, before the final `_ensure_graph_persisted`). Empirical performance to be measured (Part J).

### Part E — Enrichment context gathering via IndrasNet

LCT calls IndrasNet's unified retrieval endpoint to inject context into enrichment LLM prompts.

```
POST {INDRASNET_BASE_URL}/api/retrieval/search
  body: { query: <recent transcript + thread summary>, top_k: 10, rerank: true }
  returns: ranked retrieval documents with `why_relevant`
```

**Filtering pipeline:**
1. Retrieval returns ranked items.
2. LCT filters out items whose source participants have `external_llm_ok=False` (the privacy gate — IndrasNet doesn't enforce this on retrieval endpoints; LCT must).
3. Filtered items are formatted into a context-pack and injected into both `enrich_semantic_edges` and `consolidate_*` prompts.

**Failure modes:**
- IndrasNet unreachable / timeout (5s default): proceed without context. Banner: "enriching without IndrasNet context — service unreachable". Logged. Future-work item: queue for retry.
- All retrieved items filtered out by privacy gate: proceed with empty context.

**Active learning loop** (deferred — note in vision.md):
Every LCT enrichment call opens an implicit `fetch_session` in IndrasNet. LCT will eventually pass back CONFIRMED / DISCARDED signals so the IndrasNet trail_index reranker accumulates evidence. Signals: user kept the enriched output / time spent on view / no contradicting edits. Build later when we have empirical signals to test against.

### Part F — Word-level timestamp persistence (Descript-style sync prerequisite)

Two paths produce word-level timing:

| Path | Source | Trigger |
|---|---|---|
| **Live STT post-flush** | The slower `gpt-4o-transcribe-diarize` refinement pass (already running async after each session) — request `timestamp_granularities: ["word"]` from the same API call that produces speaker reconciliation. **One pass, double duty.** | Async, doesn't block flush_complete. |
| **Import** | openai_audio HTTP API with `timestamp_granularities: ["word"]`. WhisperX (sidecar path) already produces word timing. | Inline with the import flow. |

**Storage**: New `Utterance.word_timings` JSONB column (`[{word, start, end, ...}]`). Both paths converge here. `TranscriptEvent.word_timestamps` stays for audit/replay.

**Frontend**: new component `WordSyncedTranscript` replaces "Raw Transcript" in NodeDetail. Two-way sync:
- Audio playing → highlight current word + auto-scroll
- Click word → seek audio
- Optional fullscreen mode (separate ADR if user wants it)

### Part G — Node attribute extensions

**Persist on Node rows at write time** (no more relying on read-time derivation alone):
- `timestamp_start` / `timestamp_end` — populated by `_compute_speaker_rollup` + `_compute_node_timestamps` at persist time. Read-time derivation (`conversation_reader.py:265+`) stays as a defense-in-depth check that asserts persisted ≈ derived; log drift.
- `source_excerpt` — new TEXT column. Persisted as authored by the LLM. Enables post-hoc re-runs of `_compute_speaker_rollup` without re-running the LLM. Enables future intelligence-on-edge (autostructures era — LLMs can re-style/re-classify at query time).
- `parent_id` / `children_ids` — already added in `c82c5d8`.

**Hierarchical thread_id**: path string convention (`"discussion-of-AI/sub-thread-on-privacy"`). Cheap, sortable, prefix-match for descendants. **No new threads table.** Renames handled by LLM intelligence at query time, not by precomputed indexes.

### Part H — Speaker rename (v1)

Inline rename in transcript: clicking the "A:" prefix (or speaker label in the synced transcript) → inline input → save fires a correction event.

**v1 behavior:**
- Hard relabel within a configurable time window (default ±5 min around the corrected utterance).
- Settings expose the window size.
- Persisted to `speaker_correction_events` (new table): `(utterance_id, prior_speaker, new_speaker, time_window_seconds, user_id, timestamp, source)`.

**v2 (deferred to vision.md):**
- Voice embeddings per utterance + Bayesian propagation outside the time window.
- Triggered once diarization quality + voice clip retention reaches a confidence threshold to justify global rename.

### Part I — Streaming animation (calm, no whiplash)

User constraint: *"slow stable calm... I do not want sudden whiplash."*

| Event | Animation |
|---|---|
| New node arrives | Fade-in opacity 0→1 over 600-800ms |
| New edge arrives | Stroke-dasharray draw 0→100% over 1000ms |
| New thread lane appears | Row slides down (height 0→100%) over 500ms, stagger 100ms after previous lane |
| Autofollow camera pan | Max 200px/sec scroll velocity; never instant jump; uses CSS easing |
| Tier auto-promotes (consolidation produces a new tier) | Cross-fade 1s; old tier dims while new tier fades in |
| Drill-in/drill-out | Zoom + pan 600ms, easing-out |

Stagger rule: when multiple things animate simultaneously, offset each by 100-200ms. Reduce-motion preference respected (set animation duration to 0).

### Part J — Telemetry (measure, don't presume)

Build with telemetry; tune from data, not theory. **Use flash models for enrichment by default; promote to larger models only when telemetry shows quality issues.**

Per-pass metrics emitted to backend logs + a `pipeline_artifacts` row:

| Metric | Captured at |
|---|---|
| Latency (ms) per pass | consolidation, edge enrichment, IndrasNet retrieval, word-timing alignment |
| Input/output token counts | each LLM call |
| Retrieval result counts | items returned by IndrasNet, items filtered out by privacy gate |
| Provider attempts | which model served, fallbacks used, errors |
| Cache hit/miss | IndrasNet retrieval (for the same query) |

Surfaced in the NodeDetail debug strip (developer mode toggle) and pipeline_artifacts table.

### Part K — Search

In scope. Cmd+K dialog (or `/`) opens a search input. Searches across:
- Node names and summaries
- Source excerpts
- Speaker names (display + alias)
- Edge explanations

Implementation: Postgres FTS on Node + Utterance text columns. Frontend: ranked result list, click jumps to node + opens drawer.

### Part L — Export

Two formats, both contain everything:
1. **Obsidian Canvas** (`.canvas`) — existing auto-export. Updated to embed swim-lane spatial info + edge taxonomy as canvas edge labels.
2. **Full JSON** — every node, edge (incl. temporal), utterance, word timings, speaker corrections, indras_net context_pack used. The complete state of the conversation in one file. Use case: archival, re-import, sharing.

Both written to the Google Drive folder per existing `[PROCESS FILE TELEMETRY]` flow.

## Non-goals (explicit)

- **Block-and-enforce participant picker** — soft prompt only, escalating intervals (5, 10, 25, 60 min) if dismissed.
- **Old-conversation migration** — existing 14 conversations stay viewable in legacy mode. Future-work flag for one-time backfill.
- **Mobile-optimized swim-lane** — desktop first. Mobile gets the legacy column-index layout fallback.
- **Manual edge editing UI** — users can't add/delete edges in v1. Future.
- **Edge confidence display** — `Relationship.confidence` exists but isn't surfaced. Future.
- **Cross-conversation edges + external-resource nodes** (per user's reframe: "links to article, book, anime") — future ADR. **But v1 must not preclude it** — `Node.node_type` is free-text TEXT, swim-lane code must gracefully handle nodes without `thread_id` or `timestamp_start`, etc. Don't hardcode "conversation" assumptions.
- **Structural-integrity metrics** — argument-quality scores, unsupported-claim counts, etc. Captured in `vision.md` as future direction.
- **Conflict resolution between enrichment passes** — last-write-wins for v1. Future ADR if it bites.

## Files this ADR will touch (implementation phase)

**Backend (data foundation first):**
1. `lct_python_backend/alembic/versions/XXX_add_source_excerpt_word_timings.py` — new migration: `Node.source_excerpt TEXT`, `Utterance.word_timings JSONB`, `speaker_correction_events` table.
2. `lct_python_backend/models/graph.py`, `models/core.py` — corresponding SQLAlchemy column adds.
3. `lct_python_backend/services/graph_persistence.py` — persist `source_excerpt`, `timestamp_start`/`timestamp_end` at write time; emit drift warning when read-time derivation diverges.
4. `lct_python_backend/services/conversation_reader.py` — remove the read-time temporal-chain synthesis (lines 265+); keep the timestamp-derive code as a drift-check.
5. `lct_python_backend/prompts.json` — new `enrich_semantic_edges` prompt.
6. `lct_python_backend/services/edge_enrichment.py` (new) — runs the prompt, parses edge list, returns it for persist.
7. `lct_python_backend/services/indrasnet_client.py` — add `retrieval_search()` function.
8. `lct_python_backend/services/stt_ws_session.py` — add `_fetch_indrasnet_context()`, `_run_edge_enrichment_locked()`, `_kick_off_word_timing_alignment()`. Wire into post-flush.
9. `lct_python_backend/services/stt_openai_realtime.py` (and HTTP equivalent) — request `timestamp_granularities: ["word"]` in the refinement call.
10. Telemetry hooks across all of the above.

**Frontend (after backend foundation):**
11. `lct_app/src/components/graphLayout.js` — `layoutByThread({ timeBased: true })` mode.
12. `lct_app/src/components/MinimalGraph.jsx` — wire `timeBased: true`; edge styling by category; argument-scaffold trace mode; temporal-edge toggle; calm-animation timings.
13. `lct_app/src/components/TimelineRibbon.jsx` — multi-row + time-axis + return-shift + thread-jump nav.
14. `lct_app/src/components/NodeDetail.jsx` — hide empty Analysis; direction-grouped Relations with category counts; inline speaker rename in transcript; WordSyncedTranscript component.
15. `lct_app/src/components/SearchDialog.jsx` (new) — Cmd+K search UI.
16. `lct_app/src/components/conversation/ParticipantPickerModal.jsx` — escalating dismissal intervals.

## Verification

| Check | How |
|---|---|
| Swim-lane X = timestamp | Hover any node, tooltip timestamp matches X position |
| Interleaving rhythm visible | Scroll a long conversation; gaps appear where threads are dormant |
| Return-to-thread is visible | Conversation with a resumed thread shows darker post-gap nodes + arc |
| Thread-jump nav works | Click thread row label, `‹ ›` cycles occurrences |
| Semantic edges populated | After a recording flushes, query `SELECT relationship_type, COUNT(*) FROM relationships` — non-temporal types present |
| IndrasNet retrieval called | Backend log includes `[ENRICHMENT] indrasnet retrieval ms=X items=Y filtered=Z` |
| Privacy gate enforced | Retrieval with an `external_llm_ok=False` participant produces filtered count > 0 |
| Word-timing in DB | `Utterance.word_timings` non-null after diarization refinement completes |
| Word sync 2-way | NodeDetail synced transcript highlights current word as audio plays; click word → seek |
| Speaker rename within ±5min | Rename a speaker in a chunk's transcript; only utterances within ±5min flip; outside untouched |
| Animation calm | New node appears → fade-in is smooth, no jump |
| Telemetry surfacing | Every enrichment pass writes pipeline_artifacts row with latency + token counts |
| Search across nodes | Cmd+K, type a unique term, click result, drawer opens on that node |

## Implementation order

Data foundations first (because everything else compensates for them):
1. **Migration**: add `source_excerpt`, `word_timings`, `speaker_correction_events`.
2. **Persist `source_excerpt` + `timestamp_start`/`end`** in `graph_persistence.py`.
3. **New `enrich_semantic_edges` prompt** + `edge_enrichment.py` service.
4. **IndrasNet `retrieval_search()`** + privacy filter.
5. **Wire enrichment + retrieval into live STT post-flush**.
6. **Word-timing in diarization refinement pass + import path**.
7. **Telemetry hooks** across all above.
8. **Frontend swim-lane time-X mode**.
9. **Edge styling + temporal toggle**.
10. **Argument-scaffold trace + thread filters (six patterns)**.
11. **TimelineRibbon multi-row + time-axis**.
12. **WordSyncedTranscript component**.

## Amendment — 2026-08-26: semantic quotient layout for macro tiers

**Status:** Approved by the operator as Option C. This supersedes Part A's
statement that every authored tier uses a temporal swim-lane.

Moments and ideas remain temporal: time answers “when did this occur?” Topics,
themes, and arcs are relationship views: their geometry answers “what supports,
clarifies, rebuts, enables, or otherwise connects what?” A macro tier therefore
renders a directed quotient graph derived from the canonical explicit v2 edge
list and many-to-many hierarchy.

For a visible tier, each explicit non-temporal, non-`member_of` edge resolves
both endpoints to every ancestor at that tier through `parent_id`,
`memberships`, and `children_ids`. If the endpoints share any visible ancestor,
the edge remains internal and no cross-node arrow is invented from secondary
memberships. Otherwise its total weight is distributed across the Cartesian
product of disjoint visible representatives, preserving total evidence weight
instead of multiplying it. Contributions aggregate by ordered visible pair and
retain relation counts, underlying edge count, confidence, strength, source
edge IDs, and supporting utterance IDs.

Directed semantic pairs use a left-to-right Dagre ranking. Chronology is only a
deterministic tie-breaker. A tier with no cross-node semantic pair uses a compact
grid rather than a line that would imply an unauthored causal order. Hiding
edges is purely visual and must not move nodes. The HUD states how many
cross-tier links are visible and how many lower-level relations remained
internal at the current tier.

This is deliberately not an LLM pass. It is a deterministic view over authored
hierarchy and edges, so zoom changes the lens without changing the underlying
conversation model.
13. **Inline speaker rename in transcript**.
14. **Search dialog**.
15. **Polish: animation tuning, edge legend, drill-rescale**.

Order is intentional: backend data shape lands first so frontend doesn't have to compensate. Each step is independently mergeable.

## Related ADRs

- ADR-002 (hierarchical coarse-graining)
- ADR-012 (realtime speaker diarization sidecar)
- ADR-013 (intent signals — shared with IndrasNet)
- ADR-016 (review experience MVP — thematic zoom)
- ADR-017 (capability-oriented live runtime pipeline)
- ADR-019 (event-sourced transcript graph)
- ADR-021 (authored four-level conversation hierarchy)
- ADR-027 (prompt manager canonical)
- ADR-030 (system invariants — persist_graph contract)
- ADR-031 (post-streaming hierarchy consolidation)

## Future ADRs flagged by this work

- **ADR-033**: Speaker identity inference from user corrections (v2 of Part H — voice embeddings + Bayesian propagation)
- **ADR-034**: External resource nodes (articles, books, memes) and cross-conversation edges
- **ADR-035**: Manual edge editing affordance and edge confidence display
- **ADR-036**: Argument-quality metrics view (structural integrity scoring)
- **ADR-037**: Conflict resolution for overlapping enrichment passes
- **ADR-038**: Mobile-optimized swim-lane layout

## Amendment — 2026-08-17: owner-local imports must prove topology completion

**Status:** approved and implemented for the IndrasNet meeting-share source path.

Hierarchy completion and argument-topology completion are separate facts. A graph
with topics/themes but no semantic-edge scan may not be advertised as fully
processed. Owner-local raw imports therefore run edge enrichment after hierarchy
consolidation with only configured local providers and with IndrasNet/second-brain
retrieval explicitly disabled. The export carries a content-free
`argument_topology` marker containing scan version, status, semantic-edge count,
and relation-type counts. A valid empty edge list is `complete`; a missing,
truncated, unparsable, or failed model response is `failed`.

Every generated node also carries one argument role (`claim`, `evidence`,
`question`, `assumption`, or `context`). Unknown or omitted roles normalize to
`context`; higher-order synthesized nodes remain `context` until a dedicated
evidenced role pass assigns something stronger. Internal `thread_id` remains the
stable grouping key, while recipient artifacts may supply a separate human
`thread_label` for display.

**Consequences:** downstream sharing pipelines can fail closed on scan status
without inspecting private content or guessing from edge counts. Existing cached
graphs without the marker must be regenerated. Relation generation adds one local
LLM pass to full-graph extraction; the fast transcript-only lane remains a
separate, explicitly unenriched product contract.

## Amendment — 2026-08-17: review corrections to the topology contract

**Status:** approved for PR #170.

Semantic scan output augments the canonical incoming `edge_relations` model; it
must not create a partial `edges_out` representation, because persistence treats
that field as a complete faithful graph and would otherwise discard temporal and
contextual relations. Public, owner, and combined exports all carry topology
completion markers; combined status is complete only when every included
conversation is complete.

Node conversational function is named `argument_role`. The separate analytical
Claim entity retains `claim_type` for its factual/normative/worldview taxonomy.
Legacy node `claim_type` values remain read-compatible but are never emitted by
new graph generation. Native LCT generation, consolidation, persistence, and
read models also carry a semantic `thread_label`; `thread_id` remains only the
stable grouping key.

## Amendment — 2026-08-20: explicit directed-edge artifact contract

**Status:** approved by the operator after the PR #170 cross-boundary direction
diagnostic.

### Issue

The database has always represented a directed relationship unambiguously as
`from_node_id -> to_node_id`. The node-local compatibility field
`edge_relations`, however, has been authored in both directions by different
pipelines. Import/export code placed an incoming relation on the target node,
while live STT and several frontend consumers treated the containing node as the
source. Existing unit tests encoded both interpretations and therefore passed
while the deployed argument view reversed support attribution.

An asymmetric Evidence -> supports -> Claim diagnostic confirmed the failure:
the database preserved Evidence -> Claim, but the frontend marked Evidence as
supported and left Claim unconnected.

### Decision

`.threads` format version 2 carries one canonical top-level `edges` array. Each
edge has explicit endpoints in the same identifier space as `graph_data[].id`:

```json
{
  "edge_schema": {
    "version": 1,
    "directed": true,
    "endpoint_space": "graph_data.id"
  },
  "edges": [
    {
      "id": "relationship-uuid",
      "from_node_id": "evidence-node-id",
      "to_node_id": "claim-node-id",
      "relation_type": "supports",
      "edge_kind": "semantic",
      "relation_subtype": null,
      "explanation": "The measured result supports the claim.",
      "strength": 0.8,
      "confidence": 0.9,
      "is_bidirectional": false,
      "supporting_utterance_ids": []
    }
  ]
}
```

The top-level array is authoritative whenever present. Direction is never
inferred from which node contains a nested field or from node names. New
frontend code indexes it into derived incoming/outgoing views for efficient
rendering, but those indexes are not a second persistence contract.

`edge_kind` is either `semantic` or `temporal`. It is derived from the stored
relationship family at the serialization boundary, not from fuzzy UI label
matching. Temporal edges remain part of the canonical graph and obey the
timeline visibility toggle, but argument analytics and provenance tracing do
not reinterpret them as rhetorical support.

`edge_relations` and `edges_out` remain in node payloads temporarily for version
1 and non-artifact API compatibility. Version 2 consumers must not use them when
the explicit contract is available. Version 1 artifacts remain readable through
the legacy path; they are not silently relabeled as direction-safe.

Combined artifacts namespace both explicit endpoints with the same conversation
prefix used for node IDs. Self-edges, missing endpoints, duplicate edge IDs, and
endpoints outside `graph_data.id` fail validation with descriptive errors.

Owner conversation and recipient-share responses expose the same `edge_schema`
and `edges` fields so the local, shared, and downloaded views cannot drift again.

### Consequences

- Existing database rows require no migration; their endpoints are already
  explicit and canonical.
- New `.threads` exports move from format version 1 to 2. The viewer accepts both
  versions, but only version 2 receives the direction-safe path.
- Argument counts, dialectic layout, trace traversal, and visual arrows consume
  the explicit endpoint indexes together.
- `is_bidirectional` is retained as producer fidelity metadata; the explicit
  endpoints remain directed and consumers do not invent a reverse edge. A
  producer that needs traversal in both directions emits both directed edges.
  Deduplication must never sort endpoint pairs and erase direction.
- The artifact is slightly larger because compatibility node fields coexist
  with the canonical array during migration. Removing those fields requires a
  later format-version decision, not an opportunistic cleanup here.

### Verification

1. Persist Evidence -> supports -> Claim and export a version 2 artifact.
2. Assert `edges[0].from_node_id` is Evidence and `to_node_id` is Claim.
3. Validate and index the artifact in the browser.
4. Assert the Claim is supported, Evidence is the actor, the drawn arrow points
   Evidence -> Claim, and incoming trace reaches Evidence from Claim.
5. Open a version 1 fixture and confirm its legacy behavior remains available.

## Amendment — 2026-08-26: bounded macro projection

**Status:** Approved as part of Option C. This amendment also records that the
version-1 verification step immediately above is superseded by ADR-036's clean
v2 beta boundary.

Many-to-many ownership remains canonical, but visual projection is a derived
read model and must not allow an arbitrary local artifact to monopolize the
browser main thread. Projection therefore fails closed and renders no partial
topology when any endpoint resolves to more than 32 visible representatives,
when more than 250,000 representative contributions would be evaluated, or
when more than 2,000 visible ordered pairs would be handed to layout. The HUD
must name this bounded state; it must not present a truncated graph as complete.

If source and target share any visible representative, the entire authored edge
remains internal at that zoom—even when their secondary memberships also have
non-overlapping pairs. Keeping only those pairs would manufacture cross-arc
claims from classification overlap rather than preserve the authored relation.
Unmapped edges are surfaced as an artifact-quality signal.

## Amendment — 2026-08-27: node-centred one-hop relationship projection

**Status:** Approved by the operator for the beta viewer.

The complete tier remains the canonical overview, but dense graphs need a
question-relative reading mode. Clicking or tapping a conversational node now
projects the current tier to that node, every directly connected semantic
neighbour, and only edges incident to the selected node. Unrelated nodes and
neighbour-to-neighbour edges are temporarily omitted rather than dimmed. The
projection consumes the current tier's already-derived quotient edges; it does
not reinterpret child edges, run another model, or mutate the artifact.

Incoming neighbours are placed above the selected node and outgoing-only
neighbours below it, matching the renderer's directed top/bottom handles.
Desktop keeps each directional band unwrapped and pannable at readable scale;
compact screens use one card per row. A reciprocal neighbour appears once while
both authored directed edges remain visible. Purely temporal adjacency does not
qualify as a semantic neighbour. An isolated node is shown honestly by itself.

The interaction contract is deliberately orthogonal:

- card body: re-root the one-hop relationship projection;
- `Expand`: descend the authored hierarchy;
- `Details`: open provenance and node details, including for leaf nodes;
- `Show all`, empty-canvas click, or Escape: return to the full tier.

Keyboard Enter/Space on a focused card is equivalent to card-body activation.
The focus-state message is a polite live region and its mobile exit respects the
44px touch-target floor. Timeline, search, or detail navigation to a node outside
the active one-hop set first restores the complete tier and then centres the
requested node; navigation must never silently target a filtered-out card.

Neighbourhood focus, weakness lenses, and argument trace are alternative reader
questions rather than composable filters. Starting relationship focus clears the
other two. Presentation-only changes such as color mode must preserve a reader's
manual pan and zoom; automatic framing runs when the analytic focus identity
changes, not whenever node presentation data is refreshed.

The desktop viewer restores the pre-projection viewport when returning. Tier,
breadcrumb, and argument-trace transitions discard that saved viewport because
their own camera policy must frame the new semantic state.

Speaker identity is again the default node-fill channel promised by ADR-011.
Single-speaker nodes use that speaker's fill; multi-speaker aggregates use a
deterministic mixed fill instead of falsely assigning one owner. A persisted
reader-selected color lens still overrides the default. Edge color continues to
encode relation family.

## Amendment — 2026-08-28: stable semantic axes and auditable provenance

**Status:** Approved by the operator for the beta viewer.

Semantic resolution and camera framing are separate state machines. Locking a
tier fixes its authored level. Unlocking preserves the currently visible tier;
after that, only a settled user zoom gesture may choose another level.
`fitView`, `setCenter`, `setViewport`, initial framing, focus framing, and other
programmatic camera motion are outputs of semantic state and must never feed
back into tier selection. The displayed zoom percentage remains live camera
telemetry and is not itself the semantic source of truth.

The viewer derives an auditable provenance read model at the artifact boundary.
For each node it unions direct utterance references with every descendant's
references across primary and secondary hierarchy memberships, de-duplicates
them by utterance ID, and preserves transcript order. This is a derived view;
it does not mutate the `.threads` artifact or choose a single owner for
many-to-many membership. Word count is computed from the matched raw utterance
text. Turn count is the number of distinct referenced utterances. Time is the
elapsed source span from earliest start to latest end—not summed speaking time.
Fallback node bounds may orient the card, but unmatched IDs cannot manufacture
word counts or raw evidence.

Cards disclose the compact `words · span · turns` measure whenever evidence is
available. Their Source action opens the exact linked speaker turns in the
detail view; the generated summary is never presented as its own evidence.
Higher-order summaries and moments therefore share one provenance path.

Keyboard navigation has two orthogonal axes:

- Up selects the nearest authored parent at a higher abstraction level.
- Down selects the nearest authored child at a lower abstraction level.
- Left/Right select the previous/next node by source time at the current tier.

Primary memberships win deterministic ties, followed by temporal/source order.
Navigation does not wrap at boundaries and ignores modified key chords and
events originating in inputs, links, buttons, selectors, or editable content.
A successful move re-roots the existing one-hop relationship focus; crossing an
abstraction boundary first changes the tier and then focuses the target.

## Amendment — 2026-08-28: settled camera lifecycle and grounded edge evidence

**Status:** Approved by the operator after acceptance testing a real dense
artifact exposed gaps that synthetic navigation tests had missed.

Every programmatic camera operation participates in one lifecycle owned by the
viewer: begin, animate, settle, record the real final viewport, then release.
Overlapping operations are generation-ordered so an older completion cannot
release or overwrite a newer motion. A user pan after `Center` therefore
compares against the actual settled zoom, not the requested zoom or an expired
timeout. This strengthens rather than replaces the semantic/camera separation
above.

Direct provenance is leaf-specific. A generation batch may retain its complete
utterance map for accounting, but it must not copy that batch onto every leaf.
Each level-one node is linked only when its grounded source excerpt overlaps
specific ordered transcript fragments. Existing authored links win; an
unmatched excerpt stays unlinked for later reconciliation. Higher tiers derive
their evidence through authored children and memberships.

Semantic relation types use one canonical grammatical spelling at extraction,
persistence, and export (`rebut` becomes `rebuts`, `support` becomes
`supports`, and equivalent verb forms follow the same rule). Canonicalization
never reverses endpoints or invents semantics. Exact duplicate directed triples
collapse at the public artifact boundary while merging their cited turns;
distinct `member_of` subtypes remain distinct.

Every newly authored semantic edge must cite the smallest exact set of
`supporting_utterance_ids` from its two endpoint nodes. Returned IDs outside
those endpoints are discarded. A short grounded source node may provide a
deterministic fallback when the model omits citations. A broad aggregate may
not: it remains explicitly without a direct turn citation instead of presenting
dozens of source turns as edge-specific proof. Import and live-STT flows use the
same incoming-edge adapter so direction and citations cannot drift.

Timing remains an independent evidence dimension. Linked source text without
aligned timestamps is rendered as `timing unavailable`; neither the pipeline
nor viewer synthesizes elapsed time from transcript order.

### Addendum — exact leaf excerpt authoring

The deterministic linker is paired with an authoring contract: every new
level-one `source_excerpt` must be one exact contiguous verbatim substring from
the current transcript segment, excluding speaker-label prefixes. Grammar
repair, paraphrase, ellipses, and splicing belong in `node_name` or `summary`,
never in direct evidence. If the generator cannot quote an exact supporting
span, it leaves the excerpt empty and the node remains explicitly unlinked.
This contract is injected centrally into managed and fallback prompts for both
local and online generation paths.

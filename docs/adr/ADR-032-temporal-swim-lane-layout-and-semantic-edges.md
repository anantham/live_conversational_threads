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

# ADR-019: Event-Sourced Transcript, Graph, and Artifact Materialization

**Date:** 2026-03-20
**Status:** Approved
**Group:** data + integration + observability

## Issue

Live processing currently produces several different truths at once:

- append-only transcript events;
- utterance rows whose speaker labels are session-scoped rather than refinement-scoped;
- a richer live graph in websocket/browser memory;
- export routes that depend on persisted `Node` rows, while other read paths fall back to synthesized turns from utterances.

This split causes correctness failures:

- headless replay can produce accurate text but no durable semantic graph;
- background diarization can improve live graph state without improving exported speaker structure;
- long same-speaker stretches collapse into one node because the utterance fallback splits only on speaker changes;
- `.canvas` / `.txt` artifacts are not guaranteed to match what the user saw live.

The system needs a single backend-owned canonical materialization pipeline for transcript, speaker attribution, graph state, and exported artifacts.

## Context

- ADR-008 established append-only transcript events as the foundational ingestion model.
- ADR-012 chose delayed speaker refinement over blocking first visible text on diarization.
- ADR-017 approved a capability-oriented multi-pass runtime pipeline with explicit draft/final/revision semantics and smooth graph deformation.
- The recent OpenAI realtime work proved that low-latency live captions and background refinement can coexist, but it also exposed a persistence gap:
  - semantic graph persistence still depends on the browser autosave hook;
  - speaker reconciliation currently updates in-memory graph state rather than durable utterance truth;
  - export routes and conversation read routes do not share one canonical materializer.

The team now explicitly wants the principled version of this architecture, not another narrow patch.

## Decision

Adopt a **Postgres-backed event-sourced materialization architecture**:

1. **Immutable evidence first**
   - keep raw transcript and diarization evidence append-only;
   - do not treat browser-held graph state as authoritative.

2. **Backend-owned read models**
   - persist canonical transcript spans, canonical graph nodes/edges, and export artifacts from backend materializers;
   - the frontend renders and edits presentation state, but it does not own semantic persistence.

3. **One materializer service for readers and exporters**
   - `GET /conversations/{id}`
   - canvas export
   - txt export
   - analytics / speaker stats
   must all derive from the same canonical materialized conversation state.

4. **Fast lane and refinement lane remain separate**
   - fast STT creates transcript evidence immediately;
   - slower speaker refinement and graph refinement update canonical read models later;
   - exported artifacts reflect the current best materialized state.

## Canonical Data Model

### Keep and repurpose existing tables

#### `conversations`

Keep as the top-level container. Ensure `source_metadata` contains source file metadata relevant to artifact naming:

- original file name
- embedded recording timestamp if available
- file mtime fallback
- import/live/replay provenance

#### `transcript_events`

Remain append-only raw evidence. Expand the semantics of `event_type` beyond `partial` / `final` to cover the materialization pipeline:

- `partial`
- `final`
- `revision`
- `speaker_update`
- `error`

Event metadata must always include provider/model/transport provenance and error detail when applicable.

#### `utterances`

Become the **current best readable transcript span** table, not the sole evidence source.

New columns to add:

- `transcript_status` (`draft`, `stable`, `refined`)
- `speaker_source` (`session_default`, `diarization`, `manual`)
- `speaker_confidence`
- `speaker_revision`
- `source_provider`
- `source_model`
- `source_transport`

`speaker_id` on `utterances` represents the current best known speaker label. The historical trail lives in immutable evidence tables, not in ad hoc browser state.

#### `nodes` and `relationships`

Remain the **current best canonical graph** tables, but become explicit materialized read models.

New columns to add to both:

- `status` (`draft`, `stable`, `refined`)
- `revision_number`
- `stable_key`
- `provenance` (`JSONB`)

`stable_key` is required so later refinements can patch/merge existing graph objects smoothly instead of creating flickery replacements.

### New tables

#### `speaker_segments`

Immutable diarization evidence emitted by background refinement.

Fields:

- `id`
- `conversation_id`
- `utterance_id` nullable
- `provider`
- `model`
- `transport`
- `speaker_id`
- `speaker_name` nullable
- `timestamp_start`
- `timestamp_end`
- `source_text`
- `confidence`
- `metadata`
- `created_at`

Purpose:

- preserve raw refinement evidence;
- support re-reconciliation later;
- make speaker analytics auditable.

#### `graph_revisions`

Append-only graph patch history emitted by the backend materializer, not by the browser UI.

Fields:

- `id`
- `conversation_id`
- `revision_number`
- `kind` (`draft`, `stable`, `refined`, `speaker_reconciliation`)
- `nodes_patch` (`JSONB`)
- `relationships_patch` (`JSONB`)
- `trigger` (`partial`, `final`, `refinement`, `manual`)
- `source_event_sequence_max`
- `metadata`
- `created_at`

Purpose:

- preserve how the graph evolved;
- support debugging and rehydration;
- let exports and replay tools reason about revision history if needed.

#### `conversation_artifacts`

Track exported `.txt`, `.canvas`, and future artifact files.

Fields:

- `id`
- `conversation_id`
- `artifact_type` (`txt`, `canvas`, `canvas_zip`, ...)
- `path`
- `filename`
- `status` (`pending`, `written`, `failed`)
- `content_hash`
- `error_detail`
- `metadata`
- `created_at`
- `updated_at`

Purpose:

- explicit export observability;
- no more silent “it should have written something” ambiguity.

## Ownership Model

### Backend owns

- semantic transcript materialization;
- speaker reconciliation persistence;
- node/edge persistence;
- export artifact generation;
- error logging for every stage.

### Frontend owns

- rendering draft and finalized graph layers;
- local layout edits / positions / interaction state;
- optional user-triggered save of presentation state.

The frontend no longer serves as the only path by which semantic graph data reaches durable storage.

## Route / Service Contract Direction

### Introduce one canonical materializer service

Example target seam:

- `materialize_conversation_state(conversation_id) -> MaterializedConversationState`

That state should be used by:

- conversation read API
- canvas export API
- txt export API
- analytics / speaker stats

### Export behavior

Processed audio conversations should support a configurable artifact export profile that can write:

- `.txt`
- `.canvas`

using timestamp-aware filenames derived in this order:

1. embedded recording metadata timestamp
2. conversation `started_at`
3. source file mtime

This ADR approves the architecture and filename precedence, not the final UI setting shape.

## Consequences

### Positive

- Headless replay and browser-backed live sessions converge on the same durable truth.
- Speaker refinement becomes export-visible and analytics-visible.
- Canvas/txt exports stop depending on whether the UI happened to autosave.
- The system becomes compatible with multiple providers and delayed refinement without losing provenance.
- Silent export failures become harder because artifact generation has explicit tracked state.

### Tradeoffs

- More tables and migrations.
- More write amplification because raw evidence and read models both exist.
- Route and service complexity increases before it decreases.
- Existing monolithic modules must be decomposed to implement this cleanly.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Patch current schema and keep browser-owned semantic persistence | Fastest | Keeps current split-brain design |
| B | Add a modest read-model layer but avoid event/revision tables | Smaller migration | Weak provenance and poorer debugging |
| C | Postgres-backed event-sourced materialization with backend-owned read models (chosen) | Strong auditability, export correctness, provider interoperability, replay fidelity | Larger migration and coordination cost |

## Argument

Option C is chosen because the current problem is not “one fallback bug.” It is a persistence-ownership bug. The transcript, graph, refinement, and export layers disagree about where truth lives. A more principled model is justified because:

- live and replay correctness matter;
- multi-provider refinement is already part of the roadmap;
- the user explicitly wants exported artifacts to be first-class outputs;
- incremental graph behavior needs stable IDs and revision semantics anyway.

## Constraints

1. Existing websocket contracts must remain backward-compatible during migration.
2. No silent degradation: every materialization/export failure must log structured context.
3. Browser autosave should remain available for presentation/layout state, but semantic correctness must not depend on it.
4. Migration must preserve current conversations and export existing data as well as possible.

## Implications

1. A follow-up migration ADR may be needed if historical backfill behavior becomes contentious.
2. `canvas_api.py`, `conversations_api.py`, `stt_session.py`, `stt_ws_session.py`, and `transcript_processing.py` will all need coordinated changes and likely decomposition.
3. Analytics and speaker-stat endpoints should eventually read from materialized state plus evidence tables, not infer speaker truth from legacy utterance rows alone.
4. Export UX can later be built as an artifact profile on top of `conversation_artifacts` without rethinking backend truth again.

## Related

- `docs/adr/ADR-008-local-stt-transcripts.md`
- `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md`
- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md`
- `docs/plans/2026-03-20-event-sourced-materialization-roadmap.md`

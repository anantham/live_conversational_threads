# Event-Sourced Materialization Roadmap

**Date:** 2026-03-20  
**Status:** Approved for phased implementation  
**Related ADR:** `docs/adr/ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md`

## Goal

Replace the current split-brain persistence model with a backend-owned canonical pipeline that can support:

- low-latency live captions;
- delayed speaker refinement;
- stable graph materialization;
- deterministic `.txt` and `.canvas` exports;
- correct behavior for browser sessions and headless replays.

## Phase 0 — Freeze contracts and migration boundaries

### Output

- ADR-019 approved
- file/ownership map recorded
- implementation order fixed before schema changes begin

### Affected files

- `docs/adr/ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md`
- `docs/adr/INDEX.md`
- `docs/WORKLOG.md`
- `ISSUES.md`

## Phase 1 — Backend owns semantic graph persistence

### Objective

Remove the current dependency on frontend autosave for canonical `Node` / `Relationship` persistence.

### Changes

- materialize stable graph nodes/relationships on backend final flush and stable graph updates
- keep frontend autosave only for presentation/layout state
- preserve websocket contract during migration

### Affected files

- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/transcript_processing.py`
- `lct_python_backend/services/import_persistence.py`
- `lct_python_backend/conversations_api.py`
- `lct_app/src/hooks/useAutoSave.js`
- `lct_app/src/pages/NewConversation.jsx`

### Acceptance criteria

- headless replay produces durable `Node` rows
- `GET /conversations/{id}` returns canonical graph nodes without needing utterance synthesis
- export no longer depends on browser autosave having run

## Phase 2 — Add immutable speaker-segment evidence + durable utterance reconciliation

### Objective

Make background diarization change durable speaker truth instead of only patching the live graph.

### Schema

- new `speaker_segments` table
- add utterance columns:
  - `transcript_status`
  - `speaker_source`
  - `speaker_confidence`
  - `speaker_revision`
  - `source_provider`
  - `source_model`
  - `source_transport`

### Affected files

- `lct_python_backend/models/core.py`
- new Alembic migration
- `lct_python_backend/services/stt_session.py`
- `lct_python_backend/services/stt_ws_session.py`
- `lct_python_backend/services/stt_live_graph.py`
- `lct_python_backend/services/speaker_analytics.py`
- analytics endpoints and tests

### Acceptance criteria

- successful background diarization updates `Utterance.speaker_id`
- provenance for each update is queryable
- speaker analytics and exports reflect reconciled speaker truth

## Phase 3 — Add graph revision history and stable patch identity

### Objective

Make graph evolution auditable and patchable.

### Schema

- new `graph_revisions` table
- add `status`, `revision_number`, `stable_key`, `provenance` to `nodes`
- add `status`, `revision_number`, `stable_key`, `provenance` to `relationships`

### Affected files

- `lct_python_backend/models/graph.py`
- new Alembic migration
- `lct_python_backend/services/transcript_processing.py`
- `lct_python_backend/services/stt_live_graph.py`
- `lct_python_backend/services/conversation_reader.py`
- `lct_app/src/pages/newConversationGraphState.js`

### Acceptance criteria

- finalized graph updates persist stable revision numbers
- the system can explain why a node changed
- exports and readers can rehydrate current graph from canonical state

## Phase 4 — Unify readers and exporters behind one materializer

### Objective

End the current route split where readers and exporters use different fallbacks.

### Changes

- introduce `materialize_conversation_state(conversation_id)`
- route `GET /conversations/{id}` through it
- route canvas export through it
- add txt export through it

### Affected files

- new `lct_python_backend/services/conversation_materializer.py`
- `lct_python_backend/conversations_api.py`
- `lct_python_backend/canvas_api.py`
- new text export route/service
- tests for read/export parity

### Acceptance criteria

- one source of truth for conversation read/export
- no more “export fails while conversation read works” split
- same conversation yields consistent graph in UI and exported canvas

## Phase 5 — Artifact tracking and configurable export profile

### Objective

Make `.txt` and `.canvas` outputs first-class tracked artifacts.

### Schema

- new `conversation_artifacts` table

### Changes

- write `.txt`
- write `.canvas`
- use timestamp-aware naming from metadata
- log artifact success/failure explicitly

### Affected files

- new export-artifact model + migration
- new `lct_python_backend/services/artifact_exporter.py`
- settings/export profile surfaces
- `canvas_api.py` and new txt export service

### Acceptance criteria

- processed conversations can emit both `.txt` and `.canvas`
- output filenames use metadata timestamp precedence
- failures are visible in logs and artifact rows

## Phase 6 — Improve fallback chunking for same-speaker monologues

### Objective

Even when diarization is weak, exported/read graphs should not collapse long monologues into one giant node.

### Changes

- replace speaker-change-only fallback with time/length/topic-aware segmentation

### Affected files

- `lct_python_backend/services/turn_synthesizer.py`
- `lct_python_backend/services/conversation_materializer.py`
- tests for monologue segmentation

### Acceptance criteria

- long single-speaker stretches produce multiple usable nodes
- segmentation is deterministic and export-safe

## Recommended implementation order

1. Phase 1
2. Phase 2
3. Phase 4
4. Phase 6
5. Phase 3
6. Phase 5

Rationale:

- first remove browser-owned semantic persistence
- then make speaker truth durable
- then unify export/read paths
- then improve degraded fallback quality
- then add revision/audit richness
- then add tracked filesystem artifacts

## Risks

- migration complexity across analytics and export paths
- accidental route breakage if materializer rollout is not gated
- additional write volume from raw evidence + read models
- temptation to keep browser-owned semantic autosave for convenience

## Non-goals for the first implementation slice

- no provider expansion
- no new STT vendor SDKs
- no attempt to solve every graph-quality issue at once
- no mandatory UI redesign beyond what the new backend contract requires

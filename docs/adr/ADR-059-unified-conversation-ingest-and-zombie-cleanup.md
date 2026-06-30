# ADR-059: Unified Conversation Ingest — narrow-waist transcription/extraction split + zombie cleanup

**Date:** 2026-06-30
**Status:** Proposed
**Group:** ingest + pipeline + repo-hygiene
**Related:** ADR-001 (Google Meet transcript support), ADR-008 (local STT append-only events), ADR-019 (event-sourced transcript/graph), ADR-023 (orchestrated live WS + async diarization), ADR-026 (two-phase live flush), ADR-030 (system invariants + pipeline standards — *this ADR finishes its deferred wiring sprint*), ADR-034 (public deployment / SSRF posture), ADR-036 (.threads artifact), ADR-037 (inference backend catalog)
**Supersedes/absorbs:** the orphaned `pages/Import.jsx` import UI; the legacy `generation_api` streaming-generation path.

## Context

There are **two different jobs** in every conversation-input path, and they are fused inconsistently:

1. **Transcription** — "turn whatever the user brought into utterances" (modality-specific: STT for audio, a PDF/line parser for Google Meet, a splitter for pasted text).
2. **Extraction** — "turn utterances into a graph" (modality-agnostic: always `TranscriptProcessor` → `persist_graph`).

Only the structured-turns path keeps these separate (`POST /api/import/turns` ingests, `POST /api/import/turns/extract` builds). Every other path either fuses them into a bespoke flow (`/process-file`, live `/ws/transcripts`) or **forgets job 2 entirely**. Three live endpoints — `/api/import/google-meet`, `/from-text`, `/from-url` — route to `persist_transcript` (`graph_persistence.py:251`) and write **utterances only, no `Node`/`Relationship` rows**. A user who imports a Google Meet transcript or pastes text gets a conversation with an **empty graph**, with no signal that extraction never ran.

This is visible at the UI layer too. The frontend has **three** parallel import surfaces pointing at **three** backends:
- `pages/Import.jsx` (a polished File/URL/Paste page) → `/api/import/google-meet|from-url|from-text` — **no-graph**, `.txt/.pdf` only, **and the route `/import` is orphaned** (nothing in the app navigates to it; Home's "Upload" goes to `/new`).
- `components/FileUpload.jsx` + `UploadContext` → `/api/import/process-file` — the **real** graph pipeline (audio + text, SSE-streams the graph). Lives only as a small footer icon on `/new` (the live-recording page), so clicking "Upload" *feels* like it dumps you into live recording.
- `components/ImportCanvas.jsx` → `/import/obsidian-canvas/` — a third path, for Obsidian `.canvas` only, reached from Browse.

Meanwhile ADR-030 **already designed the fix**: a transport-agnostic `ConversationPipeline` (`services/conversation_pipeline/`) with 8 stages (`Ingest → Transcribe → Segment → Accumulate → GenerateGraph → Persist → UnlockHierarchy`, + `Refine`), a `SourceKind` enum, a `PipelineState` carrier, and a detailed state-audit (`docs/plans/pipeline-extract-state-audit.md`) laying out a 5-PR wiring plan. It is **fully implemented and unit-tested in isolation** but has **zero production importers** (verified) — the wiring sprint was deliberately deferred and never resumed. It is the dormant spine, not zombie code.

Two code-verified inventory sweeps (2026-06-30) confirmed the dead/duplicate set; their results drive the cleanup section below.

## Decision

**One narrow waist: anything → utterances → graph.** The canonical utterance contract is the `RawTurnsPayloadV1` shape (`raw_turn_contract.py`). Every input modality is a *transcription adapter* that normalizes to utterances; extraction is a single shared stage. We finish ADR-030's wiring so both transports run through `ConversationPipeline`, generalize the ingest door into a `source` discriminated union, make graph extraction universally available, consolidate the frontend to one import hub, and delete the confirmed zombies.

### 1. Revive `conversation_pipeline` as the single spine (ADR-030 wiring sprint)
Route **both** transports through `ConversationPipeline.run(state, emit)`:
- live `/ws/transcripts` (`stt/stt_ws_session.py`) → `LiveTransport` adapter,
- import SSE (`import_pipeline/import_bulk_pipeline.py`) → `ImportTransport` adapter.

Per the audit's provisional answers (`pipeline-extract-state-audit.md` §4): construction-time config (transport re-constructs on BYOK refresh); transport owns STT task creation, pipeline sees parsed fragments; persistence requested via typed `emit` events; pipeline exposes `finalize()`. `TranscriptProcessor` stays a per-pipeline collaborator (one instance per session), never absorbed. No public API change in this step.

### 2. `source` discriminated union + universal extract
Generalize the `/turns` + `/turns/extract` two-step to **all** modalities:
- **Ingest** persists utterances from a tagged `source`: `{ kind: "turns" | "text" | "gdoc" | "audio" | "meeting_url" }`. Transport-appropriate doors remain (multipart for files, JSON for turns/text/url, WS for live) — "unified" means one resource model + one spine, not one literal URL.
- **Extract** (`POST /api/conversations/{id}/graph`, generalizing `/turns/extract`) builds/rebuilds the graph from a conversation's utterances **regardless of how it was ingested**, with `?model=` to re-run with a better/different LLM. This **kills the "no-graph" surprise**: every conversation can be turned into a graph.
- The three no-graph endpoints are folded in: `/from-text` and `/google-meet` become `source.kind` adapters that produce a graph (persist → auto-extract or expose extract); `/from-url` is generalized into the **gdoc adapter** (§3). A new ingest never stops at utterances unless the caller explicitly asks for the utterances-only IndrasNet contract (`/turns`, which by design defers extraction to `/turns/extract`).

A new input modality = **one new `source.kind` adapter that emits utterances**. No new endpoint, no new graph path. That is the design's correctness test.

### 3. Paste-a-gdoc-link via public export URL
`source.kind: "gdoc"` (generalizing the currently-disabled `/from-url`):
- Backend resolves the Google Doc to plain text via `https://docs.google.com/document/d/<id>/export?format=txt`, then text → utterances → extract → graph.
- **No OAuth.** Works for any doc the owner sets to "anyone with the link can view." Documented as a per-doc share toggle (the chosen trade-off — see Open questions for the private-doc follow-up).
- SSRF posture (ADR-034): keep the egress behind an **allowlist scoped to `docs.google.com` export URLs** rather than re-opening arbitrary `ENABLE_URL_IMPORT`. The fetch must also respect the `LCT_LOCAL_ONLY` chokepoint accounting.

### 4. OpenRouter is the extraction LLM, orthogonal to input
"Use OpenRouter on this gdoc" = ingest the gdoc (`source.kind: gdoc`) **and** select OpenRouter as the graph-generation provider. The provider is a hot-editable `llm_providers` AppSetting (`GET/PUT /api/settings/llm/providers`), independent of the input modality. The UI should not entangle the two.

### 5. One frontend conversation-input hub
- **Rebuild `pages/Import.jsx` into THE canonical import hub at `/import`**: tabs File (audio **or** transcript) / Text / Link, all routed through the **graph-producing** path (`process-file` / the source union) — not the old no-graph `/google-meet`. Reuse the `UploadContext` + SSE machinery (broadest `accept`, already streams the graph).
- **Home "Upload" → `/import`** (currently `/new`).
- **`/new` becomes live-mic-only** — remove the footer `<FileUpload/>` and the "or upload a file" empty-state from the live-recording page.
- `ImportCanvas` (Obsidian `.canvas`) stays a clearly-labeled separate import (it ingests a pre-built graph, not a transcript), surfaced from the hub or Browse — not a competing primary path.

### 6. Delete confirmed zombie code (inventory-verified 2026-06-30)
**Frontend — provably dead (zero live importer/route entry):**
- Dead routes + pages: `/analytics/:id` (`Analytics.jsx` + `services/analyticsApi.js`), `/edit-history/:id` (`EditHistory.jsx` + verify `editHistoryApi.js`), `/bookmarks` (`Bookmarks.jsx`; Home's button is a stub toast). Remove the `<Route>` + import lines in `AppRoutes.jsx`.
- `components/DualView/*` + `components/ZoomControls/*` + `components/NodeDetailPanel/*` + `hooks/useZoomController.js` + `hooks/useSyncController.js` — **11 files**, transitively dead (root `DualViewCanvas` has zero importers). *Do not* touch the live `components/NodeDetail.jsx`.
- `components/contextual/*` — **5 files** (superseded by `graphNormalization.js`).
- Standalone: `FormalismList.jsx`, `Legend.jsx` (live one is `MinimalLegend`), `SaveJson.jsx`, `SaveTranscript.jsx`.

**Backend — provably dead (zero non-test, non-doc caller):**
- `POST /api/import/google-meet/preview` (`import_api.py:183`).
- `generation_api` `/get_chunks/` + `/generate-context-stream/` (`:29,:48`) and their sole-use helpers `sliding_window_chunking` + `stream_generate_context_json` (`llm_helpers.py`).
- `import_pipeline/import_persistence.py` (a deprecated re-export shim; repoint its 2 tests to `graph_persistence`).

**Keep (do NOT delete):**
- `/api/import/turns` + `/turns/extract` — the provenance-bearing IndrasNet ingest (only `source_identifier` path); its production caller is the **external IndrasNet repo**, unverifiable from here. External contract surface.
- `/api/import/health` — used by `App.jsx` backend-reachability gate, *not* only by the orphaned Import page.
- `/api/import/from-text`, `/from-url` (→ becomes gdoc), `/google-meet` — retained but upgraded to produce graphs per §2.

### 7. Consolidate duplicates (live but redundant — staged, post-cleanup)
- **Two parallel graph stores:** DB `Node`/`Relationship` (canonical) vs file/GCS JSON (`gcs_helpers.save_json_with_backend`, written by `generation_api:/save_json/` ← `NewConversation` via `SaveConversation.jsx`, and `canvas_api`; read by `conversations_api:load_conversation_from_gcs`). Migrate `NewConversation` off `/save_json/`, then retire the GCS graph-JSON limb.
- **Turn→node duplication:** `turn_synthesizer.build_turn_graph_from_utterances` vs `graph_generation_service.build_turn_based_nodes` — pick one core.
- **Three transcript→graph builders:** `TranscriptProcessor` (canonical) vs the now-dead `generation_api` streaming path (deleted in §6) vs `graph_api:/api/graph/generate` (`build_turn_based_nodes`, live) — confirm whether `/api/graph/generate` is still needed once the spine lands.
- **Four speaker-prefix regexes** (`parsers/google_meet.py`, `text_parsers.py`, `transcript/transcript_linearization.py`, `graph_persistence.py`) — converge on one recognizer.

## Migration (staged PRs — additive, no big-bang)

| PR | Scope | Risk |
|---|---|---|
| **0** | §6 deletions — pure subtraction (24 frontend files + 4 backend symbols + dead routes/pages). Tests green, no behavior change. | low |
| **1** | §1 spine revival — wire live + import transports through `ConversationPipeline` (ADR-030 PRs A–E). No API change. | medium (transcript/STT seams) |
| **2** | §2/§3 source union + universal `/conversations/{id}/graph` extract + gdoc adapter; fold the no-graph endpoints. | medium |
| **3** | §5 frontend `/import` hub rebuild; Home "Upload" → `/import`; `/new` live-only; migrate off `/save_json` GCS path. | medium |
| **4** | §7 dedup consolidation (turn-synth, speaker parsers, retire GCS store / `/api/graph/generate` if redundant). | low |

PR-0 is independently shippable today and removes ~28 dead units before any architectural change. Each later PR is independently reviewable; the spine (PR-1) is internal so it can't regress the API.

## Consequences

- **The "no-graph" class of bugs disappears** — extraction is a universal, re-runnable operation on any conversation, not an accident of which endpoint you hit.
- A new input modality touches exactly one adapter — gdoc is the first proof (and the template for Notion/Slack/etc.).
- `conversation_pipeline` stops being dead-code-that-looks-load-bearing and becomes the actual backbone; the two giant transport files (`stt_ws_session.py` ~2500 LOC, `import_bulk_pipeline.py` ~1400 LOC) shrink to connection-mechanics adapters (audit targets ~250–400 LOC each).
- ~28 zombie units leave the tree; three import surfaces collapse to one hub + one explicitly-separate canvas import.
- **Risk:** PR-1 touches the live STT and bulk-import hot paths — gated by the existing integration suites (`test_transcripts_websocket.py`, `test_import_api_*`) which must stay green unmodified (ADR-030 §Migration "definition of done" #6).

## Open questions

- **Private gdocs without sharing** — the export-URL approach needs the owner to toggle link-viewing per doc. A follow-up ADR can add Drive-OAuth if "paste *any* private link" becomes a hard requirement. Out of scope here.
- **`/turns` extraction default** — keep the IndrasNet contract as ingest-only (explicit `/turns/extract`), or auto-extract on ingest like the other sources? Leaning keep-explicit (the contract's callers may want to ingest-then-extract on their own cadence) — confirm with the IndrasNet side.
- **`/api/graph/generate`** (turn-based, no LLM hierarchy) — retire after the spine, or keep as a cheap "no-LLM" graph mode? Decide in PR-4.
- **`/view`, `/share`, `/subject-review`** routes have no in-app entry but are intentionally direct/external-URL — left as-is (not zombies).

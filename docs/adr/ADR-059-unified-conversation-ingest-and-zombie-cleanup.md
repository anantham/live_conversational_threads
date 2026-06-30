# ADR-059: Unified Conversation Ingest — narrow-waist transcription/extraction split + zombie cleanup

**Date:** 2026-06-30
**Status:** Proposed — **v2** (v1 received a codex No-Go, 0.88; this revision closes all 10 findings with code-grounded specs)
**Group:** ingest + pipeline + privacy + repo-hygiene
**Related:** ADR-001 (Google Meet transcript), ADR-008 (local STT append-only), ADR-013 (intent signals), ADR-019 (event-sourced transcript/graph), ADR-023 (orchestrated WS + async diarization), ADR-026 (two-phase live flush), ADR-030 (pipeline standards — *this ADR finishes its deferred wiring sprint*), ADR-034 (public deployment / SSRF posture), ADR-038 (engine-agnostic privacy boundary)
**Supersedes/absorbs:** the orphaned `pages/Import.jsx` import UI; the legacy `generation_api` streaming-generation path (deleted in PR-0).

> **Revision note (v2).** v1 described the *target* architecture but treated several missing contracts as if they existed and under-specified the hard parts (privacy enforcement, SSE/WS compatibility, gdoc egress, destructive re-extract, scale). v2 rewrites each of those as a concrete spec grounded in the current code, verified by three targeted code audits on 2026-06-30. Every claim below is cited to `file:line`. **PR-0 (the deletions) already shipped and is unaffected** — see §8.

## Context

Every conversation-input path does two separable jobs:
1. **Transcription** — normalize whatever the user brought into *utterances* (STT for audio; a PDF/line parser for Meet; a splitter for pasted text).
2. **Extraction** — turn utterances into the LLM graph (`TranscriptProcessor` → `persist_graph`), modality-agnostic.

Only the structured-turns path keeps these separate (`/api/import/turns` ingests, `/api/import/turns/extract` builds). Other paths fuse them or skip job 2.

**The "no graph" symptom, stated precisely (v1 was imprecise — codex #6).** `/api/import/google-meet`, `/from-text`, `/from-url` persist utterances only (`persist_transcript`, `graph_persistence.py:251`). But the conversation GET is not blank: when a conversation has utterances and no LLM nodes, it **synthesizes a minimal speaker-turn graph** (`conversations_api.py:160-163`, `build_turn_graph_from_utterances`). So the real defect is **"no canonical LLM hierarchy / provenance," not a blank screen** — the user sees a degraded turn-graph and can't tell extraction never ran.

**The surface is more tangled than v1 admitted (codex #7).** There are **two** import frontends hitting **four** endpoints:
- `/new` inline: `FileUpload.jsx` → `UploadContext` → `useFileUploadStream.js:227` → `POST /api/import/process-file` (SSE, audio+text, **streams the graph**).
- `/import` page (`pages/Import.jsx`, route `AppRoutes.jsx:33`, currently orphaned): File→`/google-meet`, URL→`/from-url`, Paste→`/from-text` (JSON, **non-streaming, no graph**).

And ADR-030 already designed the fix: a transport-agnostic `ConversationPipeline` (`services/conversation_pipeline/`), fully unit-tested but with **zero production importers** (confirmed). It is the dormant spine — but its *current* contract is narrower than v1 implied (see §2).

## Decision

One narrow waist — **anything → utterances → graph** — finishing ADR-030's wiring, generalizing ingest to a `source` union, making extraction universal *and safe*, hard-enforcing per-source consent, and consolidating the frontend. Specs follow, each closing a codex finding.

### 1. Canonical internal utterance shape (not `RawTurnsPayloadV1` for all callers) — closes #3a

`RawTurnsPayloadV1` (`raw_turn_contract.py:53`) is the **IndrasNet wire contract** — it *requires* `group_id`, per-turn `source_identifier`, dense `seq`, and a privacy block (`:58-68`, validators `:83,:102`). That is **not** what a pasted gdoc or `/from-text` body carries (`import_schemas.py:61` is just `{text, conversation_name?, owner_id?}`). v2 does **not** force all sources onto `RawTurnsPayloadV1`. Instead:

- Each **transcription adapter** emits an internal `NormalizedUtterance[]` (`{seq, text, speaker_id, ts_start?, ts_end?, source_identifier}`). Adapters that lack provenance (text/gdoc) **synthesize** `source_identifier` deterministically (e.g. `sha1(conversation_id, seq)`) and dense `seq` from line order — the contract is satisfied internally, not pushed onto the caller.
- `RawTurnsPayloadV1` remains the **external** ingest for IndrasNet only; it is one adapter (`kind:"turns"`), not the universal shape.

### 2. Revive `conversation_pipeline` — the contract DELTA (this is new work, not existing) — closes #1

v1 implied `finalize()` and `source.kind ∈ {turns,text,gdoc,audio,meeting_url}` exist. They do **not**. Current reality:
- `ConversationPipeline` exposes only `run(state, emit)` (`orchestrator.py:88`); no `finalize()`.
- `SourceKind = Literal["live_audio","audio_file","text_file","unknown"]` (`state.py:31`) — no `turns/text/gdoc/meeting_url`.
- Stages exist but nothing in production calls them.

**The work this ADR authorizes (explicitly a contract change):**
- Extend `SourceKind` to the source union; add a `SourceAdapter` protocol (`ingest(raw) -> NormalizedUtterance[]`) per kind.
- Add `finalize()` semantics + typed error events per the audit's provisional answers (`docs/plans/pipeline-extract-state-audit.md` §4 A–D).
- Wire `LiveTransport` (`stt_ws_session.py`) and `ImportTransport` (`import_bulk_pipeline.py`) to construct stages and call `run()`/`finalize()`.

### 3. Preserve the existing SSE + WS event contracts byte-for-byte — closes #2

"No API change" was false. The spine rewire is an **internal refactor that MUST reproduce these exact wire frames**, which the frontend parses by name:

**`/process-file` SSE events** (emit = `emit(event, data)`; consumer `useFileUploadStream.js:263`):

| event | emit site | consumed at |
|---|---|---|
| `status` | `import_bulk_stage_events.py:52…376` | `:263` (stage/ETA/fallback/resume) |
| `transcript` | `import_bulk_stage_events.py:115,212,311` | `:390` |
| `graph` (sub: `existing_json`/`chunk_dict`/`graph_patch`) | `import_bulk_stage_events.py:40-42` | `:426` |
| `segment_started` / `segment_complete` | `:257` / `:363` | **(none — dropped today)** |
| `done` | `:415` (`import_bulk_pipeline.py:467`) | `:435` |
| `error` (`retryable`,`resume_available`,`checkpoint_*`) | `:399` (`:497`) | `:468` |

**Live WS** carries graph as **top-level** `existing_json`/`chunk_dict`/`graph_patch` (`stt_ws_helpers.py:186,206-207`), **not** wrapped in a `graph` envelope like SSE — plus `session_started/session_ack/transcript_*/processing_status/speaker_patch/second_speaker_detected/consumption_match/prayer_card/auto_pause/audio_ready/flush_ack/flush_complete/stt_provider_error` (`stt_ws_session.py` + `audioMessages.js`).

**Mandate:** the `LiveTransport`/`ImportTransport` adapters own this wire translation; the pipeline emits abstract `PipelineEvent`s and each adapter maps them to the exact existing frames. Pinned by the unchanged integration suites (`test_transcripts_websocket.py`, `test_import_api_*`) per ADR-030 §Migration DoD #6. (Also resolve the two pre-existing envelope quirks: SSE wraps graph sub-types, WS doesn't; and `segment_started/complete` are emitted-but-ignored — keep emitting for back-compat or drop on both ends together.)

### 4. Per-source consent — HARD-enforce `external_llm_ok` before any cloud LLM — closes #3b (the privacy blocker)

**Confirmed gap:** `external_llm_ok` defaults `False` (fail-closed *as data*) but is **never read on any extract→LLM path**. The only thing between a transcript and cloud Gemini is the global `LCT_LOCAL_ONLY` switch + the ADR-038 forbidden-*name* scan — neither is per-participant consent. Absent gates:
- `import_orchestrator.py:250-270` (`/turns/extract`: loads providers, calls LLM, never loads participants)
- `import_bulk_pipeline.py:255-279` + `import_bulk_graph_pass.py:358,619` (`/process-file`: same)
- `transcript_processing.py:439-442,613` (local-vs-cloud chosen by `config["mode"]`, not consent)
- `transcript_llm_callers.py:588-592,637-641` (cloud dispatch; only `assert_local_egress` precedes)
- `graph_persistence.py:401-418` (`external_llm_ok` persisted as metadata, never re-read)

**The gate already exists for adjacent surfaces** — replicate that pattern: voice clips (`speaker_voice_library.py:248`), retrieval context (`edge_enrichment.py:114`), synthesis engine (`contact_policy.py:329-331`).

**Spec:** at the single chokepoint every path funnels through — `TranscriptProcessor` construction (`import_orchestrator.py:258`, `import_bulk_pipeline.py:274`) and `_process_batch` (`transcript_processing.py:613`) — thread a resolved `consent` set and **force `mode="local"` (refuse cloud) when ANY participant is `external_llm_ok=False` OR unknown/unconfirmed**, mirroring `resolve_engine`. Defense-in-depth: extend the transport chokepoint (`egress_chokepoint.py:138-143`) to refuse an E3/E4 send lacking a proof-of-consent context.
- **A pasted gdoc / `/from-text` has no participants** (`/from-text` never populates them) → **fail-closed: local-only extraction by default**, never silently cloud. Cloud requires the owner to explicitly mark the conversation external-OK.

### 5. Secure gdoc import via public export URL — closes #4

A gdoc export URL `…/export?format=txt` is **blocked twice today**: (a) `LCT_LOCAL_ONLY` (default ON) blocks `docs.google.com` at the egress chokepoint before any byte leaves (`egress_chokepoint.py:144`); (b) even with egress allowed, the export **302-redirects** to `*.googleusercontent.com` and `download_url_text` **rejects all 3xx** (`import_fetchers.py:28`). Current url-import also: schemes http/https only, DNS-rebinding-safe public-IP recheck (`import_validation.py:94`), 2 MiB cap (`import_fetchers.py:12`), **no content-type check**, gated off by `ENABLE_URL_IMPORT` (`url_import_gate.py:17`).

**Spec for `source.kind:"gdoc"`:**
1. Require `ENABLE_URL_IMPORT=true` (or a dedicated `ENABLE_GDOC_IMPORT`).
2. **Import-scoped egress allowlist** for `docs.google.com` **and** `*.googleusercontent.com` (fnmatch glob; `egress_guard.py:86`). Do **NOT** widen the process-wide `LCT_LOCAL_ONLY_ALLOW_HOSTS` (loosens egress for every other call) — add a narrow import-only allow set checked only on this fetch path.
3. **Follow redirects with per-hop SSRF re-validation:** replace the blanket 3xx-reject with bounded redirect-following (e.g. ≤3 hops) that re-runs `assert_url_resolves_to_public_host` + the import allowlist on each `Location`.
4. Keep the 2 MiB cap (confirm adequate); **add a `text/plain` content-type check** on the URL path.
5. Privacy: a gdoc has no participant consent → §4 fail-closed (local extraction) unless the owner opts the conversation into external LLMs. OpenRouter as the extraction model is orthogonal — a `llm_providers` AppSetting — and still subject to §4.

### 6. Destructive re-extraction — the invalidation contract + a required pre-fix — closes #5

**`POST /api/conversations/{id}/graph` (universal extract) is dangerous as-is.** `persist_graph` deletes all `nodes`+`relationships` for the conversation (`graph_persistence.py:569-570`), preserving utterances on the re-extract path (`utterances=None`, `import_orchestrator.py:311`). But:

- **It will CRASH on any analyzed conversation.** `bias_analysis`/`frame_analysis`/`simulacra_analysis` FK `nodes.id` with **no `ondelete`** (`models/analysis.py:174,201,233`), so `delete(Node)` (`:570`) raises a Postgres FK violation. `persist_turns` already handles this with a pre-delete (`graph_persistence.py:448-450`); **`persist_graph` does not.** → **Prerequisite fix: add the analysis pre-delete (or an `ondelete=CASCADE` migration) before exposing re-extract.**
- **Silent cascade loss:** `claims`, `argument_trees`, `is_ought_conflations` CASCADE off `nodes.id` (lost, incl. fact-check results).
- **Anchor loss:** `intent_signals` (prayers/cruxes) SET NULL on `source_node_id`/`formalized_node_id` (`analysis.py:282,304`).
- **Dangling/stale (survive, point at deleted ids):** `clusters.node_ids[]` (`graph.py:169`), `edits_log.target_id` (**training data**, `interaction.py:56`), node-tier `is_bookmark` flag (regenerated by LLM), `conversations.gcs_path` (still points at old JSON), `total_claims`+`unlocked_levels` (stale; only `total_nodes` is refreshed, `:1186`), `pipeline_artifacts` (`content_hash` dedup may make resume **skip** stages).
- **Share links** render live (`shared_conversation_links`, no snapshot) → silently serve the NEW graph to recipients.
- **No concurrency guard:** nothing stops a re-extract racing a live STT session writing `persist_live_graph_snapshot` on the same `conversation_id`.

**Spec — the re-extract endpoint MUST:**
1. Land the `persist_graph` analysis pre-delete fix first (else it 500s).
2. **Reject if an `active` `thread_sessions` row exists** for the conversation (`observability.py`), or take an advisory lock — no re-extract during a live session.
3. Define, per artifact, **regenerate / preserve / invalidate / block** (table above): regenerate analyses+claims, re-anchor or flag intent_signals, tombstone-or-remap `edits_log.target_id`, drop orphaned `clusters`, clear/`gcs_path`-null, recompute `total_claims`/`unlocked_levels`, clear stage `pipeline_artifacts` so resume re-runs.
4. **Preserve utterances** (pass `utterances=None`).
5. Surface to the user that re-extract **invalidates analyses/bookmarks** and changes any active shares (confirm-before-destroy).

### 7. Frontend: one hub, reconciling two frontends + four endpoints — closes #7

- Rebuild `pages/Import.jsx` into the canonical `/import` hub (File / Text / Link), all routed through the **graph-producing** path (the `/process-file` SSE machinery / the source union via the spine), not the no-graph `/google-meet`. Reuse `UploadContext` — but note it is **File-only today** (`useFileUploadStream.js:215-217`); Text/Link need new pathways into the same SSE contract.
- **Resolve the PDF mismatch:** `FileUpload.jsx:23` and `Import.jsx:49` offer `.pdf`, but `/process-file` **rejects** it (`import_api.py:516,545`) while `/google-meet` accepts it. Decision: make the canonical path accept PDF (route it through the Meet/PDF parser → utterances → extract) **or** remove `.pdf` from the widgets. Pick one; no silent accept-then-400.
- `Home` "Upload" → `/import`; `/new` becomes live-mic-only (remove the inline `<FileUpload/>` at `NewConversation.jsx:1357` and the "or upload" empty-state). Fix `UploadToast` navigation (`:23`, currently both ternary branches are `/new`).
- `ImportCanvas` (Obsidian `.canvas`, `/import/obsidian-canvas/`) stays a clearly-separate import (it ingests a pre-built graph, not a transcript).

### 8. Cleanup inventory — aligned to what PR-0 actually shipped — closes #9

PR-0 ([#136](https://github.com/anantham/live_conversational_threads/pull/136), merged-pending) was **conservative and correct**, contradicting v1's overclaim:
- **Deleted (superseded/dead):** the DualView/ZoomControls/NodeDetailPanel tree (11), `components/contextual/` (5), 4 standalones, `generation_api` `/get_chunks/`+`/generate-context-stream/` (+ `llm_helpers.py`), `/google-meet/preview`, the `import_persistence.py` shim. ~3,900 LOC.
- **KEPT (not zombies):** `pages/Analytics`/`EditHistory`/`Bookmarks` + routes (unwired but intended features); **`generation_api`'s live `/save_json/`** (used by `NewConversation` via `SaveConversation.jsx:7`) — the router was **not** deleted; `/api/import/health` (App.jsx backend gate).
- **`/api/graph/generate`** (codex #8): it is a **turn-graph stub** — `use_llm`/`model`/`detect_relationships` are accepted but ignored (`graph_api.py:154,167`), and its only frontend caller (`graphApi.js:88`) is **never invoked** (dead wiring). Plan: delete it in PR-4 (it builds no LLM graph and nothing calls it), or formally keep it as the "no-LLM turn-graph" mode — decide in PR-4, don't leave two graph-gen concepts.

### 9. Scale: extraction is a job/SSE flow, never a synchronous request — closes #10

`/turns/extract` runs LLM extraction + flush + consolidation **inside one request** (`import_orchestrator.py:263-308`). For large Docs/Meet transcripts that times out. The universal extract + gdoc paths reuse the **existing `/process-file` SSE + checkpoint/resume infra** (the events in §3) rather than a blocking call; `/turns/extract` is upgraded to the same streamed/job model (back-compat: keep a synchronous small-payload fast path if needed, but stream by default).

## Migration (staged PRs — additive)

| PR | Scope | Gate / prerequisite |
|---|---|---|
| **0 ✅** | Delete superseded dead code (shipped, #136) | done |
| **0.5** | **`persist_graph` analysis pre-delete fix** + concurrency guard scaffolding (prereq for any re-extract) | unit + PG integration |
| **1** | Revive `conversation_pipeline` spine; wire live + import transports; reproduce SSE/WS frames exactly (§2,§3) | unchanged `test_transcripts_websocket.py` + `test_import_api_*` |
| **2** | `source` union + universal `/conversations/{id}/graph` extract with the §6 invalidation contract + §4 consent enforcement; **gdoc adapter** (§5) | new tests: privacy denial, SSRF/egress denial, destructive-regen invalidation |
| **3** | `/import` hub rebuild + PDF reconciliation + `/new` live-only + UploadToast fix (§7); migrate `NewConversation` off `/save_json` GCS path | frontend vitest |
| **4** | Dedup consolidation: turn-synth duplication, 4 speaker-prefix parsers, retire GCS graph store, resolve `/api/graph/generate` | low |

## Consequences

- The "no-graph" class disappears: extraction becomes a universal, **safe, consent-gated** operation, not an accident of endpoint.
- A new modality = one `SourceAdapter`; gdoc is the first proof.
- The privacy hole (transcripts to cloud LLMs without participant consent) is closed at a single seam, default fail-closed.
- Re-extraction stops being a latent 500 + silent data-loss; it becomes an explicit, invalidating, concurrency-guarded operation.
- `conversation_pipeline` becomes the real backbone; the 2,500/1,400-LOC transport files shrink to adapters (ADR-030 targets).
- **Risk:** PR-1 touches live STT + bulk-import hot paths and PR-0.5/PR-2 touch destructive persistence — each gated by the named suites; PR-0.5 must ship before PR-2.

## Open questions

- **Private gdocs without sharing:** export-URL needs link-viewing per doc. A Drive-OAuth follow-up is out of scope.
- **`edits_log` on re-extract:** remap `target_id` to nearest new node, or tombstone? It's training data — leaning tombstone + provenance note.
- **`/turns` extraction default:** keep ingest-only (explicit `/turns/extract`) for the IndrasNet contract, vs auto-extract — confirm with the IndrasNet side.
- **`/api/graph/generate`:** delete (dead-wired stub) vs keep as the explicit no-LLM turn-graph mode — PR-4.

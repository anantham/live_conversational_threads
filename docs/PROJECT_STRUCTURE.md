# Project Structure

Last updated: 2026-07-02

## Top Level

```text
live_conversational_threads/
├── lct_python_backend/      FastAPI backend (Python)
├── lct_app/                 React frontend (Vite, JSX)
├── docs/                    ADRs, plans, architecture docs — see docs/README.md for the map
│   ├── adr/                 Architecture Decision Records (through ADR-060, with gaps; see adr/INDEX.md)
│   ├── handovers/           Session handover notes (historical)
│   ├── plans/               Implementation plans
│   ├── design/, contracts/  Subsystem design docs and cross-system data contracts
│   └── archive/             Dated docs whose useful life has ended
├── attendee_stack/          Attendee meeting-bot Docker stack (Google Meet bot)
├── scripts/                 Ops and utility scripts
├── logs/                    Backend log files and supervisor scripts (gitignored)
├── tmp/                     Scratch space — all experiment/probe files go here (gitignored)
├── setup-once.command       One-time local bootstrap
├── start.command            Daily local startup (backend + frontend)
├── Dockerfile, docker-compose.yml
├── AGENTS.md                Operating instructions for contributors and AI agents
├── CLAUDE.md                Project-level Claude Code instructions (points to AGENTS.md)
├── CONTRIBUTING.md          Human-collaborator onboarding: reading path, setup, etiquette
├── PRODUCT.md, DESIGN.md    Design register + visual system (read before UI work)
├── ISSUES.md                Known bugs / feature-request ledger
└── README.md
```

## Backend (`lct_python_backend/`)

### Application Shell

- `backend.py`: FastAPI app factory, middleware/CORS wiring, router mounting, lifespan handlers.
- `middleware.py`: Auth gate, rate-limit, body-size guard, URL-import gate, WebSocket auth.
- `auth_policy.py`: Subject-review token authentication and exemption logic (ADR-055).
- `security_config.py`: CORS origins, trusted host configuration.
- `body_limits.py`: Per-route upload size limits.
- `rate_limit.py`: Sliding-window rate limiter.
- `config.py`: Central env-var loading and feature flags.

### Mounted Router Modules

| File | Prefix | Purpose |
|---|---|---|
| `conversations_api.py` | `/conversations/*`, `/api/conversations/*` | CRUD, transcript, graph, analysis per conversation |
| `import_api.py` | `/api/import/*` | Bulk and streaming import (PDF, Google Meet, raw turns) |
| `stt_api.py` | `/api/settings/stt*`, `/ws/transcripts` | STT settings, live WebSocket transcription |
| `llm_api.py` | `/api/settings/llm*` | LLM provider config and BYOK |
| `generation_api.py` | `/get_chunks/`, `/generate-context-stream/`, `/save_json/` | Graph generation and streaming |
| `prompts_api.py` | `/api/prompts*` | Prompt library management |
| `edit_history_api.py` | `/api/nodes/*`, `/api/conversations/*/edits*` | Per-node edit history |
| `factcheck_api.py` | `/fact_check_claims/` | Claim fact-checking |
| `analysis_api.py` | `/api/conversations/*/{simulacra\|biases\|frames\|cruxes}*` | Analysis detectors |
| `analytics_api.py` | `/api/analytics/*` | Usage analytics and cost stats |
| `backend_catalog_api.py` | `/api/backend-catalog*` | Inference backend catalog + live probes (ADR-037) |
| `revisions_api.py` | `/api/conversations/*/revisions*` | Transcript revision proposals and approval gate (Decision-B) |
| `reprocess_api.py` | `/api/conversations/*/reprocess` | Re-transcription trigger |
| `attendee_api.py` | `/api/attendee/*` | Attendee meeting-bot webhook receiver |
| `diarization_api.py` | `/api/settings/diarization*` | Diarization config |
| `artifact_api.py` | `/api/artifacts/*` | Shared artifact storage (ADR-036) |
| `share_api.py` | `/api/share/*` | Shareable conversation links |
| `speaker_naming_api.py` | `/api/speakers/*` | Speaker identity management |
| `subject_review_api.py` | `/api/subject-review/*` | Subject-side privacy review (ADR-039/055) |
| `consumption_prayer_api.py` | `/api/consumption-prayer/*` | Intent/prayer matching + contacts picker (ADR-033) |
| `graph_api.py` | `/api/graph/*` | Graph queries and persistence |
| `canvas_api.py` | `/export/obsidian-canvas/*`, `/import/obsidian-canvas/` | Obsidian canvas interop |
| `cost_api.py` | `/api/cost-tracking/*` | LLM cost aggregation |
| `user_identity_api.py` | `/api/user-identity` | Self-identity ("which contact is me") |
| `bookmarks_api.py` | `/api/bookmarks/*` | Node bookmarks |
| `version_api.py` | `/api/version` | Backend version endpoint |

### Data Layer

- `models/`: SQLAlchemy ORM models split by domain:
  - `core.py` — conversations, utterances, nodes, relationships, speakers
  - `graph.py` — graph snapshots, edges, themes
  - `analysis.py` — claims, fact checks, analysis results
  - `interaction.py` — prayers, consumption signals, share reviews
  - `identity.py` — user identity, contact associations
  - `observability.py` — telemetry, cost records, session observability
  - `system.py` — app settings, backend catalog entries
  - `base.py` — declarative base
- `db.py`, `db_session.py`, `db_helpers.py`: sync and async session factories (`SessionLocal`, `get_async_session_context()`).
- `alembic/versions/`: migration history; run `alembic upgrade head` after pulling new migrations.
- `schemas.py`, `schemas_edit_history.py`, `import_schemas.py`, `raw_turn_contract.py`: Pydantic request/response models.

### Services (`lct_python_backend/services/`)

**STT pipeline**
- `stt_config.py`, `stt_settings_service.py` — provider config and AppSetting accessors
- `stt_health_service.py` — periodic STT health checks; drives `ServiceStatus` UI
- `stt_live_runtime.py`, `stt_ws_session.py`, `stt_ws_helpers.py` — live WebSocket transcription path
- `stt_http_transcriber.py`, `audio_transcriber.py` — HTTP-based STT (slow-pass and import)
- `stt_backend_realtime.py`, `stt_openai_realtime.py` — OpenAI real-time API adapter
- `stt_live_provider_selection.py`, `stt_provider_transports.py` — provider routing
- `stt_response_parsers.py`, `stt_circuit_breaker.py`, `stt_telemetry_service.py` — parsing, fault isolation, telemetry

**Transcript processing**
- `transcript_processing.py`, `transcript_normalizer.py`, `transcript_linearization.py` — normalise and flatten incoming transcripts
- `transcript_prompts.py`, `transcript_llm_callers.py` — LLM-based dimension extraction
- `transcript_reconciliation.py` — Decision-B: slow-pass → `propose_revision()`, no direct overwrite (ADR-024)
- `transcript_revision_service.py` — create / approve / reject `TranscriptRevision` rows

**Attendee meeting-bot integration**
- `attendee_client.py` — REST client for the Attendee API
- `attendee_bridge.py` — webhook event dispatcher (bot state machine)
- `attendee_audio_downloader.py` — downloads MP3 from MinIO, runs slow-pass STT, proposes a revision

**Analysis detectors** (routed through `llm_gateway.py`)
- `bias_detector.py`, `frame_detector.py`, `simulacra_detector.py`, `crux_detector.py`

**Graph**
- `graph_generation_service.py`, `graph_query_service.py`, `graph_persistence.py`
- `utterance_node_reconciler.py`, `hierarchy_consolidator.py`
- `edge_enrichment.py` — semantic edge enrichment via IndrasNet retrieval

**Import pipeline** (bulk)
- `import_orchestrator.py`, `import_bulk_pipeline.py`, `import_bulk_processor.py`
- `import_bulk_persistence.py`, `import_persistence.py`, `import_validation.py`
- `import_bulk_diarization_enqueue.py`, `import_diarization_queue.py`
- `import_bulk_sse.py`, `import_bulk_telemetry.py`, `import_bulk_stage_events.py`
- `import_bulk_graph_pass.py`, `import_bulk_graph_refinement.py`, `import_bulk_byok.py`
- `import_checkpoint.py`, `import_bulk_checkpoint_flow.py`
- `import_fetchers.py`, `import_bulk_helpers.py`, `import_bulk_artifact_export.py`

**Speaker**
- `speaker_alignment.py`, `speaker_analytics.py`, `speaker_materialization.py`
- `speaker_naming_service.py`, `speaker_voice_library.py`
- `participant_speaker_inference.py`, `diarization_config.py`, `diarization_settings_service.py`

**LLM / provider**
- `llm_config.py`, `llm_helpers.py`, `llm_gateway.py` — provider abstraction
- `local_llm_client.py` — Ollama / local endpoint client
- `llm_telemetry_service.py` — per-provider speed telemetry → feeds backend catalog
- `provider_selection.py`, `retry_policy.py`

**Privacy / egress**
- `privacy_boundary.py` — httpx-level egress gate (ADR-038)
- `egress_chokepoint.py`, `egress_guard.py` — enforcement wrappers
- `no_audio_guard.py` — blocks audio from reaching remote LLMs
- `indrasnet_client.py` — IndrasNet HTTP client (prayers/contacts/retrieval)

**Other services**
- `backend_catalog.py` — 3-lane catalog (ADR-037); seed in `data/backend_catalog_seed.json`
- `conversation_pipeline/` — staged transcript→graph orchestrator (ADR-030); **not yet on the live path**; see ISSUES.md
- `synthesis/` — turn synthesis service
- `live_prayer/` — live prayer dispatch service
- `subject_review_core.py` — subject bundle generation for ADR-055 privacy review
- `user_identity_service.py`, `owner_context.py`
- `byok_session_store.py` — BYOK API key session storage
- `quota_service.py`, `cost_stats_service.py`, `session_observability.py`, `thread_observability_service.py`
- `audio_storage.py` — conversation audio file management (local + MinIO)
- `artifact_export_service.py`, `artifact_settings_service.py`, `conversation_artifacts.py`
- `bookmark_service.py`, `edit_logger.py`, `training_data_export.py`
- `contacts_cache.py`, `consumption_match_runner.py`, `intent_signal_persistence.py`
- `embedding_service.py`, `coercion_helpers.py`, `env_helpers.py`, `text_parsers.py`
- `tuning_constants.py` — shared numeric thresholds

### Tests (`lct_python_backend/tests/`)

- `unit/` — fast, no-DB unit tests (detectors, parsers, services)
- `integration/` — PostgreSQL integration tests (require live `lct_dev` DB + `alembic upgrade head`)
- `live_prayer/` — prayer-matching test suite
- `synthesis/` — synthesis service tests
- `fixtures/` — shared test data
- Run: `/c/Users/adity/anaconda3/python.exe -m pytest lct_python_backend/tests/ -p no:hypothesispytest`

## Frontend (`lct_app/`)

### Pages (`src/pages/`)

- `Home.jsx`, `NewConversation.jsx`, `ViewConversation.jsx` — core conversation flow
- `Import.jsx` — bulk import (PDF, Google Meet, raw turns)
- `Browse.jsx`, `Bookmarks.jsx`, `EditHistory.jsx` — discovery and history
- `MeetingView.jsx` — live meeting view (Attendee bot + real-time graph)
- `JoinMeeting.jsx` — bot invite flow
- `ThreadsViewer.jsx` — threads and arcs view (ADR-032)
- `SubjectReview.jsx` — subject-side privacy review page (ADR-055)
- `ShareConversation.jsx` — shareable link flow (ADR-036)
- `CruxAnalysis.jsx`, `FrameAnalysis.jsx`, `BiasAnalysis.jsx`, `SimulacraAnalysis.jsx` — per-conversation analysis
- `Analytics.jsx`, `CostDashboard.jsx` — usage dashboards
- `settings/` — `RuntimeSettingsPage.jsx`, `PromptLibraryPage.jsx`, `SettingsLayout.jsx`

### Components (`src/components/`)

- `AudioInput.jsx`, `audio/` — microphone capture, WebSocket transport, live session HUD
- `MinimalGraph.jsx`, `graph/`, `graphLayout.js`, `graphNormalization.js` — graph rendering and layout
- `TimelineRibbon.jsx`, `timelineRibbonLayout.js` — multi-row time-axis ribbon (ADR-032)
- `DualView/` — dual-pane layout (contextual network + timeline)
- `NodeDetailPanel/`, `NodeDetail.jsx` — node inspection
- `contextual/`, `conversation/` — contextual analysis UI
- `transcript/` — transcript display, branching, condensing, live lines
- `settings/` — STT/LLM settings cards, diagnostics, prompt editor
- `share/` — sharing UI components
- `upload/` — file upload stream and progress
- `home/` — home-page components
- `ZoomControls/`, `LlmProvidersPanel.jsx`, `LlmSettingsPanel.jsx`, `ServiceStatus.jsx` — utility UI
- `BetaGate.jsx` — beta-access gate

### Frontend Services (`src/services/`)

Feature-specific API wrappers for every backend surface. Base: `apiClient.js`.

### Hooks (`src/hooks/`)

- `useZoomController.js`, `useAutoSave.js`, `useSyncController.js`, `useLocalConversationDraft.js`

## Documentation (`docs/`)

Full taxonomy: **`docs/README.md`**. Highlights:

- `adr/` — Architecture Decision Records, ADR-001 through ADR-060 (46 on `main`; numbers 041–055 and 057 are burned, see `adr/INDEX.md`).
- `handovers/` — Session handover notes (historical context, not active references).
- `plans/` — Implementation plans linked from ADRs.
- `archive/` — Dated docs whose useful life has ended (old milestones, superseded decision lists).
- `CONVENTIONS.md` — Naming, patterns, and style ground truth. **Read this first.**
- `LOCAL_SETUP.md` — Setup and runbook for the local dev environment.
- `DATA_MODEL_V2.md`, `DATA_MODEL_V2_CORRECTIONS.md` — DB schema overview.
- `INDRASNET_INTEGRATION.md` — IndrasNet↔LCT integration design.
- `SUPERVISION.md` — Backend supervisor and process management docs.
- `PRODUCT_VISION.md` — Product mission and long-term goals.
- `FEATURE_ROADMAP.md`, `ROADMAP.md` — Feature priority queues.

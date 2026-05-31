# Project Structure

Last updated: 2026-05-30

## Top Level

```text
live_conversational_threads/
├── lct_python_backend/      FastAPI backend
├── lct_app/                 React frontend (Vite, JSX)
├── docs/                    ADRs, plans, architecture docs, worklog
├── setup-once.command       One-time local bootstrap
├── start.command            Daily local startup (backend + frontend)
├── AGENTS.md                Operating instructions
└── README.md
```

## Backend (`lct_python_backend/`)

### Application Shell

- `backend.py`: FastAPI app creation, middleware/CORS wiring, router mounting.
- `middleware.py`: auth/rate-limit/body-size/URL-import gates, WebSocket auth.
- `.env.example`: current env contract.

### Mounted Router Modules

- `import_api.py` (`/api/import/*`)
- `bookmarks_api.py` (`/api/bookmarks/*`)
- `stt_api.py` (`/api/settings/stt*`, `/ws/transcripts`, audio chunk endpoints)
- `llm_api.py` (`/api/settings/llm*`)
- `conversations_api.py` (`/conversations/*`, `/api/conversations/*`)
- `generation_api.py` (`/get_chunks/`, `/generate-context-stream/`, `/save_json/`)
- `prompts_api.py` (`/api/prompts*`)
- `edit_history_api.py` (`/api/nodes/*`, `/api/conversations/*/edits*`)
- `factcheck_api.py` (`/fact_check_claims/`, `/api/cost-tracking/stats`)
- `analysis_api.py` (`/api/conversations/*/{simulacra|biases|frames}*`)
- `analytics_api.py` (`/api/analytics/*`)
- `graph_api.py` (`/api/graph/*`)
- `canvas_api.py` (`/export/obsidian-canvas/*`, `/import/obsidian-canvas/`)
- `thematic_api.py` (`/api/conversations/*/themes*`)
- `cost_api.py` (`/api/cost-tracking/*`)
- `claim_api.py` (`/api/conversations/*/claims*`)

### Data and Services

- `models/`: SQLAlchemy models split by domain (`core.py`, `graph.py`, `analysis.py`, `interaction.py`, `system.py`, `base.py`).
- `db.py`, `db_session.py`, `db_helpers.py`: database access helpers.
- `alembic/`: migration history.
- `services/`: processing, provider clients, normalization, and orchestration.
  - `stt_*`: STT pipeline (config, WS session, HTTP transcriber, health, telemetry, live runtime, provider selection, OpenAI realtime client).
  - `transcript_*`: transcript processing (orchestrator, normalizer, LLM callers, prompts).
  - `*_detector.py`: analysis detectors (frame, bias, claim, is-ought, simulacra, argument mapper).
  - `graph_generation*.py`, `graph_query_service.py`: graph synthesis and querying.
  - `import_*`: bulk import pipeline (orchestrator, pipeline, diarization queue, validation, persistence, SSE, telemetry).
  - `llm_config.py`, `llm_helpers.py`, `local_llm_client.py`: LLM provider configuration and wrappers.
  - `hierarchical_themes/`: multi-level topic clustering (Level 1–5 clusterers).
  - `coercion_helpers.py`: shared type coercion utilities (`to_bool`, `coerce_str`, `safe_float`, etc.).
- `instrumentation/`: cost/telemetry aggregation and alerting.
- `parsers/`: transcript format parsers (Google Meet PDF/text).
- `tests/`: unit and integration tests.

## Frontend (`lct_app/`)

### Entry and Pages

- `src/main.jsx`, `src/App.jsx`, `src/AppRoutes.jsx`
- `src/pages/`: `Home.jsx`, `NewConversation.jsx`, `ViewConversation.jsx`, `Import.jsx`, `Browse.jsx`, `Bookmarks.jsx`, `EditHistory.jsx`, analysis pages (`FrameAnalysis`, `BiasAnalysis`, `SimulacraAnalysis`), `Analytics.jsx`, `CostDashboard.jsx`.
- `src/pages/settings/`: `RuntimeSettingsPage.jsx`, `PromptLibraryPage.jsx`, `SettingsLayout.jsx`.

### Core UI Areas

- `src/components/AudioInput.jsx` and `src/components/audio/*`: microphone capture, WebSocket transport, live session status HUD, STT utilities.
- `src/components/MinimalGraph.jsx`, `src/components/ContextualGraph.jsx`: graph rendering.
- `src/components/thematic/*`: thematic hierarchy components and hooks (graph, levels, settings panel, level selector).
- `src/components/settings/*`: runtime settings cards (STT, LLM, diagnostics panel, prompt editor) and form hooks.
- `src/components/DualView/*`: dual-pane layout (contextual network + timeline views).
- `src/components/ZoomControls/*`: zoom navigation controls and level indicator.
- `src/components/NodeDetailPanel/*`: node inspection panel.
- `src/components/contextual/*`: contextual analysis components (claims panel, context card, transcript card, graph layout).
- `src/components/upload/*`: file upload stream handling and progress panel.
- `src/components/LlmProvidersPanel.jsx`, `src/components/LlmSettingsPanel.jsx`: LLM provider settings UI.
- `src/components/ServiceStatus.jsx`: backend/STT/graph health status display.
- `src/components/SttCloudFallbackFields.jsx`: cloud STT fallback configuration.

### Frontend Services

- `src/services/apiClient.js`: base HTTP client and auth header handling.
- `src/services/*Api.js`: feature-specific API wrappers (graph, prompts, frame, bias, simulacra, analytics, editHistory, sttSettings, llmSettings).

### Hooks

- `src/hooks/useZoomController.js`: zoom level state and navigation.
- `src/hooks/useAutoSave.js`: auto-save to IndexedDB.
- `src/hooks/useSyncController.js`: data sync state.

## Documentation (`docs/`)

- `docs/adr/`: architecture decisions (ADR-001 through ADR-018; see `docs/adr/INDEX.md`).
- `docs/plans/`: implementation plans and checklists.
- `docs/CONVENTIONS.md`: project naming, patterns, and style ground truth.
- `docs/WORKLOG.md`: timestamped engineering log.
- `docs/TECH_DEBT.md`: large-file and architecture cleanup backlog.
- `docs/FEATURE_ROADMAP.md`: feature prioritization (partially superseded by ADR-driven planning).
- `docs/LOCAL_SETUP.md`: operational setup/runbook.
- `docs/VISION.md`: product vision and mission.
- `docs/TIER_1_DECISIONS.md`, `docs/TIER_2_FEATURES.md`: foundational and secondary feature decisions.

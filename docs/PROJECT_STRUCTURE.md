# Project Structure

Last updated: 2026-02-08

## Top-Level Layout

```
live_conversational_threads/
├── lct_python_backend/      FastAPI backend (API, services, models)
├── lct_app/                 React 18 + Vite frontend
├── docs/                    ADRs, plans, data model, roadmaps
├── docker-compose.yml       PostgreSQL 15 for local dev
├── README.md                Project overview and setup
├── CLAUDE.md                Agent operating instructions
└── requirements.txt         Backend Python dependencies
```

## Backend (`lct_python_backend/`)

### Entry Point and Routers

| File | Purpose |
|------|---------|
| `backend.py` | Main FastAPI app, CORS, middleware wiring, 40+ inline endpoints |
| `import_api.py` | Google Meet transcript import (PDF/TXT/URL/text) — prefix `/api/import` |
| `bookmarks_api.py` | Conversation bookmarks CRUD — prefix `/api/bookmarks` |
| `stt_api.py` | STT settings, audio upload, `/ws/transcripts` WebSocket |
| `llm_api.py` | LLM settings read/write — `/api/settings/llm` |
| `graph_api.py` | Graph generation endpoints (not currently mounted) |
| `analytics_api.py` | Analytics endpoints (defined inline in backend.py instead) |
| `cost_api.py` | Cost tracking endpoints (defined inline in backend.py instead) |

### Data Layer

| File | Purpose |
|------|---------|
| `models.py` | SQLAlchemy ORM models (~714 LOC) — Conversation, Node, Utterance, Relationship, AppSetting, TranscriptEvent, etc. |
| `db.py` | Async database connection (databases library) |
| `db_session.py` | SQLAlchemy async session factory |
| `db_helpers.py` | Legacy DB helper functions |
| `alembic/` | Database migration scripts |

### Services (`services/`)

| File | Purpose |
|------|---------|
| `transcript_processing.py` | Transcript segmentation, accumulation, local LLM processing |
| `graph_generation.py` | Conversation graph generation from chunks |
| `thematic_analyzer.py` | Thematic analysis with local/online LLM |
| `bias_detector.py` | Cognitive bias detection (25+ types) |
| `claim_detector.py` | Claim extraction and classification |
| `frame_detector.py` | Implicit frame analysis |
| `simulacra_detector.py` | Simulacra level classification |
| `is_ought_detector.py` | Is-ought conflation analysis |
| `argument_mapper.py` | Argument structure mapping |
| `embedding_service.py` | Local/online embedding generation |
| `llm_config.py` | LLM configuration (env defaults + DB overrides) |
| `stt_config.py` | STT configuration (env defaults + DB overrides) |
| `stt_session.py` | WebSocket transcript session persistence |
| `audio_storage.py` | Audio chunk storage, WAV finalization |
| `local_llm_client.py` | LM Studio client for local LLM inference |

### Services — Hierarchical Themes (`services/hierarchical_themes/`)

| File | Purpose |
|------|---------|
| `level_1_clusterer.py` | Level 1 thematic clustering |
| `level_2_clusterer.py` | Level 2 thematic clustering |
| `level_3_clusterer.py` | Level 3 thematic clustering |
| `level_4_clusterer.py` | Level 4 thematic clustering |
| `level_5_atomic.py` | Level 5 atomic theme generation |

### Instrumentation (`instrumentation/`)

| File | Purpose |
|------|---------|
| `cost_calculator.py` | LLM API cost tracking with local model pricing |
| `decorators.py` | Instrumentation decorators |
| `middleware.py` | Request/response instrumentation middleware |
| `aggregation.py` | Metrics aggregation |
| `alerts.py` | Cost/performance alerting |

### Security and Configuration

| File | Purpose |
|------|---------|
| `middleware.py` | P0 security: auth, rate limits, SSRF gate, body size limits |
| `security_config.py` | Security utilities (CORS, headers, API key validation) — not currently wired |
| `.env.example` | Documented environment variable template |

### Tests (`tests/`)

| Directory | Purpose |
|-----------|---------|
| `unit/` | Unit tests (middleware, config, audio storage, LLM config) |
| `integration/` | Integration tests (WebSocket, Whisper smoke test) |
| `e2e/` | End-to-end tests |
| `fixtures/` | Test data fixtures |
| `conftest.py` | Shared pytest configuration |

## Frontend (`lct_app/`)

### Pages (`src/pages/`)

| File | Purpose |
|------|---------|
| `Home.jsx` | Landing page |
| `NewConversation.jsx` | Start new conversation flow |
| `ViewConversation.jsx` | Main conversation viewer (graph + timeline) |
| `Browse.jsx` | Browse past conversations |
| `Import.jsx` | Import conversations |
| `Settings.jsx` | Application settings (LLM, STT panels) |
| `Analytics.jsx` | Conversation analytics |
| `BiasAnalysis.jsx` | Cognitive bias detection view |
| `FrameAnalysis.jsx` | Frame/narrative analysis view |
| `SimulacraAnalysis.jsx` | Simulacra levels view |
| `CostDashboard.jsx` | LLM cost tracking |
| `Bookmarks.jsx` | Bookmark management |
| `EditHistory.jsx` | Edit history tracking |

### Components (`src/components/`)

| File/Directory | Purpose |
|----------------|---------|
| `AudioInput.jsx` | Live audio input with STT streaming |
| `audio/` | Audio utilities (PCM processing, STT utils, upload, effects) |
| `ContextualGraph.jsx` | Contextual network graph view |
| `StructuralGraph.jsx` | Structural graph view |
| `ThematicView.jsx` | Thematic visualization (976 LOC — refactor candidate) |
| `HorizontalTimeline.jsx` | Timeline component |
| `DualView/` | Dual-view layout components |
| `ZoomControls/` | Zoom interaction controls |
| `NodeDetailPanel/` | Node inspection panel |
| `LlmSettingsPanel.jsx` | LLM configuration UI |
| `SttSettingsPanel.jsx` | STT configuration UI |
| `ExportCanvas.jsx` | Export to Obsidian Canvas |
| `ImportCanvas.jsx` | Import from Obsidian Canvas |
| `Legend.jsx` | Graph legend |

### Services (`src/services/`)

| File | Purpose |
|------|---------|
| `apiClient.js` | Shared fetch wrapper with auth token support |
| `graphApi.js` | Graph generation/retrieval API client |
| `analyticsApi.js` | Analytics API client |
| `biasApi.js` | Bias detection API client |
| `frameApi.js` | Frame analysis API client |
| `simulacraApi.js` | Simulacra analysis API client |
| `editHistoryApi.js` | Edit history API client |
| `promptsApi.js` | Prompt management API client |
| `llmSettingsApi.js` | LLM settings API client |
| `sttSettingsApi.js` | STT settings API client |

## Documentation (`docs/`)

| File | Purpose |
|------|---------|
| `adr/INDEX.md` | ADR index with status and dates |
| `adr/ADR-001..009` | Architecture Decision Records |
| `PRODUCT_VISION.md` | Feature tiers and design philosophy |
| `ROADMAP.md` | 14-week implementation roadmap |
| `FEATURE_ROADMAP.md` | Feature prioritization framework |
| `DATA_MODEL_V2.md` | Database schema reference |
| `DATA_MODEL_V2_CORRECTIONS.md` | Schema corrections and extensions |
| `TECH_DEBT.md` | Known refactoring candidates |
| `WORKLOG.md` | Development change log |
| `plans/` | Implementation plans (option-b, refactoring, docs refresh, test coverage) |

## Known Tech Debt

See [docs/TECH_DEBT.md](TECH_DEBT.md) for the current list. Key items:

- `backend.py` (3545 LOC) — needs router extraction by domain
- `models.py` (714 LOC) — split by domain
- `ThematicView.jsx` (976 LOC) — split into view + hooks + subcomponents

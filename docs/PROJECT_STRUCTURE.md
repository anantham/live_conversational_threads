# Project Structure

Last updated: 2026-02-14

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
- `middleware.py`: auth/rate-limit/body-size/URL-import gates.
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

### Data and Services

- `models.py`: SQLAlchemy models.
- `db.py`, `db_session.py`, `db_helpers.py`: database access helpers.
- `alembic/`: migration history.
- `services/`: processing, provider clients, normalization, and orchestration.
- `instrumentation/`: cost/telemetry aggregation and alerting.
- `tests/`: unit and integration tests.

## Frontend (`lct_app/`)

### Entry and Pages

- `src/main.jsx`, `src/App.jsx`
- `src/pages/`: `Home.jsx`, `NewConversation.jsx`, `ViewConversation.jsx`, `Settings.jsx`, `Import.jsx`, etc.

### Core UI Areas

- `src/components/AudioInput.jsx` and `src/components/audio/*`: microphone capture + websocket transport.
- `src/components/ContextualGraph.jsx`, `src/components/StructuralGraph.jsx`: live graph rendering.
- `src/components/thematic/*`: thematic/zoom-specific components and hooks.
- `src/components/LlmSettingsPanel.jsx`, `src/components/SttSettingsPanel.jsx`: runtime provider settings UI.

### Frontend Services

- `src/services/apiClient.js`: base HTTP/WS client and auth header handling.
- `src/services/*Api.js`: feature-specific API wrappers.

## Documentation (`docs/`)

- `docs/adr/`: architecture decisions (ADR-001 through ADR-012 currently).
- `docs/plans/`: implementation plans and checklists.
- `docs/WORKLOG.md`: timestamped engineering log.
- `docs/TECH_DEBT.md`: large-file and architecture cleanup backlog.
- `docs/LOCAL_SETUP.md`: operational setup/runbook.

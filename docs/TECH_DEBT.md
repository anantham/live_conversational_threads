# TECH_DEBT

Last updated: 2026-02-09

Guidance: 300 LOC is a heuristic, not a hard gate. When touching large or mixed-concern files, log refactor candidates here.

| Path | LOC | Concern | Suggested split |
| --- | --- | --- | --- |
| ~~lct_python_backend/backend.py~~ | ~~3545~~ → 140 | **RESOLVED** — Split into 13 router modules + 4 shared modules. See `refactor/split-backend-monolith` branch. |
| lct_python_backend/services/llm_helpers.py | 501 | Extracted from backend.py; large LLM prompt inline | Consider moving prompt to separate file if it grows further |
| lct_python_backend/models.py | 714 | All ORM models in a single file | Split by domain (core, analysis, instrumentation, settings) |
| lct_python_backend/services/transcript_processing.py | 534 | Prompts, segmentation, and LLM IO coupled | Split into prompts, accumulator/decision, processor |
| lct_app/src/components/ThematicView.jsx | 976 | Large UI + data logic | Split into view layout, hooks, and subcomponents |
| lct_app/src/pages/Settings.jsx | 481 | Multiple settings panels in one file | Split into settings sections + shared layout |
| lct_app/src/pages/ViewConversation.jsx | 463 | Data fetching + UI composition mixed | Extract data hooks + presentational components |
| lct_app/src/components/AudioInput.jsx | 329 | Device capture, websocket transport, telemetry, and UI controls in one component | Split into `useAudioCapture`, `useTranscriptSockets`, and a thin presentational mic control |
| lct_python_backend/stt_api.py | 426 | Settings routes, telemetry aggregation, health probes, and websocket handling mixed together | Split into `stt_settings_router.py`, `stt_telemetry_service.py`, and `stt_stream_router.py` |
| lct_app/src/components/SttSettingsPanel.jsx | 370 | Form state, telemetry polling, health checks, and rendering tightly coupled | Extract `useSttTelemetry`, `useProviderHealthChecks`, and presentational subcomponents |
| lct_python_backend/import_api.py | 386 | URL/file import orchestration, parse/preview flow, and route adaptation still share one module after helper extraction | Further split parser/preview orchestration into a dedicated service and keep router as a thin adapter |
| ~~lct_python_backend/conversations_api.py~~ | ~~434~~ → 193 | **RESOLVED** — Extracted conversation read/serialization and turn synthesis into `conversation_reader.py` + `turn_synthesizer.py`, leaving a thin API adapter. |
| ~~lct_python_backend/factcheck_api.py~~ | ~~355~~ → 89 | **RESOLVED** — Extracted provider normalization/orchestration and cost aggregation into `factcheck_service.py` + `cost_stats_service.py`; router is now a thin adapter. |
| ~~lct_python_backend/graph_api.py~~ | ~~469~~ → 244 | **RESOLVED** — Split generation + query/serialization concerns into `graph_generation_service.py` and `graph_query_service.py`. |
| ~~lct_python_backend/instrumentation/decorators.py~~ | ~~423~~ → 265 | **RESOLVED** — Extracted response parsing + DB mapping into helper modules and reduced `decorators.py` to wrapper-focused behavior. |
| ~~lct_python_backend/instrumentation/aggregation.py~~ | ~~466~~ → 213 | **RESOLVED** — Split query execution, rollup math, and reporting into `cost_queries.py`, `cost_rollups.py`, and `cost_reporting.py`. |
| lct_python_backend/instrumentation/alerts.py | 373 | Alert rule definitions, evaluation engine, and channel handlers all live in one module | Split into `alert_rules.py`, `alert_manager.py`, and `alert_handlers.py` |
| lct_python_backend/bookmarks_api.py | 470 | Bookmark CRUD, query filtering, and serialization are tightly coupled in one router module | Split into `bookmark_service.py` for persistence/query logic and keep API module route-only |
| lct_python_backend/cost_api.py | 344 | Endpoint orchestration and response shaping are mixed in one module | Split route handlers from response/adapter layer and shared query parameter parsing helpers |

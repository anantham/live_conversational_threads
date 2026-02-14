# TECH_DEBT

Last updated: 2026-02-14

Guidance: 300 LOC is a heuristic, not a hard gate. When touching large or mixed-concern files, log refactor candidates here.

| Path | LOC | Concern | Suggested split |
| --- | --- | --- | --- |
| ~~lct_python_backend/backend.py~~ | ~~3545~~ → 140 | **RESOLVED** — Split into 13 router modules + 4 shared modules. See `refactor/split-backend-monolith` branch. |
| lct_python_backend/services/llm_helpers.py | 501 | Extracted from backend.py; large LLM prompt inline | Consider moving prompt to separate file if it grows further |
| lct_python_backend/models.py | 714 | All ORM models in a single file | Split by domain (core, analysis, instrumentation, settings) |
| lct_python_backend/services/transcript_processing.py | 975 | Prompt templates, output normalization, segmentation, provider/key fallback, and LLM IO are tightly coupled | Split into `transcript_prompts.py`, `graph_output_normalizer.py`, `llm_provider_router.py`, and `transcript_accumulator.py` with `TranscriptProcessor` as orchestrator |
| ~~lct_app/src/components/ThematicView.jsx~~ | ~~976~~ → 267 | **RESOLVED** — Extracted 3 hooks (`useThematicLevels`, `useThematicGraph`, `useThematicKeyboard`), 3 subcomponents (`LevelSelector`, `ThematicSettingsPanel`, `UtteranceDetailPanel`), and shared constants into `components/thematic/`. Root is now a thin orchestrator. |
| lct_app/src/pages/Settings.jsx | 481 | Multiple settings panels in one file | Split into settings sections + shared layout |
| lct_app/src/pages/ViewConversation.jsx | 463 | Data fetching + UI composition mixed | Extract data hooks + presentational components |
| ~~lct_app/src/components/AudioInput.jsx~~ | ~~329~~ → 137 | **RESOLVED** — Extracted `useTranscriptSockets` (233 LOC) and `useAudioCapture` (69 LOC) hooks; AudioInput is now a thin orchestrator. |
| ~~lct_python_backend/stt_api.py~~ | ~~426~~ → 264 | **RESOLVED** — Extracted `stt_settings_service.py` (38 LOC), `stt_telemetry_service.py` (107 LOC), and `stt_health_service.py` (72 LOC); router keeps audio upload + websocket + backward-compat wrappers. |
| lct_python_backend/stt_api.py | 747 | Backend-owned STT websocket now combines session orchestration, realtime routing, persistence, telemetry, async flush orchestration, and compatibility paths | Re-split websocket handler into focused modules (`stt_ws_session.py`, `stt_ws_message_router.py`, `stt_event_persistence.py`) while keeping router thin |
| lct_app/src/components/ContextualGraph.jsx | 832 | Graph rendering, edge styling/hover UX, context cards, transcript view, bookmark/fact-check interactions, and panel state are mixed in one component | Split into `useContextualGraphLayout`, `ContextCard`, `TranscriptCard`, and `ClaimsDrawer`; keep container focused on orchestration |
| ~~lct_app/src/components/SttSettingsPanel.jsx~~ | ~~370~~ → 310 | **RESOLVED** — Extracted `useSttTelemetry` (35 LOC) and `useProviderHealthChecks` (46 LOC) hooks; panel keeps form state + JSX rendering. |
| ~~lct_python_backend/import_api.py~~ | ~~386~~ → 290 | **RESOLVED** — Extracted `import_orchestrator.py` (142 LOC) consolidating duplicate parse→validate→persist flow. Router keeps Pydantic models + backward-compat wrappers. |
| ~~lct_python_backend/conversations_api.py~~ | ~~434~~ → 193 | **RESOLVED** — Extracted conversation read/serialization and turn synthesis into `conversation_reader.py` + `turn_synthesizer.py`, leaving a thin API adapter. |
| ~~lct_python_backend/factcheck_api.py~~ | ~~355~~ → 89 | **RESOLVED** — Extracted provider normalization/orchestration and cost aggregation into `factcheck_service.py` + `cost_stats_service.py`; router is now a thin adapter. |
| ~~lct_python_backend/graph_api.py~~ | ~~469~~ → 244 | **RESOLVED** — Split generation + query/serialization concerns into `graph_generation_service.py` and `graph_query_service.py`. |
| ~~lct_python_backend/instrumentation/decorators.py~~ | ~~423~~ → 265 | **RESOLVED** — Extracted response parsing + DB mapping into helper modules and reduced `decorators.py` to wrapper-focused behavior. |
| ~~lct_python_backend/instrumentation/aggregation.py~~ | ~~466~~ → 213 | **RESOLVED** — Split query execution, rollup math, and reporting into `cost_queries.py`, `cost_rollups.py`, and `cost_reporting.py`. |
| lct_python_backend/instrumentation/alerts.py | 373 | Alert rule definitions, evaluation engine, and channel handlers all live in one module | Split into `alert_rules.py`, `alert_manager.py`, and `alert_handlers.py` |
| ~~lct_python_backend/bookmarks_api.py~~ | ~~470~~ → 204 | **RESOLVED** — Extracted `bookmark_service.py` (155 LOC) with CRUD ops, serializer (eliminated 5× duplication), and UUID helper. Router is now a thin adapter. |
| ~~lct_python_backend/cost_api.py~~ | ~~344~~ → 338 | **RESOLVED** — Already a thin router delegating to instrumentation layer. Fixed `get_db()` stub to use `get_async_session`. No structural decomposition needed. |

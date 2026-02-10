# WORKLOG

## 2026-02-10T09:00:00Z — refactor: decompose ThematicView.jsx (976 → 267 LOC)

**Target:** `lct_app/src/components/ThematicView.jsx` — 976 LOC with 8 tangled concerns (level conversion, polling, graph generation, settings UI, utterance panel, keyboard shortcuts, node interaction, formatting).

**Extracted files (all in `components/thematic/`):**
- `thematicConstants.js` (80 LOC): Level maps, colors, node type colors, font size classes, available models, `formatTimestamp()`, `getDetailLevelFromZoom()`
- `useThematicLevels.js` (170 LOC): Level state, polling `/themes/levels` every 5s, data fetching, navigation (prev/next/jump), `clearLevelCache()` for regeneration
- `useThematicGraph.jsx` (265 LOC): Dagre layout + ReactFlow node/edge generation (~224 LOC useMemo), `selectedNodeData` and `selectedNodeUtterances` memos, utterance-highlight matching
- `useThematicKeyboard.js` (48 LOC): Keys 0-5 jump, +/- navigate, input/textarea guard
- `LevelSelector.jsx` (91 LOC): Level navigation bar with prev/next buttons and numbered level buttons
- `ThematicSettingsPanel.jsx` (108 LOC): Font size, granularity slider, model selection, regenerate button
- `UtteranceDetailPanel.jsx` (93 LOC): Bottom panel showing utterances for selected thematic node

**Root `ThematicView.jsx` (267 LOC):** Thin orchestrator importing hooks + subcomponents. Keeps: local UI state (`hoveredNode`, `showSettings`, `isRegenerating`, `showUtterancePanel`, `settings`), `handleRegenerate`, node click/hover handlers, ReactFlow JSX, empty state check.

**Validation:** `npx vite build` — clean build (2158 modules, 7.97s). No consumer changes needed (`ViewConversation.jsx` unchanged).

**Note:** `useThematicGraph` required `.jsx` extension (contains JSX node labels inside useMemo — standard ReactFlow data pattern, but Vite requires explicit JSX extension).

## 2026-02-10T06:00:00Z — refactor: split stt_api.py, AudioInput.jsx, SttSettingsPanel.jsx

**Phase A — Backend `stt_api.py` (426 → 264 LOC)**
- `lct_python_backend/services/stt_settings_service.py` (38 LOC, NEW): Extracted `load_stt_settings()` and `save_stt_settings()` from inline DB logic in `stt_api.py`.
- `lct_python_backend/services/stt_telemetry_service.py` (107 LOC, NEW): Extracted `aggregate_telemetry()` with helpers `_to_float()`, `_utc_iso_now()`, `_empty_provider_bucket()` from `read_stt_telemetry` route body.
- `lct_python_backend/services/stt_health_service.py` (72 LOC, NEW): Extracted `derive_health_url()` and `probe_health_url()` with all `urllib` imports from router.
- `lct_python_backend/stt_api.py` (264 LOC): Thin router with audio upload, websocket handler, and backward-compat wrappers (`_load_stt_settings`, `_probe_health_url`) preserving existing monkeypatch targets in `test_stt_api_settings.py`.
- Validation: `pytest tests/unit/test_stt_api_settings.py tests/unit/test_stt_config.py` — 7 passed.

**Phase B — Frontend `AudioInput.jsx` (329 → 137 LOC)**
- `lct_app/src/components/audio/useTranscriptSockets.js` (233 LOC, NEW): Owns all WebSocket refs, telemetry tracking, chunk queue, `logToServer()`, `startSession()`, `stopSession()`, `onPCMFrame()` callback.
- `lct_app/src/components/audio/useAudioCapture.js` (69 LOC, NEW): Owns MediaStream/AudioContext/ScriptProcessor lifecycle, `startCapture()`, `stopCapture()`.
- `lct_app/src/components/AudioInput.jsx` (137 LOC): Thin orchestrator connecting `useTranscriptSockets` + `useAudioCapture` + existing `useAudioInputEffects` hooks. Renders mic button.
- Validation: `npm run build` — passed.

**Phase C — Frontend `SttSettingsPanel.jsx` (370 → 310 LOC)**
- `lct_app/src/components/audio/useSttTelemetry.js` (35 LOC, NEW): Owns telemetry state, polling interval, loading/error state.
- `lct_app/src/components/audio/useProviderHealthChecks.js` (46 LOC, NEW): Owns per-provider health check state with checking/result/error.
- `lct_app/src/components/SttSettingsPanel.jsx` (310 LOC): Keeps form state + JSX rendering, consumes extracted hooks.
- Validation: `npm run build` — passed.

**Full suite validation:**
- Backend: `pytest -q` — 186 passed, 3 skipped (pre-existing `test_graph_generation.py` import error unrelated to this work).
- Frontend: `npm run build` — passed.
- `docs/TECH_DEBT.md`: Marked all 3 entries as resolved with LOC before/after.

## 2026-02-10T02:24:31Z — refactor: fact-check + graph router decomposition, warning-debt cleanup
- `lct_python_backend/factcheck_api.py` (lines 1-89): Reduced to thin router adapter with compatibility wrappers (`_parse_time_range_to_start`, `_aggregate_cost_logs`, `generate_fact_check_json_perplexity`) to preserve existing test and import behavior.
- `lct_python_backend/services/factcheck_service.py` (lines 1-202): Extracted Perplexity integration, response JSON extraction, verdict/citation normalization, and unverified fallback shaping.
- `lct_python_backend/services/cost_stats_service.py` (lines 1-88): Extracted time-range parsing, cost aggregation payload shaping, and DB log query helper for `/api/cost-tracking/stats`.
- `lct_python_backend/graph_api.py` (lines 1-244): Reduced to route adapter with compatibility wrappers (`_is_temporal_relationship`, `_build_turn_based_nodes`, `_build_temporal_edge_payload`) and delegated query/generation concerns.
- `lct_python_backend/services/graph_generation_service.py` (lines 1-177): Extracted turn-node generation, temporal edge construction, conversation/utterance fetch, and persistence replacement workflow.
- `lct_python_backend/services/graph_query_service.py` (lines 1-133): Extracted conversation UUID parsing, relationship classification/filtering, node/edge serialization payload helpers, and query loaders.
- Warning-debt cleanup:
  - `lct_python_backend/models.py` (line 11): Migrated `declarative_base` import to `sqlalchemy.orm.declarative_base` to remove SQLAlchemy 2.x deprecation warning.
  - `lct_python_backend/import_api.py` (lines 17, 46): Migrated Pydantic class-based config to `ConfigDict`.
  - `lct_python_backend/cost_api.py` (lines 15, 42, 57): Migrated Pydantic class-based config to `ConfigDict`.
  - `lct_python_backend/bookmarks_api.py` (lines 19, 66): Migrated Pydantic class-based config to `ConfigDict`.
- `docs/TECH_DEBT.md` (lines 21-28): Marked `factcheck_api.py` and `graph_api.py` as resolved; added follow-up entries for `bookmarks_api.py` and `cost_api.py`.
- Validation run:
  - `python3 -m py_compile lct_python_backend/factcheck_api.py lct_python_backend/services/factcheck_service.py lct_python_backend/services/cost_stats_service.py lct_python_backend/graph_api.py lct_python_backend/services/graph_generation_service.py lct_python_backend/services/graph_query_service.py lct_python_backend/models.py lct_python_backend/import_api.py lct_python_backend/cost_api.py lct_python_backend/bookmarks_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_factcheck_cost_stats.py tests/unit/test_graph_api_contract.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py tests/unit/test_middleware.py` (50 passed, only LibreSSL warning remains)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (26 passed, only LibreSSL warning remains)

## 2026-02-09T19:30:21Z — refactor: import/conversation decomposition + instrumentation logging cleanup
- `lct_python_backend/import_api.py` (lines 1-386): Reduced router concerns by delegating URL/file validation, fetch logic, and DB persistence while preserving route contracts and backwards-compatible helper wrappers (`_validate_import_url`, `_is_url_import_enabled`, `_download_url_text`) used by tests.
- `lct_python_backend/services/import_validation.py` (lines 1-88): Added URL/filename validation helpers and import capability helpers.
- `lct_python_backend/services/import_fetchers.py` (lines 1-63): Added bounded URL download + temp upload persistence helpers.
- `lct_python_backend/services/import_persistence.py` (lines 1-71): Added shared conversation/utterance persistence path to remove duplicated DB write logic across import routes.
- `lct_python_backend/conversations_api.py` (lines 1-193): Reduced to thin API adapter with shared conversation-read/turn-synthesis service delegation and structured logging.
- `lct_python_backend/services/conversation_reader.py` (lines 1-132): Added conversation DB fetch bundle, relationship maps, analyzed-node serialization, chunk dict creation, and utterance serializer helpers.
- `lct_python_backend/services/turn_synthesizer.py` (lines 1-93): Added reusable speaker-turn graph synthesis helpers for conversations lacking analyzed nodes.
- `lct_python_backend/instrumentation/alerts.py` (lines 10-373): Replaced console prints with logger-based delivery/handler logging.
- `lct_python_backend/instrumentation/middleware.py` (lines 11-236): Replaced print-based request/error logging with structured logger output.
- `lct_python_backend/instrumentation/cost_reporting.py` (lines 5-97): Replaced background-job prints with logger output.
- `docs/TECH_DEBT.md` (lines 19-26): Updated `import_api.py` LOC/debt status after decomposition, marked `conversations_api.py` as resolved, and logged `instrumentation/alerts.py` as a new large-file decomposition candidate.
- Validation run:
  - `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/conversations_api.py lct_python_backend/services/import_validation.py lct_python_backend/services/import_fetchers.py lct_python_backend/services/import_persistence.py lct_python_backend/services/conversation_reader.py lct_python_backend/services/turn_synthesizer.py lct_python_backend/instrumentation/alerts.py lct_python_backend/instrumentation/middleware.py lct_python_backend/instrumentation/cost_reporting.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py tests/unit/test_middleware.py` (44 passed)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (26 passed)

## 2026-02-09T18:00:41Z — refactor: split instrumentation decorators + aggregation modules
- `lct_python_backend/instrumentation/decorators.py` (lines 1-265): Reduced to wrapper-focused module, preserving public API (`APICallTracker`, `track_api_call`, `set_db_connection`, `get_tracker`) while delegating response parsing and DB mapping concerns.
- `lct_python_backend/instrumentation/response_parsing.py` (lines 1-80): Added normalized response parsing helpers for object/dict provider responses and token extraction (`ParsedResponseMetrics`, `parse_response_metrics`).
- `lct_python_backend/instrumentation/cost_tracking_mapper.py` (lines 1-133): Added mapping helpers for in-memory log payloads and `APICallsLog` record construction, including UUID/provider normalization and cost-breakdown mapping.
- `lct_python_backend/instrumentation/aggregation.py` (lines 1-213): Reduced to façade API (`CostAggregator`, `CostReporter`, `run_daily_aggregation_job` imports) while delegating query math and reporting helpers.
- `lct_python_backend/instrumentation/cost_queries.py` (lines 1-93): Added DB query functions for period, conversation, and top-conversation cost reads.
- `lct_python_backend/instrumentation/cost_rollups.py` (lines 1-152): Added pure rollup models/functions (`CostAggregation`, `ConversationCost`, `empty_cost_aggregation`, rollup helpers).
- `lct_python_backend/instrumentation/cost_reporting.py` (lines 1-94): Added report rendering and daily aggregation background job helper.
- `docs/TECH_DEBT.md` (lines 23-24): Marked `decorators.py` and `aggregation.py` tech-debt entries as resolved after decomposition and LOC reduction.
- Validation run:
  - `cd lct_python_backend && python3 -m py_compile instrumentation/decorators.py instrumentation/aggregation.py instrumentation/response_parsing.py instrumentation/cost_tracking_mapper.py instrumentation/cost_queries.py instrumentation/cost_rollups.py instrumentation/cost_reporting.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py` (16 passed)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (43 passed)

## 2026-02-09T17:53:23Z — fix: instrumentation `APICallsLog` schema alignment
- `lct_python_backend/instrumentation/decorators.py` (lines 13-47, 67-175, 234, 345): Replaced stale `APICallLog` persistence mapping with current `APICallsLog` fields (`started_at`, `completed_at`, `status`, `total_cost`, token/cost breakdown columns, `request_id`) and added provider/UUID normalization helpers plus timezone-aware timestamps.
- `lct_python_backend/instrumentation/aggregation.py` (lines 17-20, 168-178, 257-297, 319-340): Updated aggregation queries to use current model/field names (`APICallsLog`, `started_at`, `status == "success"`, `total_cost`) and removed old `timestamp/success/cost_usd` assumptions.
- `lct_python_backend/tests/unit/test_instrumentation_schema_alignment.py` (lines 1-127): Added focused unit tests verifying decorator-to-model field mapping and aggregator consumption of `started_at`/`total_cost`.
- `docs/TECH_DEBT.md` (lines 23-24): Refreshed instrumentation module LOC snapshots after this pass.
- Validation run:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py` (16 passed)
  - `cd lct_python_backend && python3 -m py_compile instrumentation/decorators.py instrumentation/aggregation.py`
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (43 passed)

## 2026-02-09T17:46:13Z — fix: graph API made operational and mounted
- `lct_python_backend/graph_api.py` (lines 1-499): Replaced broken placeholder implementation with model-consistent graph API:
  - Switched to real DB dependency (`get_async_session`) and fixed ORM field mapping (`node_name`, `timestamp_start/end`, `from_node_id/to_node_id`, `explanation`).
  - Added `include_edges` support on `GET /api/graph/{conversation_id}` and stable empty-graph responses (200 with zero nodes/edges) instead of hard failures.
  - Implemented working `POST /api/graph/generate` fallback generation from speaker turns + temporal edges with optional DB persistence.
  - Implemented working `DELETE /api/graph/{conversation_id}` for graph cleanup.
  - Kept frontend-compatible payload contract (`title`, `keywords`, `description`, `metadata`, canvas coordinates).
- `lct_python_backend/backend.py` (lines 125, 140): Mounted `graph_router` so `/api/graph/*` endpoints are now reachable.
- `lct_python_backend/tests/unit/test_graph_api_contract.py` (lines 1-109): Added focused unit coverage for temporal classification, speaker-turn grouping, and empty graph endpoint payload contract.
- `docs/TECH_DEBT.md` (line 22): Logged `graph_api.py` as a large mixed-concern refactor candidate after this repair pass.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (17 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile graph_api.py backend.py factcheck_api.py import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:28:00Z — fix: cost dashboard endpoint now uses real `api_calls_log` aggregation
- `lct_python_backend/factcheck_api.py` (lines 127-188): Added `_parse_time_range_to_start(...)` and `_aggregate_cost_logs(...)` helpers to normalize time-range handling and return dashboard-compatible aggregate payloads from real log rows.
- `lct_python_backend/factcheck_api.py` (lines 321-355): Replaced mock `/api/cost-tracking/stats` response with live DB query (`APICallsLog` filtered by `status="success"` and optional time window), plus explicit 400 on invalid time range and structured server-side logging on failures.
- `lct_python_backend/tests/unit/test_factcheck_cost_stats.py` (lines 1-74): Added unit coverage for time-range parsing and cost aggregation payload shape using stubbed module import.
- `docs/TECH_DEBT.md` (line 21): Logged `factcheck_api.py` as a decomposition candidate after crossing the large-file heuristic with mixed concerns.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (14 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile factcheck_api.py import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:24:23Z — fix: URL import capability parity + relationship hydration
- `lct_python_backend/import_api.py` (lines 101-189, 481-501, 566-579): Added URL-import capability helpers (`_is_url_import_enabled`, `_validate_import_url`, `_download_url_text`) with host/scheme guards, bounded async fetch, and explicit defense-in-depth gate in `/api/import/from-url`.
- `lct_python_backend/import_api.py` (lines 669-683): Updated `/api/import/health` to report `url_import_enabled` and dynamic `supported_formats` so frontend can reflect deployment capability.
- `lct_app/src/pages/Import.jsx` (lines 15-43, 83-98, 156-186): Added import-health capability load, disabled URL mode when backend gate is off, and added explicit UX messaging for disabled URL import.
- `lct_python_backend/conversations_api.py` (lines 19-53, 95-170): Added `_build_relationship_maps` and wired `Relationship` query into conversation payload generation so `contextual_relation` and `linked_nodes` are no longer placeholder empties for analyzed nodes.
- `lct_python_backend/tests/unit/test_import_api_security.py` (lines 1-64): Added unit coverage for URL validation and import-health capability reporting using stubbed module import.
- `lct_python_backend/tests/unit/test_conversations_api_relationship_maps.py` (lines 1-78): Added unit coverage for temporal/contextual relationship mapping and bidirectional link behavior.
- `docs/TECH_DEBT.md` (lines 19-20): Logged `import_api.py` and `conversations_api.py` as decomposition candidates after touching >300 LOC mixed-concern files.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (11 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:16:38Z — refactor: frontend auth/env consistency pass (P1)
- `lct_app/src/pages/Import.jsx`, `lct_app/src/pages/Browse.jsx`, `lct_app/src/pages/Bookmarks.jsx`, `lct_app/src/components/ImportCanvas.jsx`, `lct_app/src/components/ExportCanvas.jsx`, `lct_app/src/components/GenerateFormalism.jsx`, `lct_app/src/pages/CostDashboard.jsx`, `lct_app/src/utils/SaveConversation.jsx`, `lct_app/src/components/Input.jsx`, `lct_app/src/components/ContextualGraph.jsx`, `lct_app/src/pages/ViewConversation.jsx`, `lct_app/src/components/ThematicView.jsx` (file-level updates): Replaced hardcoded backend URLs/raw fetch with shared `apiFetch` so auth token/base URL behavior is consistent across app surfaces.
- `lct_app/src/components/audio/sttUtils.js` (lines 1-20): Switched API/WS construction to shared `API_BASE_URL` + `wsUrl(...)` to keep websocket token behavior aligned with HTTP auth mode.
- `lct_app/src/components/audio/audioUpload.js` (lines 1-80): Added `apiHeaders(...)` for chunk upload/finalize requests so AUTH_TOKEN deployments can persist opt-in audio storage without silent 401s.

## 2026-02-09T17:05:53Z — fix: P0 route alignment + fact-check endpoint hardening
- `lct_app/src/components/ImportCanvas.jsx` (line 65): Updated post-import navigation from `/view/{id}` to `/conversation/{id}` to match router paths and prevent dead-link redirects.
- `lct_app/src/pages/Bookmarks.jsx` (line 81): Updated bookmark navigation from `/view/{id}` to `/conversation/{id}` so "View in Conversation" opens the correct page.
- `lct_python_backend/factcheck_api.py` (lines 1-233): Replaced broken undefined function path with a concrete async Perplexity integration and safe fallback behavior:
  - Added provider call via `httpx` with structured JSON prompt/response handling.
  - Added robust JSON extraction + citation normalization for schema-safe responses.
  - Added explicit unverified fallback when API key is missing, provider errors occur, or response parsing fails.
  - Switched endpoint call to `await generate_fact_check_json_perplexity(...)` to avoid runtime `NameError` and keep UI flow stable.
- Validation run:
  - `python3 -m py_compile lct_python_backend/factcheck_api.py`
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:00:00Z — refactor: split backend.py monolith (3549 → 140 LOC)
- **lct_python_backend/backend.py** (3549 → 140 LOC): Reduced to app shell — logging, app creation, CORS, middleware, 13 router mounts. All inline route handlers, Pydantic models, and helper functions extracted.
- **lct_python_backend/config.py** (20 LOC): New — env constants (API keys, GCS, audio paths) extracted from backend.py.
- **lct_python_backend/schemas.py** (71 LOC): New — 16 shared Pydantic models extracted from backend.py.
- **lct_python_backend/services/gcs_helpers.py** (76 LOC): New — `save_json_to_gcs`, `load_conversation_from_gcs` extracted from backend.py.
- **lct_python_backend/services/llm_helpers.py** (501 LOC): New — `claude_llm_call`, `generate_lct_json_claude`, `stream_generate_context_json`, `sliding_window_chunking`, `generate_formalism`, etc.
- **lct_python_backend/conversations_api.py** (397 LOC): New — 4 routes: list/get/delete conversations, get utterances.
- **lct_python_backend/generation_api.py** (122 LOC): New — 4 routes: chunks, stream, save_json, formalism.
- **lct_python_backend/canvas_api.py** (647 LOC): New — 2 routes + 5 Pydantic models + 2 converter functions for Obsidian Canvas export/import.
- **lct_python_backend/thematic_api.py** (485 LOC): New — 3 routes + 2 background task helpers for hierarchical thematic analysis.
- **lct_python_backend/prompts_api.py** (256 LOC): New — 10 routes for prompts CRUD.
- **lct_python_backend/edit_history_api.py** (259 LOC): New — 5 routes for node updates, edits, training data export.
- **lct_python_backend/factcheck_api.py** (127 LOC): New — 3 routes for fact-check, audio download, cost stats.
- **lct_python_backend/analysis_api.py** (220 LOC): New — 9 routes for simulacra/bias/frame analysis. **Bug fix**: replaced broken `get_session()` with `get_async_session_context()` (routes were previously non-functional).
- **lct_python_backend/analytics_api.py** (157 LOC): Fixed broken imports, now mounted.
- ~240 LOC of commented-out dead code removed from backend.py.
- docs/TECH_DEBT.md: Marked backend.py entry as resolved.

## 2025-11-29T20:12:50Z
- lct_app/ZOOM_SYSTEM.md (lines 3-5): Bumped version to 2.1 and refreshed Last Updated to reflect the semantic-level selector addendum.
- lct_app/ZOOM_SYSTEM.md (lines 17-27): Added addendum documenting the explicit semantic level selector, availability-aware controls, and decoupled zoom behavior in Thematic View.
- lct_app/ZOOM_SYSTEM.md (lines 361-413): Updated keyboard shortcut documentation to the current `1-5` and `+/-` mapping while retaining the legacy ZoomControls reference.
- lct_app/ZOOM_SYSTEM.md (lines 755-766): Added changelog entry v2.1 capturing the semantic-level UI update and zoom/level decoupling notes.
- docs/WORKLOG.md: Created log to track documentation and implementation changes going forward.

## 2026-01-11T20:21:56Z
- Pre-flight note: preparing Option B migration (new `/ws/transcripts`, local STT providers, transcript event storage, audio opt-in), minimal split of `lct_app/src/components/AudioInput.jsx`, and settings storage (env defaults + DB override). Line numbers to be recorded after implementation.

## 2026-01-11T20:38:46Z
- docs/plans/2026-01-11-refactoring-splitting-roadmap.md (lines 1-116): Drafted refactor and file-splitting roadmap with module boundaries, naming conventions, phases, and metrics.
- docs/plans/2026-01-11-documentation-refresh.md (lines 1-63): Drafted documentation refresh plan covering structure, ADRs, config, and API references.
- docs/plans/2026-01-11-test-coverage-plan.md (lines 1-58): Drafted test coverage improvement plan covering unit, integration, and golden dataset evaluation.

## 2026-01-12T05:22:54Z
- docs/plans/2026-01-12-option-b-implementation-plan.md (lines 1-97): Captured Option B migration design (local STT, settings storage, transcript events, audio chunk uploads, frontend refactor, tests, ADR outcomes) for confirmation before coding.

## 2026-01-12T05:44:04Z
- lct_python_backend/stt_api.py: Added the new `/ws/transcripts`, settings API, and chunked audio endpoints with per-message persistence and session metadata handling plus 410 redirect for `/ws/audio`.
- lct_python_backend/services/{audio_storage.py,stt_config.py}: Added an audio chunk manager and STT configuration helpers plus new models/migrations (`AppSetting`, `TranscriptEvent`, `add_transcript_events_and_settings`) so transcripts are append-only and configured via env/DB.
- lct_python_backend/models.py: Extended the schema with `app_settings` + `transcript_events` to persist STT overrides and each partial/final transcript event (timestamps + metadata).
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py: Created the migration for the new tables plus indexes/constraints.
- lct_app/src/components/audio/pcm.js & AudioInput.jsx: Reworked the live audio component to stream to the local STT provider, forward transcripts to `/ws/transcripts`, queue chunk uploads, and finalize audio storage if opt-in.
- lct_app/src/components/SttSettingsPanel.jsx & lct_app/src/services/sttSettingsApi.js: Added a UI + API for configuring provider endpoints, audio storage toggles, and retention defaults.
- docs/adr/ADR-008-local-stt-transcripts.md: Documented the architecture decision that introduces local STT + append-only transcript events plus opt-in audio storage.
- lct_python_backend/tests/unit/test_stt_config.py: Added a unit test for STT config merging (env defaults + overrides).

## 2026-01-14T00:27:26Z
- lct_python_backend/services/llm_config.py (lines 1-62): Added env + DB LLM configuration defaults (local/online mode, base URL, chat/embedding model, JSON mode, timeout) with sanitization.
- lct_python_backend/services/local_llm_client.py (lines 1-146): Added LM Studio client helpers, response JSON extraction, and cached local client factory.
- lct_python_backend/llm_api.py (lines 1-45): Added `/api/settings/llm` GET/PUT endpoints to persist LLM config overrides.
- lct_python_backend/services/transcript_processing.py (lines 21-432, 440-520): Extracted prompt constants, added local LLM accumulation + generation paths, and injected LLM config into `TranscriptProcessor`.
- lct_python_backend/stt_api.py (lines 29, 282-283): Loaded LLM config per websocket session to drive local transcript processing.
- lct_python_backend/backend.py (lines 68-131, 655): Wired LLM settings router and switched stream generation to local-aware JSON generation.
- lct_python_backend/services/embedding_service.py (lines 14-171): Added local embedding generation and config-aware OpenAI fallback.
- lct_python_backend/services/argument_mapper.py (lines 25, 158-208): Added local LLM path for argument mapping with online fallback.
- lct_python_backend/services/bias_detector.py (lines 24, 264-316): Added local LLM path for bias analysis with online fallback.
- lct_python_backend/services/claim_detector.py (lines 24, 123-231): Added local LLM path for claim extraction and config-aware embedding generation.
- lct_python_backend/services/frame_detector.py (lines 25, 276-320): Added local LLM path for frame detection with online fallback.
- lct_python_backend/services/is_ought_detector.py (lines 29, 182-228): Added local LLM path for is-ought conflation analysis with online fallback.
- lct_python_backend/services/simulacra_detector.py (lines 23, 163-216): Added local LLM path for simulacra detection with online fallback.
- lct_python_backend/services/thematic_analyzer.py (lines 21, 158-232): Added local LLM path for thematic analysis and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_1_clusterer.py (lines 15, 154-216): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_2_clusterer.py (lines 15, 154-219): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_3_clusterer.py (lines 15, 154-219): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_4_clusterer.py (lines 15, 154-221): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_5_atomic.py (lines 17, 118-181): Added local atomic-theme generation path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/graph_generation.py (lines 19, 183-208, 233-246): Added local LLM fallback and dict response parsing.
- lct_python_backend/services/__init__.py (lines 3-7): Removed eager GraphGenerationService export to avoid heavyweight imports.
- lct_python_backend/graph_api.py (line 16): Imported GraphGenerationService directly to avoid service package side effects.
- lct_python_backend/instrumentation/cost_calculator.py (lines 86-148): Added zero-cost pricing entries for local chat + embedding models and local fallback detection.
- lct_app/src/services/llmSettingsApi.js (lines 1-21): Added frontend API client for LLM settings.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 1-204): Added LLM settings UI with mode toggle and chat/embedding model dropdowns.
- lct_app/src/pages/Settings.jsx (lines 25, 476): Wired LLM settings panel into settings page.
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 1-70): Added optional Whisper WebSocket smoke test for local streaming verification.
- lct_python_backend/tests/README.md (line 52): Documented Whisper WS smoke test environment flags.
- docs/adr/ADR-009-local-llm-defaults.md (lines 1-33): Documented local-first LLM decision with online mode opt-in.
- docs/plans/2026-01-11-refactoring-splitting-roadmap.md (lines 31-35, 43): Updated monolith list to include new hotspots and current LOC.

## 2026-01-14T00:43:28Z
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 42-78): Added streaming speed and ping configuration to stabilize the optional Whisper WS smoke test.
- lct_python_backend/tests/README.md (line 52): Documented the additional Whisper WS smoke test environment flags.

## 2026-01-14T01:29:16Z
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 9-118): Hardened the Whisper WS smoke test for raw PCM (WAV header guard), optional skip seconds, max seconds, stop-on-text behavior, and longer timeouts.
- lct_python_backend/tests/README.md (line 52): Documented the new Whisper WS smoke test environment flags.

## 2026-01-14T03:36:56Z
- lct_app/src/components/AudioInput.jsx (lines 1-296): Split out settings/effects/messages/upload helpers to reduce file size while keeping the live audio flow unchanged.
- lct_app/src/components/audio/sttUtils.js (lines 1-35): Centralized STT URLs and path helpers for AudioInput.
- lct_app/src/components/audio/audioUpload.js (lines 1-78): Extracted chunk upload/finalize logic for audio storage.
- lct_app/src/components/audio/audioMessages.js (lines 1-80): Extracted provider/backend WebSocket message handling.
- lct_app/src/components/audio/useAudioInputEffects.js (lines 1-80): Extracted filename, graph sync, auto-save, and message-dismiss effects.
- lct_app/src/components/audio/useSttSettings.js (lines 1-27): Extracted STT settings fetch + error state hook.
- lct_python_backend/services/stt_session.py (lines 1-147): Moved transcript session persistence helpers out of the router.
- lct_python_backend/stt_api.py (lines 1-199): Simplified router to use shared STT session helpers.

## 2026-01-14T05:57:58Z
- lct_python_backend/services/audio_storage.py (lines 58-107): Guarded PCM cleanup behind successful WAV writes and corrected FFmpeg invocation to treat WAV as input.
- .gitignore (lines 185-186): Restored `.venv/` ignore to avoid committing local virtual environments.

## 2026-01-14T06:25:37Z
- lct_python_backend/tests/unit/test_audio_storage.py (lines 1-52): Added async coverage for WAV failure cleanup and FFmpeg WAV input usage.
- lct_python_backend/tests/unit/test_llm_config.py (lines 1-28): Added LLM env default + merge sanitization tests.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 1-89): Added WebSocket test to confirm partial/final transcript persistence and flush ack.

## 2026-01-14T08:55:11Z
- lct_python_backend/models.py (line 705): Renamed `TranscriptEvent.metadata` to `event_metadata` while preserving the `metadata` column name to satisfy SQLAlchemy reserved attribute rules.
- lct_python_backend/services/stt_session.py (line 144): Updated transcript event persistence to use `event_metadata`.

## 2026-01-14T08:55:50Z
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 12-107): Stubbed transcript processor import to avoid optional `google-genai` dependency during WebSocket test setup.

## 2026-01-14T12:02:25Z
- AGENTS.md (lines 11-150): Reframed the large-file heuristic to focus on quality, added tech-debt logging guidance, and removed the stop condition tied to file length.
- docs/TECH_DEBT.md (lines 1-14): Added initial tech-debt register for large/mixed-concern files.

## 2026-01-14T12:24:47Z
- lct_python_backend/backend.py (lines 68-130, 655): Wired local transcript processing imports, routed `/ws/transcripts`, and switched graph generation to `generate_lct_json`.
- lct_python_backend/db_session.py (lines 51-60): Added async session context helper for background tasks.
- lct_python_backend/services/stt_config.py (lines 1-41): Added STT configuration defaults and override merge logic.
- lct_python_backend/services/transcript_processing.py (lines 1-534): Added transcript segmentation, accumulation, and local LLM processing helpers.
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 1-57): Added migrations for `app_settings` and `transcript_events`.

## 2026-02-08T20:30:00Z
- lct_python_backend/middleware.py (lines 1-290): Added P0 security middleware: AuthMiddleware (bearer token), RateLimitMiddleware (tiered), UrlImportGateMiddleware (SSRF gate), BodySizeLimitMiddleware.
- lct_python_backend/backend.py (lines 16, 70, 127-128): Wired security middleware, env-driven log level.
- lct_python_backend/stt_api.py (lines 29, 129-131, 205): Added WebSocket auth gate, redacted error details from client.
- lct_python_backend/.env.example (lines 1-48): Created env var template with security configuration docs.
- lct_app/src/services/apiClient.js (lines 1-66): Created shared API client with auth token support.
- lct_python_backend/tests/unit/test_middleware.py (lines 1-188): Added 16 unit tests for all middleware.

## 2026-02-07T20:50:38Z
- lct_python_backend/services/stt_config.py (lines 4-100): Added explicit STT provider IDs (`senko`, `parakeet`, `whisper`, `ofc`), provider URL map support, local-only defaults, external fallback URL handling, and backward-compatible `ws_url` derivation for legacy consumers.
- lct_python_backend/tests/unit/test_stt_config.py (lines 9-55): Expanded unit coverage for provider URL defaults, local-only boolean coercion, and legacy `ws_url` override behavior.
- lct_app/src/components/audio/sttUtils.js (lines 3-106): Added provider option constants, settings normalization helpers, provider URL resolution, and exports used by settings/recording flows.
- lct_app/src/components/SttSettingsPanel.jsx (lines 4-220): Replaced free-form provider field with fixed provider selector, added per-provider websocket URL inputs, local-only + fallback settings, and normalized payload persistence.
- lct_app/src/components/AudioInput.jsx (lines 6-296): Routed provider socket selection through normalized provider map, included local-only/session provider metadata, and added client-side STT turnaround telemetry timestamps.
- lct_app/src/components/audio/audioMessages.js (lines 7-63): Added telemetry metadata generation (`first_partial`, `first_final`, turnaround ms) and merged telemetry into forwarded transcript events.
- lct_app/src/components/audio/useSttSettings.js (lines 3-15): Normalized STT settings on load to keep runtime behavior consistent with API defaults.
- LOCAL_STT_SERVICES.md (lines 1-60): Added top-level catalog documenting local STT providers, shared container pattern, disk-sharing strategy, captured telemetry fields, and the local LLM/Tailscale endpoint note.
- docs/TECH_DEBT.md (line 15): Logged `AudioInput.jsx` as a monolith candidate after crossing the 300 LOC heuristic.

## 2026-02-08T04:21:50Z
- lct_python_backend/stt_api.py (lines 53-288): Added STT telemetry and provider health endpoints (`/api/settings/stt/telemetry`, `/api/settings/stt/health-check`), including telemetry aggregation from `transcript_events.metadata.telemetry`, health URL derivation from provider websocket URLs, and bounded timeout network probes.
- lct_app/src/services/sttSettingsApi.js (lines 1-48): Added frontend API methods for STT telemetry retrieval and provider health checks.
- lct_app/src/components/SttSettingsPanel.jsx (lines 3-367): Added live telemetry panel (auto-refresh + manual refresh), per-provider health check buttons/status, and UI bindings to the new STT settings APIs.
- docs/TECH_DEBT.md (lines 3-17): Updated last-reviewed date and logged new refactor candidates for `stt_api.py` and `SttSettingsPanel.jsx` after crossing the 300 LOC heuristic.

## 2026-02-08T20:35:00Z
- docs/PROJECT_STRUCTURE.md (lines 1-180): Created project structure documentation with module boundaries for backend, frontend, services, and docs.
- docs/adr/INDEX.md (lines 1-25): Created ADR index listing all 9 ADRs with status, date, and links.
- README.md (lines 519-528, 201, 307-313, 745-746): Updated ADR table (added 006-009), fixed Python version (3.9+), corrected backend port (8000), updated version/date.

## 2026-02-09T04:58:11Z
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 1-194): Added endpoint-focused unit coverage for `GET /api/settings/stt/telemetry` aggregation and `POST /api/settings/stt/health-check` behavior (success path, invalid provider validation, and missing provider URL failure), using dependency/module stubs to keep tests DB/network independent.

## 2026-02-09T07:18:45Z
- lct_python_backend/middleware.py (lines 82-126, 252-258): Added explicit CORS preflight detection and bypass in auth + rate-limit middleware so browser `OPTIONS` preflight is not blocked when `AUTH_TOKEN` is enabled.
- lct_python_backend/tests/unit/test_middleware.py (lines 11, 38-44, 145-157): Added CORS middleware to the test app fixture and added regression coverage to verify authenticated deployments allow preflight requests.

## 2026-02-09T08:30:00Z
- lct_app/src/services/{biasApi,frameApi,simulacraApi,analyticsApi,editHistoryApi,graphApi,promptsApi,llmSettingsApi,sttSettingsApi}.js: Migrated all 9 frontend service files from per-file `API_BASE_URL` constants and raw `fetch()` to shared `apiFetch()` from `apiClient.js`, centralizing auth token injection and base URL management.

## 2026-02-09T08:59:24Z
- README.md (lines 291-295, 362-364, 483-484): Corrected stale frontend env variable examples from `VITE_API_BASE_URL` on port 8080 to `VITE_API_URL` + `VITE_BACKEND_API_URL` on port 8000, and aligned API docs links to port 8000.

## 2026-02-09T16:03:38Z
- /Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md (lines 1-74): Created cross-project registry for STT/AI endpoints, runtime ownership, startup + health commands, venv/package snapshots, and redundancy-avoidance protocol so multiple projects can reuse shared services instead of reinstalling blindly.
- LOCAL_STT_SERVICES.md (lines 10-15): Added a canonical pointer to `/Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md` and clarified this file remains the project-local companion.

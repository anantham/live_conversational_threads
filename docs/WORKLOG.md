# WORKLOG

## 2026-02-13T19:35:56Z
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 87-154, 211): Extended the decision with explicit diarization requirements (overlay model, speaker evidence, node coloring semantics) and telemetry requirements (stage timings + per-provider p95 aggregation), plus a phase-gated `speaker_segments` persistence element and telemetry success criterion.
- lct_python_backend/stt_api.py (lines 72-113, 321-331, 453-523, 569-640): Added phase-1 realtime instrumentation in websocket pipeline: decode timing capture, stage-metric merge into per-event telemetry metadata, and flush-stage timing propagation (`stt_flush_request_ms`, `final_flush_total_ms`) for client visibility and backend aggregation.
- lct_python_backend/services/stt_http_transcriber.py (lines 33-35, 130-148): Added provider request duration measurement (`stt_request_ms`) at the HTTP transcriber session layer so every emitted STT event can carry provider-latency metadata.
- lct_python_backend/services/stt_telemetry_service.py (lines 30-181): Expanded provider telemetry aggregation to include last/avg/p95 for `stt_request_ms`, `stt_flush_request_ms`, and `audio_decode_ms`, alongside existing partial/final turnaround statistics.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 86-160): Extended telemetry endpoint unit assertions to validate new stage-latency aggregates and p95 calculations.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py tests/integration/test_transcripts_websocket.py` (10 passed)
  - `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_telemetry_service.py` (passed)

## 2026-02-10T15:14:17Z — docs: add diarization ADR-012 + file-by-file implementation checklist
- `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md` (lines 1-135): Added a new ADR defining the chosen dual-stream late-binding diarization architecture, phased stack choices (Diart -> ONNX hardening), event contract updates, validation gates, risks, assumptions, and rollback strategy.
- `docs/plans/2026-02-10-realtime-speaker-diarization-implementation-checklist.md` (lines 1-157): Added a concrete phase-by-phase implementation checklist with explicit backend/frontend/test/doc paths and acceptance gates.
- `docs/adr/INDEX.md`: Registered ADR-012 (renumbered from ADR-010 to avoid conflict with conversation schema ADR).

## 2026-02-13T19:27:48Z
- docs/VISION.md (lines 1-148): Added a pause/resume-first product vision document focused on parallel insight handling, human-in-the-loop safeguards, retrieval nudges during lulls, and explicit reliability/no-silent-failure requirements.
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 1-177): Added a proposed ADR defining a minimal transcript-first schema, strict LLM output contracts, validation/degradation rules, and rollout metrics to stabilize local-model graphing.
- docs/adr/INDEX.md (lines 3-16): Updated ADR index date and registered ADR-010.
- Why: Align product/architecture with current goal ("preserve conversational flow while retaining threads"), reduce schema complexity that is currently causing local-model JSON failures, and make the intended system behavior explicit for implementation and review.

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

## 2026-02-10T08:00:00Z — refactor: split bookmarks_api.py, import_api.py; fix cost_api.py

**Phase A — `bookmarks_api.py` (470 → 204 LOC)**
- `lct_python_backend/services/bookmark_service.py` (155 LOC, NEW): Extracted CRUD ops (`create_bookmark`, `list_bookmarks`, `list_conversation_bookmarks`, `get_bookmark_by_id`, `update_bookmark`, `delete_bookmark`), `serialize_bookmark` (eliminated 5× duplication), and `parse_uuid` helper.
- `lct_python_backend/bookmarks_api.py` (204 LOC): Thin router with Pydantic models and handlers delegating to service. Error translation: `ValueError` → 400, `LookupError` → 404, `Exception` → 500.

**Phase B — `import_api.py` (386 → 290 LOC)**
- `lct_python_backend/services/import_orchestrator.py` (142 LOC, NEW): Consolidated duplicate parse→validate→persist flow into `parse_validate_and_persist()`. Supporting functions: `parse_transcript()`, `validate_or_raise()`. `ImportResult` dataclass for outcomes.
- `lct_python_backend/import_api.py` (290 LOC): Simplified 3 import handlers from ~50-80 LOC each to ~20-30 LOC each. Preview endpoint uses `parse_transcript` + `validate_or_raise` directly (no persist). Backward-compat wrappers (`_validate_import_url`, `_is_url_import_enabled`, `_download_url_text`) preserved for test monkeypatch targets.

**Phase C — `cost_api.py` (344 → 338 LOC, bug fix)**
- `lct_python_backend/cost_api.py`: Replaced `get_db()` stub (returned `None`, silently breaking all endpoints) with `get_async_session` from `db_session.py`. No structural decomposition needed — file already delegates to `CostAggregator`/`CostReporter` from instrumentation layer. TECH_DEBT entry was misleading.

**Validation:**
- `pytest -q` — 187 passed, 3 skipped (pre-existing `test_graph_generation.py` import error unrelated).
- `tests/unit/test_import_api_security.py` — 9 passed (monkeypatch targets preserved).
- `py_compile` all modified/new files — passed.
- `docs/TECH_DEBT.md`: Marked all 3 entries as resolved with LOC before/after.

## 2026-02-10T03:03:56Z — fix: local stack launcher backend health URL + bookmarks health route shadowing
- `start-all-local.command` (lines 17-19, 148): Replaced stale backend health probe target with configurable `BACKEND_HEALTH_URL` defaulting to `http://localhost:$BACKEND_PORT/api/import/health` so startup no longer fails on nonexistent `/api/health/database`.
- `lct_python_backend/bookmarks_api.py` (lines 79-87): Moved `/api/bookmarks/health` route above dynamic `/{bookmark_id}` route to prevent `"health"` being parsed as a UUID and returning 400.
- `lct_python_backend/tests/unit/test_bookmarks_health_route.py` (lines 1-33): Added regression test asserting `/api/bookmarks/health` returns 200 and is not shadowed by `/{bookmark_id}`.
- Validation run:
  - `python3 -m py_compile lct_python_backend/bookmarks_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_bookmarks_health_route.py tests/unit/test_import_api_security.py` (10 passed)
  - `bash ./start-all-local.command` (backend/frontend/parakeet/local Postgres startup completed successfully)

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

## 2026-02-10T17:01:41Z
- Runtime investigation (no production code changes) to validate prerecorded-audio realtime graph generation path:
  - Verified active listeners/services: backend on `:8000`, Parakeet container on `:5092`, no listener on `:43001`.
  - Confirmed STT settings resolve all providers to `ws://localhost:43001/stream`, which is currently unavailable.
  - Confirmed Parakeet health endpoint is live (`http://127.0.0.1:5092/health`) and transcription endpoint works (`/v1/audio/transcriptions`), but it is HTTP-only and not a websocket `/stream` provider.
  - Replayed prerecorded transcript events into `/ws/transcripts`; transcript events persisted (telemetry `providers.parakeet.event_count` incremented) but no `existing_json` arrived during test window because local LLM generation timed out.
  - Reproduced LLM timeout directly via `transcript_processing` local calls; configured base URL `http://100.81.65.74:1234` was unreachable/timing out during this session.
- `ISSUES.md` (lines 5-9): Added `Runtime Blockers (2026-02-10)` for STT websocket mismatch and LLM endpoint reachability issues to keep discovered blockers tracked.
- `/Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md` (lines 1-44, 48-52): Refreshed cross-project registry health statuses (Parakeet local healthy, Whisper WS endpoints unreachable), added tailscale LM Studio service entry (`:1234`), and updated venv package snapshot fields (`speechbrain`, `websockets`) for current host state.

## 2026-02-13T12:55:00Z
- setup-once.command (lines 1-136): Added a first-time bootstrap script that installs Python/frontend dependencies, initializes local PostgreSQL (`.postgres_data` on port 5433), creates `lct_python_backend/.env` when missing, and runs Alembic migrations.
- start.command (lines 1-261): Added a single daily startup script that loads env vars, cleans stale repo-owned backend/frontend processes, validates prerequisites, ensures PostgreSQL is running, runs migrations, starts backend + frontend with prefixed live logs, and performs graceful shutdown on `Ctrl+C`.
- docs/LOCAL_SETUP.md (lines 1-55): Added consolidated operator documentation for one-time setup and daily startup flow, including local STT prerequisites.
- scripts/legacy_commands/README.md (lines 1-13): Added archive manifest describing why legacy scripts were retained and superseded.
- scripts/legacy_commands/setup-backend.command (moved): Archived legacy Docker-based setup script to reduce root-level startup script sprawl.
- scripts/legacy_commands/setup-postgres-local.command (moved): Archived legacy local Postgres setup script in favor of `setup-once.command`.
- scripts/legacy_commands/start-backend-local.command (moved): Archived legacy backend-only local starter in favor of `start.command`.
- scripts/legacy_commands/start-backend.command (moved): Archived legacy Docker-backed backend starter in favor of `start.command`.
- scripts/legacy_commands/stop-postgres-local.command (moved): Archived standalone Postgres stop helper; lifecycle is now controlled by the streamlined startup/shutdown flow.
- scripts/legacy_commands/start_server.sh (moved): Archived ad-hoc backend launcher to avoid duplicate startup entrypoints.
- README.md (Table of Contents + Local Setup/Running sections): Replaced split backend/frontend startup instructions with the new streamlined flow (`./setup-once.command`, `./start.command`) and corrected health-check guidance to `/api/import/health`.
- start.command (lines 63-97, 140-166): Fixed `set -e` helper-return behavior so no-op cleanup paths return success instead of exiting before startup.
- start.command (lines 144-159): Added `SKIP_MIGRATIONS=1` gate for manual E2E runs when migration history is already applied but Alembic chain is inconsistent.
- start.command (lines 30, 215-236): Added cleanup idempotency guard to avoid duplicate shutdown path on `INT` + `EXIT`.
- docs/LOCAL_SETUP.md (lines 36-41): Documented `SKIP_MIGRATIONS=1` override.
- ISSUES.md (Runtime Blockers): Logged preexisting Alembic revision-chain inconsistency (`KeyError: 'add_claims_table_with_vectors'`).
  - Impact: blocks clean startup when migrations run.
  - Blocker status: blocking for first-time setup; bypassable for existing DB with `SKIP_MIGRATIONS=1`.
  - Recommended next step: repair migration DAG in `lct_python_backend/alembic/versions/` so `alembic upgrade head` resolves without missing revision IDs.

## 2026-02-13T13:05:00Z
- lct_python_backend/alembic/versions/add_claims_table_with_vectors.py (lines 3-4, 13-15): Corrected revision linkage to `add_analysis_weeks_11_13` so Alembic can resolve the chain.
- lct_python_backend/alembic/versions/add_claims_table_with_vectors.py (lines 19-29): Made pgvector extension setup conditional on `pg_available_extensions` to avoid migration failure on local Postgres instances without `vector.control`.
- lct_python_backend/alembic/versions/add_argument_analysis_tables.py (lines 3-4, 13-15): Corrected `Revises`/`down_revision` to `add_claims_vectors` (removed reference to nonexistent `add_claims_table_with_vectors`).
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 3-5, 11-14): Shortened revision ID to `add_transcript_events_settings` (<=32 chars) and set parent revision to `add_argument_analysis` to maintain a single linear head for `upgrade head`.
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 18-69): Made migration idempotent for pre-existing `app_settings`/`transcript_events` tables by creating missing tables/indexes/check-constraints only when absent.
- ISSUES.md (lines 3, 10-15): Updated issue tracker date and moved Alembic blocker to resolved section after verification.
- Verification (local DB `postgresql://lct_user:lct_password@localhost:5433/lct_dev`):
  - `python -m alembic history` shows linear chain ending in `add_transcript_events_settings (head)`.
  - `python -m alembic heads` returns a single head.
  - `python -m alembic upgrade head` succeeds.
  - `./start.command` now succeeds without `SKIP_MIGRATIONS`.

## 2026-02-13T07:49:44Z
- start.command (lines 25-35, 185-264, 343-345): Added opt-in shared STT bootstrap controls (`STT_AUTOSTART`, `STT_AUTOSTART_PROVIDER`, `SHARED_PARAKEET_DIR`) and endpoint status reporting. `STT_AUTOSTART=1 STT_AUTOSTART_PROVIDER=parakeet` now starts the sibling Parakeet Docker service if available, waits for `/health`, and reuses Docker volume `parakeet-models` to avoid duplicate model downloads across projects.
- docs/LOCAL_SETUP.md (lines 27-55): Documented new optional shared STT autostart flow and clarified non-redundant cache behavior.
- README.md (lines 230-239): Added the shared Parakeet autostart command to the primary startup section so operators can run app + shared STT from this repo.
- Verification: `bash -n start.command` passed.

## 2026-02-13T07:51:43Z
- start.command (lines 28-29): Updated Whisper/WhisperX default health URLs to TemporalCoordination defaults (`172.20.5.123:8000/8001`) to avoid false checks against this repo's backend port `8000`.
- Verification: `bash -n start.command` passed.
- Verification: `STT_AUTOSTART=1 STT_AUTOSTART_PROVIDER=parakeet ./start.command` reached healthy backend/frontend startup, skipped STT autostart cleanly when Docker daemon was unavailable, printed endpoint status summary, and shut down cleanly on `Ctrl+C`.

## 2026-02-13T08:11:41Z
- lct_app/src/components/audio/audioMessages.js (lines 37-67): Added `onTranscriptEvent` callback emission for each provider partial/final payload so UI can render raw text immediately without waiting for backend semantic batching.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 17-279): Added optional callbacks for provider/backend WebSocket connection states (`connecting|connected|error|closed`) and passed through provider transcript events to the UI layer.
- lct_app/src/components/AudioInput.jsx (lines 16-290): Added live capture visibility UX: mic/provider/backend status chips and a rolling "Live Raw Transcript" panel that streams partial and final text as it arrives; keeps final lines and updates the in-flight partial line in place.
- Verification:
  - `npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js` (from `lct_app/`) passed.
  - `npm --prefix lct_app run build` passed.
  - `npm --prefix lct_app run lint -- ...` reports pre-existing repository-wide lint errors unrelated to these changes.

## 2026-02-13T17:28:32Z
- lct_python_backend/services/stt_http_transcriber.py (lines 1-179): Added backend-owned realtime STT HTTP transcriber utilities for base64 audio decode, PCM->WAV conversion, provider response text extraction, and chunked/flush transcription session handling.
- lct_python_backend/stt_api.py (lines 1-419): Refactored `/ws/transcripts` to accept `audio_chunk` payloads, route chunks to backend HTTP STT provider sessions, persist/emit transcript partial+final events from backend, keep legacy transcript event input compatibility, and include session ack/provider readiness metadata.
- lct_python_backend/services/stt_config.py (lines 1-147): Extended STT config model with provider HTTP URL map + active `http_url`, HTTP-specific defaults (`chunk_seconds`, timeout, model, language, sample rate), and merge behavior while preserving legacy WS settings for health checks.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 1-185): Simplified client transport to backend-only WS; removed direct provider WS dependency and now streams microphone chunks as base64 `audio_chunk` messages to `/ws/transcripts`.
- lct_app/src/components/audio/audioMessages.js (lines 1-53): Reworked backend message handler to consume backend-emitted transcript events and STT provider readiness/error states for live UI feedback.
- lct_app/src/components/AudioInput.jsx (lines 1-277): Updated recording flow to start backend-owned STT sessions (no direct provider URL requirement) and relabeled provider chip as `STT Engine`.
- lct_app/src/components/audio/sttUtils.js (lines 1-130): Added provider HTTP URL normalization/defaults and active `http_url` derivation in normalized STT settings.
- lct_app/src/components/SttSettingsPanel.jsx (lines 1-327): Added per-provider HTTP transcription URL fields and active HTTP URL display to match backend-owned routing.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 1-240): Added websocket integration coverage for backend-owned `audio_chunk` ingestion path.
- lct_python_backend/tests/unit/test_stt_config.py (lines 1-74): Expanded config unit coverage for provider HTTP URL merge/default behavior.
- lct_python_backend/tests/unit/test_stt_http_transcriber.py (lines 1-57): Added unit coverage for transcriber helpers and realtime chunk/flush session behavior.
- start.command (lines 1-364): Defaulted shared STT autostart on (`STT_AUTOSTART=1`), updated readiness hints for backend-owned HTTP STT routing, and marked WS listener checks as legacy optional.
- README.md (lines 225-246): Updated startup docs to reflect default STT autostart and backend-owned STT path.
- docs/LOCAL_SETUP.md (lines 35-84): Updated setup docs from WS-required STT to backend-owned HTTP STT requirements and defaults.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_http_transcriber.py` (13 passed)
- `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/audio/sttUtils.js src/components/SttSettingsPanel.jsx` (passed)
- `npm --prefix lct_app run build` (passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_config.py` (passed)
- `bash -n start.command` (passed)
- docs/TECH_DEBT.md (lines 1-15): Re-opened `lct_python_backend/stt_api.py` as a decomposition candidate after backend-owned STT routing increased module size/concern density; recorded suggested split targets.
- docs/adr/ADR-008-local-stt-transcripts.md (lines 1-68): Added 2026-02-13 amendment documenting the backend-owned STT routing shift (`audio_chunk` -> backend HTTP provider -> backend-emitted transcript events) and clarified provider WS is now legacy/optional.

## 2026-02-13T17:36:41Z
- lct_app/src/components/AudioInput.jsx (lines 78-94): Updated live raw transcript behavior to append every incoming partial/final STT event as a new line entry instead of replacing the latest partial line. This makes the panel behave like a running stream (within existing `LIVE_TRANSCRIPT_MAX_LINES` cap).

Validation:
- `cd lct_app && npx eslint src/components/AudioInput.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-13T17:44:07Z
- lct_python_backend/services/transcript_processing.py (lines 1-579): Added outbound LLM API trace logging (`TRACE_API_CALLS` + preview truncation), cached fallback when providers reject `response_format: json_object`, surfaced accumulation warnings/errors in result payloads, and added processor status callback plumbing (`send_status`) so websocket clients can receive explicit processing warnings/errors instead of silent drops.
- lct_python_backend/stt_api.py (lines 267-566): Added websocket `processing_status` emissions from transcript processor callbacks and explicit error status messages for final-text processing / flush failures.
- lct_app/src/components/audio/audioMessages.js (lines 1-73): Added handling for backend `processing_status` messages and promoted backend `error` messages into UI-consumable processing status callbacks.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 20-57): Added `onProcessingStatus` pass-through from backend websocket handler.
- lct_app/src/components/AudioInput.jsx (lines 65-141, 168-227): Added in-UI processing warning/error banner so local LLM/graph-generation failures are visible during recording sessions.
- lct_app/src/services/apiClient.js (lines 1-102): Added frontend API request/response tracing in dev mode (or `VITE_API_TRACE`) with response preview logging for easier debugging.
- lct_python_backend/services/stt_http_transcriber.py (lines 16-186): Added structured STT HTTP API trace logging (request metadata + status + transcript preview + error body preview).
- lct_python_backend/services/local_llm_client.py (lines 1-185): Added local LLM API trace logging and cached skip of unsupported `response_format` for endpoints that reject `json_object`.
- lct_python_backend/services/llm_config.py (lines 1-61): Added explicit Tailscale default constant and rewrite guard that normalizes legacy `localhost:1234` configs to `http://100.81.65.74:1234`.
- lct_python_backend/.env.example (lines 53-64): Added Local LLM defaults (Tailscale base URL) and API trace toggles.
- lct_python_backend/tests/unit/test_llm_config.py (lines 1-37): Added regression coverage for localhost->Tailscale base URL rewrite behavior.
- start.command (lines 114-124, 284-292, 373): Added startup defaults + health check for local LLM endpoint (`$LOCAL_LLM_BASE_URL/v1/models`) and printed status in startup summary.
- docs/LOCAL_SETUP.md (lines 1-105): Updated setup guide with local LLM default endpoint and explicit log/trace configuration guidance.
- README.md (Local Setup section): Added note that startup now reports local LLM endpoint reachability.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 69-75): Added confirmation gate when saving `mode=online` so external-provider mode is not accidentally enabled.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_llm_config.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_http_transcriber.py` (16 passed)
- `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/LlmSettingsPanel.jsx src/services/apiClient.js` (passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/llm_config.py lct_python_backend/services/local_llm_client.py` (passed)
- `npm --prefix lct_app run build` (passed)
- `bash -n start.command` (passed)
- ISSUES.md (Runtime Blockers): Added a preexisting runtime issue note for backend force-kill on shutdown when long LLM requests are in-flight (non-blocking for current task, recommended follow-up: graceful cancellation in transcript processing).

## 2026-02-13T17:53:38Z
- E2E validation attempt (manual websocket pipeline): tried streaming `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Audio Recordings/h1n/ZOOM0123.MP3` through backend `/ws/transcripts` via ffmpeg decode + `audio_chunk` messages.
- Result: source audio path is not materialized locally (single `read(4096)` times out after 8s; ffmpeg blocks indefinitely on read), so this specific MP3 could not be streamed for E2E from that path.
- Fallback E2E run executed with local sample `outputs/stt_sample.wav` to validate pipeline behavior:
  - session ack successful (`stt_mode=backend_http`, provider HTTP URL present)
  - 20 audio chunks / 160000 bytes sent
  - transcript events received: partial=3, final=1
  - DB persistence confirmed for conversation `7e171234-ca06-4625-bfee-bba1247ccdfe`: `transcript_events` partial=3/final=1, `utterances`=1
  - semantic graph generation not produced within run window: `existing_json`=0, `chunk_dict`=0, `nodes` table count=0 for that conversation
- Backend logs show root cause for missing graph update in this run: local LLM responses from `http://100.81.65.74:1234/v1/chat/completions` include non-JSON preambles (`<think>...`), causing JSON parse failures (`Extra data`) in `generate_lct_json_local` retries.
- ISSUES.md (Runtime Blockers): logged cloud file-provider materialization blocker for E2E media inputs from Google Drive paths (file metadata visible but reads can block until explicit local download).

## 2026-02-13T19:37:25Z
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 87-121, 153, 211): Added explicit diarization requirements (speaker segments for node coloring) and Phase 1 telemetry requirements (per-provider last/avg/p95 latency metrics) plus success criteria updates.
- lct_python_backend/services/stt_http_transcriber.py (lines 33, 130-148): Added STT request timing capture and emitted `stt_request_ms` in transcript event metadata for each chunk/flush transcription call.
- lct_python_backend/stt_api.py (lines 72-118, 462-512, 577-640, 663-669): Added telemetry helpers and websocket-stage instrumentation (`audio_decode_ms`, `stt_request_ms`, `stt_flush_request_ms`, `final_flush_total_ms`) and merged normalized telemetry metadata into persisted transcript events and flush acknowledgements.
- lct_python_backend/services/stt_telemetry_service.py (lines 42-52, 57, 137-174): Extended provider aggregation to compute sample counts and last/avg/p95 stats for decode/STT/flush timings.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 94-118, 147-160): Expanded telemetry endpoint unit assertions to cover new timing fields and p95 aggregates.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py tests/integration/test_transcripts_websocket.py` (10 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_telemetry_service.py` (passed)

## 2026-02-14T05:30:21Z
- lct_python_backend/services/local_llm_client.py (lines 26-59): Hardened JSON extraction for local model outputs that include visible reasoning (`<think>...</think>`), fenced blocks, and trailing prose by decoding the first valid JSON value instead of requiring the entire response body to be pure JSON.
- lct_python_backend/services/transcript_processing.py (lines 158-186, 206-420, 640-664): Added a minimal local graph prompt (`LOCAL_GENERATE_LCT_PROMPT`) with explicit node summary + edge relation text requirements and thread transition states (`new_thread|continue_thread|return_to_thread`), then added output normalization so dict/list variants from local models are coerced into a stable node payload (`edge_relations`, `thread_id`, `thread_state`, `node_text`, `source_excerpt`) while preserving legacy fields.
- lct_python_backend/stt_api.py (lines 136-150, 339-391, 629-719, 732-735): Added websocket-safe send helper (`_safe_send_json`) and changed `final_flush` behavior so `flush_ack` is emitted before expensive graph-generation flush work. Post-flush transcript processing now runs in a background task, preventing client timeouts when local LLM JSON cycles are slow.
- lct_app/src/components/ContextualGraph.jsx (lines 12-22, 347-441, 577-595, 732-788): Added relation-type edge styling (`supports`, `rebuts`, `clarifies`, `tangent`, `return_to_thread`), hover card for edge relation text, and context panel display of normalized `edge_relations` to make branching/return semantics visible in the realtime graph.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (line 233): Added regression test ensuring `flush_ack` is not blocked by slow `processor.flush()`.
- lct_python_backend/tests/unit/test_local_llm_client.py (lines 1-22): Added extractor tests for `<think>` output, trailing prose, and missing JSON failure path.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 1-52): Added normalization tests for `nodes+edges` object outputs and default field coercion.
- docs/TECH_DEBT.md (table rows): Updated LOC/rationale for `transcript_processing.py` and `stt_api.py` and added `ContextualGraph.jsx` as a decomposition candidate after this patch.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_local_llm_client.py tests/unit/test_transcript_processing_schema.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py` (16 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/local_llm_client.py` (passed)
- `cd lct_app && npx eslint src/components/ContextualGraph.jsx` (no errors; warnings are pre-existing hook-dependency warnings in this component)
- `npm --prefix lct_app run build` (passed)

Diagnostics run for local model behavior:
- Streamed prompt bakeoff against `http://100.81.65.74:1234/v1/chat/completions` with realistic transcript snippets.
- Observed consistent `<think>` prefix plus parseable JSON tail; schema shape varied across runs (array vs object), which motivated backend normalization instead of trying to suppress reasoning text.

## 2026-02-14T05:36:01Z
- lct_python_backend/stt_api.py (lines 308-389, 697-719, 730-748): Refined websocket flush path further by queueing `final` transcript processing into background tasks (serialized via lock) and waiting for pending final-processing tasks inside post-ack flush worker. This prevents `final_flush` ack delays caused by in-flight local-LLM processing from earlier `transcript_final` events.
- lct_python_backend/stt_api.py (lines 730-748): Added RuntimeError handling for disconnected websocket receive/close path to avoid noisy stack traces (`WebSocket is not connected` / `Cannot call send once close sent`).

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py` (7 passed)
- Runtime probe (`ZOOM0123.MP3`, 10s slice over `/ws/transcripts`): `flush_ack` received in ~1567 ms (no client-side flush timeout), confirming ack is no longer blocked on graph-generation flush completion.

## 2026-02-14T06:41:48Z
- lct_app/src/components/AudioInput.jsx (lines 16, 53-108, 136-143, 285): Fixed live transcript duplication by replacing streaming partial text in-place and converting that same line to final on `transcript_final` instead of appending both events. Added duplicate-final guard for repeated server messages, increased rolling buffer from 60 to 240 lines, and increased transcript viewport height (`h-28` -> `h-40`) so longer sessions remain visible.

Validation:
- `cd lct_app && npx eslint src/components/AudioInput.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T06:56:27Z
- lct_app/src/pages/Settings.jsx (line 388): Fixed runtime crash on `/settings` by escaping the literal template example string. Previous text `Use $variable or ${{variable}} ...` evaluated `variable` at render-time and threw `ReferenceError: variable is not defined`; updated to literal JSX string fragments `{"$variable"}` and `{"${{variable}}"}`.

Validation:
- `cd lct_app && npx eslint src/pages/Settings.jsx` (0 errors, 2 pre-existing hook-dependency warnings)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T07:01:42Z
- lct_python_backend/services/transcript_processing.py (lines 18-23, 193-205, 512-975): Added Gemini key alias resolution (`GOOGLEAI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_KEY`) and replaced static import-time key usage with runtime resolution; preserved fast Gemini config (`thinking_budget=0`, no tools), added explicit online-mode fallback warnings, and surfaced detailed generation/accumulation failure reasons via `processing_status` so frontend users see why graph generation is degraded/fallback.
- lct_python_backend/config.py (lines 7-11): Updated shared `GOOGLEAI_API_KEY` constant to accept `GEMINI_API_KEY` and `GEMINI_KEY` aliases.
- lct_python_backend/.env.example (line 38): Added `GEMINI_KEY=` for parity with runtime alias support.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 1-113): Added regression coverage for Gemini key alias resolution and online-mode missing-key fallback warnings for both graph generation and accumulator paths.
- docs/TECH_DEBT.md (lines 3, 12): Refreshed last-updated date and expanded `transcript_processing.py` split recommendation to include a dedicated `llm_provider_router.py`, since provider/key-routing concerns now further increase mixed responsibility in that module.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_transcript_processing_schema.py tests/unit/test_llm_config.py` (8 passed)
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/integration/test_transcripts_websocket.py` (3 passed)
- `python3 -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/config.py` (passed)

## 2026-02-14T07:09:03Z
- lct_python_backend/services/stt_health_service.py (lines 32-41): Added `derive_health_url_from_http_url()` so provider health checks can derive `/health` from HTTP transcription endpoints (`http://.../v1/audio/transcriptions` -> `http://.../health`) instead of assuming websocket transport.
- lct_python_backend/stt_api.py (lines 32-36, 176-179, 226-266): Updated `/api/settings/stt/health-check` resolution order to prefer provider HTTP URLs (`provider_http_urls`) and only fall back to websocket-derived health URLs when HTTP URL is absent; endpoint now accepts health checks with only HTTP URL configured and returns both `ws_url` and `http_url` in payload for transparency.
- lct_app/src/components/audio/useProviderHealthChecks.js (lines 12-26): Updated health-check request payload to include `http_url` alongside `ws_url`.
- lct_app/src/components/SttSettingsPanel.jsx (lines 205-211): Updated Health Check button to pass both provider WS and provider HTTP URLs from settings state.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 201-260): Added regression test for HTTP-priority health resolution and updated missing-URL assertion to new error semantics.
- Note on modularity: `lct_python_backend/stt_api.py` remains a known large mixed-concern module and is already tracked in `docs/TECH_DEBT.md` for decomposition; no new split candidate added in this patch.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_config.py` (8 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_health_service.py` (passed)
- `cd lct_app && npx eslint src/components/SttSettingsPanel.jsx src/components/audio/useProviderHealthChecks.js` (passed)

## 2026-02-14T07:29:34Z
- lct_python_backend/llm_api.py (lines 1-235): Added provider-aware model options endpoint `GET /api/settings/llm/models` with mode routing (`local` via `<base_url>/v1/models`, `online` via Google Gemini models API), 5-minute in-process caching, and strict online save validation so `PUT /api/settings/llm` rejects invalid Gemini `chat_model` IDs.
- lct_app/src/services/llmSettingsApi.js (lines 11-23): Added `getLlmModelOptions()` client for dynamic model option retrieval.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 1-262): Replaced static chat model list with dynamic accepted-model dropdown tied to mode/base URL, removed free-form chat model entry path, surfaced option source (`gemini_api`, `local_api`, `fallback`), and blocked save when no accepted model is selected.
- lct_python_backend/tests/unit/test_llm_api.py (lines 1-99): Added unit coverage for online/local model-options behavior, invalid online-model rejection, and normalization of `models/<id>` values.
- lct_python_backend/services/transcript_processing.py (lines 18, 193-205, 527-648, 768-823): Completed online Gemini model selection fix so graph/accumulation calls use configured `chat_model` (normalized) instead of stale hardcoded model ID.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 116-156): Added regression tests for online Gemini model resolution and pass-through into graph generation.
- outputs/e2e_gemini_summary_1771054114.json + outputs/e2e_gemini_graph_1771054114.json: Saved E2E run artifacts for `ZOOM0123.MP3` using backend websocket STT + Gemini graph generation (`conversation_id=95226fd3-8b7a-480b-8362-dd31d58dead2`).

Validation:
- `./.venv/bin/python -m py_compile lct_python_backend/llm_api.py lct_python_backend/services/transcript_processing.py` (passed)
- `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py` (13 passed)
- `cd lct_app && npx eslint src/components/LlmSettingsPanel.jsx src/services/llmSettingsApi.js` (passed)
- `curl 'http://localhost:8000/api/settings/llm/models?mode=online'` returned 22 accepted Gemini models from `source=gemini_api` (including `gemini-3-flash-preview`).
- `curl -X PUT /api/settings/llm ... chat_model=not-valid` now fails with `400` and accepted-model guidance.
- E2E websocket stream (`ZOOM0123.MP3`, 75s segment, provider=parakeet, mode=online chat_model=gemini-3-flash-preview):
  - `session_ack=1`, `transcript_partial=23`, `transcript_final=18`
  - `existing_json=2`, `chunk_dict=2`, `errors=0`, `processing_status=0`
  - graph export captured 2 nodes / 2 chunks in `outputs/e2e_gemini_graph_1771054114.json`
  - backend logs confirm Gemini calls: `[GEMINI] ... accumulation model=gemini-3-flash-preview` and `[GEMINI] ... graph generation model=gemini-3-flash-preview`
  - observed `flush_ack_ms=27940.65` on this high-throughput scripted run; logged to `ISSUES.md` as backlog-latency follow-up.

## 2026-02-14T07:57:04Z
- Validation-only pass (no production code changes in this step): reran compile, targeted tests, frontend lint/build, and websocket E2E against `ZOOM0123.MP3` with Gemini online mode.
- outputs/e2e_gemini_summary_1771055718.json + outputs/e2e_gemini_graph_1771055718.json: New artifact set from 75s stream (`conversation_id=27f83aa1-7729-4cd6-bfe5-c9429fb6885c`) showing `session_ack=1`, `transcript_partial=25`, `transcript_final=18`, `existing_json=2`, `chunk_dict=2`, `errors=0`, `processing_status=0`.
- Runtime stress probe (`conversation_id=c3a6959a-e764-4678-bfed-cc19a0a6ff7d`, 20s burst, no pacing): confirmed near-immediate `flush_ack` (`ack_wait_ms=0.89`) and successful late semantic updates while socket remains open (`existing_json=1`, `chunk_dict=1`, no errors).
- docs note: updated `ISSUES.md` with follow-up that post-refactor `flush_ack` may arrive before graph updates; clients should keep websocket open briefly after ack to avoid missing late `existing_json`/`chunk_dict`.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/python -m py_compile stt_api.py llm_api.py services/transcript_processing.py services/stt_health_service.py` (passed)
- `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py` (21 passed)
- `cd lct_app && npx eslint src/pages/Settings.jsx src/components/LlmSettingsPanel.jsx src/components/AudioInput.jsx src/components/SttSettingsPanel.jsx src/components/audio/useProviderHealthChecks.js src/services/llmSettingsApi.js` (0 errors, 2 pre-existing hook-dependency warnings in `Settings.jsx`)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T10:54:43Z
- lct_app/src/pages/NewConversation.jsx (lines 13-58, 76-86, 137-143, 179-185): Added `normalizeGraphDataPayload()` boundary normalizer so websocket `existing_json` payloads in either shape (`Array<Node>` from current backend or legacy `Array<Array<Node>>`) are converted to the chunked structure expected by `ContextualGraph`/`StructuralGraph`. Malformed payloads are now ignored with a descriptive warning instead of crashing downstream `latestChunk.map(...)` calls.
- lct_app/src/pages/NewConversation.jsx (lines 137, 179): Passed `conversationId` into `ContextualGraph` in both default and formalism layouts so conversation-scoped actions (bookmark/fact-check flows) receive a defined identifier.

Validation:
- `cd lct_app && npx eslint src/pages/NewConversation.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T10:59:52Z
- .gitignore (lines 207-213): Added local-artifact exclusions for `/.serena/` and `/lct_python_backend/recordings/` so developer-local metadata and runtime audio captures do not keep the branch perpetually dirty or leak into PRs.
- Branch validation pass before commit:
  - `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py` (21 passed)
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/AudioInput.jsx src/components/LlmSettingsPanel.jsx src/components/SttSettingsPanel.jsx src/components/audio/audioMessages.js src/components/audio/sttUtils.js src/components/audio/useProviderHealthChecks.js src/components/audio/useTranscriptSockets.js src/services/llmSettingsApi.js src/pages/Settings.jsx` (0 errors, 2 pre-existing warnings in `Settings.jsx`)
  - `npm --prefix lct_app run build` (passed)

## 2026-02-14T16:14:02Z
- README.md (lines 274-306, 355): Aligned docs with runtime defaults by replacing stale manual DB bootstrap (`createdb lct_db`) with script-first setup (`setup-once.command` / `start.command`), documenting the actual default local DB URL (`postgresql://lct_user:lct_password@localhost:5433/lct_dev`), and correcting ADR-001 status to `Proposed` to match `docs/adr/INDEX.md`.
- API_DOCUMENTATION.md (line 115): Corrected save-path note to reflect current implementation reality (`POST /save_json/` uses GCS helper and may fail locally without ADC/bucket config) instead of claiming an automatic local fallback that does not exist in code.
- docs/ROADMAP.md (line 133): Updated import endpoint path from legacy unprefixed `/import/google-meet` to mounted route `/api/import/google-meet`.

Verification:
- Source-of-truth route/config checks from code: `lct_python_backend/backend.py` router mounts, route decorators under `lct_python_backend/*_api.py`, frontend base URL in `lct_app/src/services/apiClient.js`, and auth/rate-limit behavior in `lct_python_backend/middleware.py`.
- Docs consistency scan: `rg -n "localhost:8080|VITE_API_BASE_URL|/ws/audio|/import/google-meet" README.md API_DOCUMENTATION.md docs/*.md docs/**/*.md -g'*.md'` (interpreted with ADR/plans as historical context, patched canonical docs accordingly).

## 2026-02-14T19:07:49Z
- `lct_app/src/pages/NewConversation.jsx` (lines 14-111, 141, 187): Restored robust `existing_json` normalization for legacy/current payload wrappers, reintroduced safe chunk fallback grouping (`chunk-0`) for nodes missing `chunk_id`, added node-shape normalization at the page boundary, and updated back-dialog copy to match local save fallback behavior.
- `lct_app/src/components/MinimalGraph.jsx` (lines 11-38, 68-182): Added defensive node normalization before ReactFlow mapping so missing/partial node fields (`id`, `node_name`, relations) no longer cause silent render failures.
- `lct_app/src/components/NodeDetail.jsx` (lines 4-37, 95-123, 189): Fixed hook-order risk by switching to `safeNode` pattern, added `Escape` key close behavior, and passed/used `chunkDict` for raw transcript context rendering.
- `lct_python_backend/services/gcs_helpers.py` (lines 16-17, 30, 65-111, 116-128, 157): Implemented `SAVE_BACKEND` routing (`auto|gcs|local`), local JSON save path fallback for ADC/GCS failures, and local file load support when persisted path points to disk.
- `lct_python_backend/generation_api.py` (lines 16, 71-77, 100, 104, 113): Switched `/save_json/` to backend-aware saver, added env validation/defaulting for `SAVE_BACKEND`, removed debug prints, and preserved stable API response shape while returning fallback-aware message text.
- `lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py` (lines 8-56): Added regression coverage for local save mode, auto fallback when GCS save fails, and invalid backend value handling.
- `lct_app/src/components/audio/useAudioInputEffects.js` + `lct_app/src/components/AudioInput.jsx` (lines 46-71 and 177-184): Surfaced autosave failures via UI message channel instead of silent logs only.
- `lct_app/src/components/LlmSettingsPanel.jsx` (lines 58-103): Fixed model-option refresh dependency behavior by keying fetch effect off stable derived values (`mode`, `base_url`) instead of entire form object.
- `lct_app/src/components/ContextualGraph.jsx` + `lct_app/src/components/StructuralGraph.jsx` (lines 23-32/99-104 and 11-20/62-68): Gated verbose render debug logs behind `VITE_GRAPH_DEBUG=true` so default dev runs are not flooded with noisy logs.
- `ISSUES.md`: Logged preexisting non-blocking lint warning debt in legacy graph components to keep this scoped fix set unblocked.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_gcs_helpers_save_fallback.py tests/unit/test_stt_api_settings.py tests/unit/test_stt_config.py tests/unit/test_transcript_processing_schema.py` (20 passed)
- `python3 -m py_compile lct_python_backend/generation_api.py lct_python_backend/services/gcs_helpers.py` (passed)
- `cd lct_app && npx eslint src/components/NodeDetail.jsx src/pages/NewConversation.jsx src/components/MinimalGraph.jsx src/components/AudioInput.jsx src/components/audio/useAudioInputEffects.js src/components/LlmSettingsPanel.jsx src/components/ContextualGraph.jsx src/components/StructuralGraph.jsx` (0 errors, 6 preexisting warnings in legacy graph components only)

## 2026-02-14T19:11:31Z
- Documentation bundling for PR scope alignment:
  - `README.md`: Included existing runtime/setup accuracy edits (script-first startup flow and local DB defaults) in feature branch PR scope.
  - `API_DOCUMENTATION.md`: Included endpoint behavior clarification updates for save behavior and environment expectations.
  - `docs/PROJECT_STRUCTURE.md` + `docs/ROADMAP.md`: Included pending structure/roadmap cleanups aligned with current backend/frontend routes.
  - `docs/plans/2026-02-15-bulk-file-upload-design.md`, `docs/plans/2026-02-15-bulk-file-upload-plan.md`, `docs/plans/2026-02-15-speaker-diarization-pipeline.md`: Added planning artifacts for upcoming ingest/diarization workstreams.

Verification:
- `git status --short` reviewed to ensure only docs files were newly added in this step before commit.

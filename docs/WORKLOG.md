# WORKLOG

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

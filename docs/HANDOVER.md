# Handover: 2026-05-17

## Session Summary
Tech-debt scan + multi-batch cleanup. Started with `/surface-tech-debt`
(7-dimension audit) — found critical security gaps (no auth, live API
key on disk), 4 monoliths >1400 LOC, several architectural redundancies,
and a latent NameError in an unused endpoint. Shipped 9 atomic commits
addressing 14 distinct items: secrets/auth hardened, dead code purged
(412 LOC Claude path + shim + broken endpoint + 4 dead files), ~1,700+
LOC moved into 8 focused helper modules, vitest framework added,
~170 new unit tests, ADR-031 documents the consolidation pipeline.
Stopped at honest stopping point — remaining items either need 2-3 hour
focused sessions (SessionConfig refactor) or user-side decisions
(prompts dual store, fate of formalism endpoint).

## Commits This Session (all on `main`, NOT pushed yet)
- `6d2f670` chore(debt): adopt env_helpers in 5 safe sites (I, partial)
- `7d11eb1` C: extract CircuitBreaker subsystem from RealtimeHttpSttSession
- `0426786` A+B+D: delete dead endpoint, set up vitest, extract MinimalGraph clustering
- `efbf176` refactor(llm): delete dead Claude path in llm_helpers (M1)
- `5199bd9` chore(debt): retry_policy — unify the ad-hoc retry loops
- `78d60d3` chore(debt): env_helpers — kill the os.getenv().strip().lower() boilerplate
- `3d8b265` chore(debt): tuning constants + upload/SSRF defense-in-depth
- `7fa3f67` refactor(monoliths): extract pure helpers from 3 of the 4 big files
- `f3f31d2` chore(debt): cheap-wins batch — tests, encoding fixes, file rename

**PUSHED: no** — 9 commits ahead of origin/main. Push requires explicit user
go-ahead; previous handover (2026-04-03) had been pushed to a feature branch
but this session was directly on `main`, so push needs care.

## Pending Threads

### Bigger Investments (Each Its Own Focused Session)
1. **SessionConfig refactor → complete C** — 2-3 hrs, intricate but bounded.
   The remaining 810-LOC `RealtimeHttpSttSession` class in
   `lct_python_backend/services/stt_http_transcriber.py` has deep state coupling
   between config (provider/model/language/session_id/conversation_id), buffer
   state, VAD state, and per-provider transcription methods. Extracting an
   `SttSessionConfig` dataclass would enable moving the 3 per-provider methods
   (`_transcribe_backend_http_candidate`, `_transcribe_openai_audio_candidate`,
   `_transcribe_openrouter_audio_candidate`, ~250 LOC) to a new
   `stt_provider_transports.py` module. Risk: touches active STT path; needs
   careful test sweep after.
2. **Worker test scaffolding** → unblocks the 1415-LOC `run_bulk_processing_worker`
   mega-function split in `import_bulk_pipeline.py`. ~1 day to write integration
   tests covering each stage (uploading / transcribing / analyzing / chunking /
   consolidating / persisting / exporting), then ~1 day for the split itself.
3. **WS test scaffolding** → unblocks the 2508-LOC `WsSessionContext` class in
   `stt_ws_session.py`. The 12 TODOs in `tests/integration/test_audio_websocket.py`
   need real bodies first. ~1 day for tests, ~2 days for class decomposition.
4. **Frontend further extraction** — `MinimalGraph.jsx` is now 1156 LOC (down
   from 1799). The remaining LOC is the React component proper. Further work
   would extract event handlers and effect logic — needs careful state analysis.

### Slogs (Hours of Low-Leverage Work)
5. **M7 narrow bare excepts** — 124 catches across 45 files. The 59 in API
   routes are largely appropriate (terminal HTTP-500 handlers). The 65 in
   services are mixed: maybe 20-30 actually swallow real bugs. File-by-file
   audit needed; each catch is a small judgement call.
6. **Incremental env_helpers/retry_policy adoption** — 17 remaining env-var
   sites all have subtle semantic differences (narrower truthy sets, fail-loud
   vs silent-default for int parsing). Each migration is its own judgement.
   Helper exists, can be adopted opportunistically when each file is next
   touched.

### User-Side Decisions Required
7. **L4: prompts dual store** — `prompts.json` (hot-reload) coexists with the
   DB-backed prompts table (versioned). Pick one as canonical, migrate. Decision
   has UX implications (hot-reload convenience vs DB consistency).
8. **`/generate_formalism/` endpoint fate** — currently DELETED in commit
   `0426786` because handler called undefined `generate_individual_formalism`
   (NameError). If feature is wanted, restore from history and implement the
   missing function. If not, deletion stands.
9. **OpenAI API key rotation** — `lct_python_backend/.env` line 22 still
   contains `sk-proj-LIzt9JLBmS4NavJ41oLKitdq_KJ...`. `.env` was verified
   never committed to git history, so exposure is local-only. User needs to
   rotate the key in OpenAI dashboard and paste the new one.

## Key Context

### Architecture Insights Discovered This Session
- **`local_chat_json` is a delegating shim, not a competing LLM client.** It
  already routes through `gateway().chat()` per ADR-030 §D5 (see
  `services/local_llm_client.py:240-260`). The "three competing LLM modules"
  framing in the original scan was inaccurate. Architecture IS consolidated.
- **`local_chat_json` callers (12 sites) can stay as-is.** Migrating them to
  `gateway().chat()` directly would add ~3 lines per site (need
  `provider_from_legacy_config(config)` + capability enum + `.data` unwrap).
  Net code added, only marginal value (explicit capability at call site).
- **The per-provider STT methods can NOT be extracted as pure free functions
  yet.** Each references `self.session_id`, `self.conversation_id`,
  `self.provider`, `self.model`, `self.language` for fallback defaults and
  logging context. Needs `SttSessionConfig` extraction first.

### Files / Modules Created This Session
- `lct_python_backend/services/env_helpers.py` (90 LOC, 36 tests) — env_str,
  env_bool, env_int, env_float, env_str_or_none
- `lct_python_backend/services/retry_policy.py` (~150 LOC, 13 tests) —
  retry_async_with_backoff, retry_sync_with_backoff, compute_backoff_delay
- `lct_python_backend/services/tuning_constants.py` (~80 LOC) — named
  thresholds with rationale: STREAMING_CONTEXT_WINDOW_SIZE,
  REFINEMENT_HIGHER_TIER_LOSS_THRESHOLD, MIN_IDEAS/TOPICS/THEMES_FOR_*,
  DEFAULT_TAB_MIN_COMPRESSION_RATIO
- `lct_python_backend/services/stt_response_parsers.py` (~150 LOC) — 5
  provider-response parsers (WhisperX, OpenAI, OpenRouter)
- `lct_python_backend/services/stt_circuit_breaker.py` (231 LOC, 31 tests) —
  CircuitBreaker class + error classifiers
- `lct_python_backend/services/import_bulk_helpers.py` (~150 LOC) — ffprobe,
  duration formatting, backend-label resolution, retry classification
- `lct_app/src/components/graphLayout.js` (130 LOC, 7 tests) — Dagre +
  swim-lane layout
- `lct_app/src/components/graphNormalization.js` (114 LOC) — node
  normalization, contextual relation extraction
- `lct_app/src/components/graphClustering.jsx` (415 LOC) — L1/L2/L3 cluster
  builders, cluster-to-RF view
- `docs/adr/ADR-031-post-streaming-hierarchy-consolidation.md`
- `lct_python_backend/tests/unit/test_hierarchy_consolidator.py` (19 tests)
- `lct_python_backend/tests/unit/test_prompt_manager.py` (4 tests)
- `lct_python_backend/tests/unit/test_import_security_guards.py` (28 tests)
- `lct_app/src/components/graphLayout.test.js` (7 tests, first vitest test)

### Files Deleted This Session
- `lct_python_backend/services/live_graph_persistence.py` — DEPRECATED shim
  per ADR-030 §D3, zero importers
- `lct_app/src/components/GenerateFormalism.jsx` — only caller was
  archive/TranscriptApp.jsx (also dead)

### Files Renamed This Session
- `services/factcheck_service.py` → `services/perplexity_factcheck.py`
- `services/fact_check_service.py` → `services/openai_factcheck.py`

### Security Hardening Applied
- `AUTH_TOKEN=nid1L4Zo4quG7HOK3cUPkIX6F8NB90A3JC65mMfR0k8` (32-byte random)
  set in `lct_python_backend/.env`
- Matching `VITE_AUTH_TOKEN` written to `lct_app/.env` (gitignored, verified)
- `DEBUG=false` in `.env`
- Content-type whitelist on `/api/import/process-file` (audio + text suffixes
  allowed; rejects unknown filename+ct combinations)
- SSRF defense-in-depth: `assert_url_resolves_to_public_host` in
  `services/import_validation.py` does DNS resolution + blocks loopback,
  RFC1918, link-local, IMDS. Called by `download_url_text` regardless of
  the upstream `validate_import_url` check.

### Test Infrastructure
- Vitest 3.2.4 + jsdom 25 installed as frontend dev deps
- `npm test` runs vitest, `npm run test:watch` watches
- Vitest config in `lct_app/vite.config.js` (jsdom env, src/**/*.test.{js,jsx})
- e2e (Playwright) stays separate under `tests/`

### Pre-existing Issues Discovered (Not Caused This Session)
- 69 unit tests fail when run with full suite, all pass individually. Asyncio
  event-loop teardown issue in some fixture. Verified pre-existing (same
  pass/fail counts on the cheap-wins commit base).
- `generate_formalism` in `llm_helpers.py` referenced undefined
  `generate_individual_formalism` — endpoint would NameError. Whole endpoint
  was deleted, but if it's wanted back the implementation needs to be written.

### Untracked Files Not Mine
`lct_python_backend/services/consumption_trigger.py`,
`indrasnet_client.py`, and their tests — these existed before this session and
were left untracked throughout. Not part of this session's commits.

## Resume Instructions

1. **First**: rotate the OpenAI API key (only thing in this session that
   needs human action). Replace `sk-proj-LIzt9JLBmS4...` in
   `lct_python_backend/.env` line 22.
2. **Then restart backend + frontend** so `AUTH_TOKEN` and `VITE_AUTH_TOKEN`
   take effect. Backend log should show
   `[SECURITY] Auth: ENFORCED (all non-health routes)`.
3. **Verify with browser** that the conversation list loads (proves frontend
   is sending the bearer token correctly).
4. **Push when ready**: `git push origin main` — 9 commits to publish.
5. **Pick next item** based on bandwidth:
   - 2-3 hr block: SessionConfig refactor (continue C)
   - 1 day: write WS or worker test scaffolding (unblocks H1/mega-function split)
   - 30 min: decide on /generate_formalism (delete-confirmed or restore-and-implement)
   - 1-2 days: pick prompts dual-store canonical and migrate

## Learnings Captured
- [x] Auto-memory: `user-prefers-honest-scope-reduction` — feedback memory
- [x] Auto-memory: `user-prefers-staged-commits-with-honest-partial-framing` — feedback memory
- [x] Auto-memory: `windows-cp1252-utf8-bug-class` — project memory
- [x] ADR-031: post-streaming hierarchy consolidation documented
- [x] INDEX.md backfilled with ADR-030 and ADR-031

---
*Handover by Claude Opus 4.7 (1M context) at session end*
*Previous handover preserved below*

---

# Handover: 2026-04-03

## Session Summary
Major graph UX overhaul: progressive graph generation during file upload (nodes appear in ~30s instead of 30+ min), app-scoped upload context surviving page navigation, card-style graph nodes with summaries, context-sensitive legend, fuzzy edge resolution, minimizable transcript panel, and numerous UI improvements. 17 of 18 tasks completed.

## Commits This Session
- `1b55362` feat: progressive graph gen, app-scoped upload, graph UX overhaul
- `fda5878` ci: add Codex code review workflow
- PUSHED: yes, to `feat/graph-ux-progressive-upload` branch
- PR: anantham/live_conversational_threads#49 (open, awaiting Codex review)

## Pending Threads

### Continue Immediately
1. **Codex review on PR #49** — `@codex review` comment posted but review hasn't triggered. May need to verify Codex GitHub App is installed on the repo (GitHub → Settings → Applications). Code review quota shows 100% available so it's not a quota issue.

### Re-validated
1. **Test buffered refinement pipeline for speaker diarization (#12)** — Previous handover note was stale. Verified on 2026-04-08 that the remote Windows machine at `100.81.65.74` has `TemporalCoordination/grimoire/IndrasNet` present and serving `POST /api/transcribe` from `agents/routes/transcription.py`. That route calls `gpu_backends.transcribe_with_coordinator(...)` with local WhisperX first, Modal WhisperX fallback, `priority=0`, and `coordinator_timeout=5.0`. Remaining work is latency and queue-path validation, not basic WhisperX availability.

### Deferred
1. **BYOK popup on rate limit** — BYOK moved to settings but no popup-on-limit yet. Needs backend signal for quota exhaustion. Low priority.
2. **Full color settings UI** — Edge/node colors hardcoded in graphConstants.js. Fuzzy matching fixed most missing edges. Settings UI deferred.
3. **Manual conversation rename** — Auto-derive from nodes works. Editable title in header not yet built.

## Key Context
- **Branch**: `feat/graph-ux-progressive-upload` based on `codex/fix-stt-cloud-test-observability`
- **Progressive gen architecture**: `on_chunk_progress` in `import_bulk_pipeline.py` accumulates transcript text in `progressive_buffer`. Every ~400 chars, calls `processor.handle_final_text()`. After STT completes, if progressive nodes exist, skips redundant re-analysis loop.
- **Upload context**: `UploadContext.jsx` at App level owns `useFileUploadStream`. Pages subscribe/unsubscribe via `subscribe()` / `unsubscribe()`. Buffered data consumed on mount via `consumeBuffered()`.
- **Two ByokContext files**: `byokContext.js` (lowercase, exports raw context + useByok hook) and `ByokContext.jsx` (uppercase, exports ByokProvider). Import with explicit `.jsx` extension to avoid Vite case-sensitivity issues.
- **Empirical ETA**: `.run/stt_timing_history.json` stores per-backend transcription ratios. First run shows "Calibrating...", subsequent runs show empirical estimate.
- **Timer spam fix**: `transcript_processing.py` had a tight loop when deferred flush timer re-fired with 0ms remaining. Fixed with 2s backoff.
- **Node detail panel bug**: `selectedNodeData` was searching only `latestChunk` (last array element). Fixed to search `allNodes` (flat across all chunks).
- **Duplicate edge keys**: Bidirectional edges (A→B and B→A) produced same key. Fixed with sorted pair + relation type dedup.

## Task List Status (18 total)
### Completed (17)
1. Progressive graph generation during file upload
2. Mini transcript in minimized state (closed captions style)
3. Move BYOK to settings
4. Center button should set readable zoom level
5. Remove zoom preset buttons
6. Move UI tips to settings
7. Timeline ribbon: show timestamps on hover
8. Edge labels and colors (fuzzy resolution)
9. Status pills wired to upload state
10. Verify themes clustering
11. Clean up debug console.logs
13. Conversation auto-rename from nodes
14. Larger graph nodes with summary text
15. Context-sensitive legend
16. Transcript panel light theme
17. Timestamp formatting above line
18. Curved cluster edges

### Remaining (1)
12. Test buffered refinement pipeline (pending: remote IndrasNet WhisperX route exists; validate latency, diarization output, and fallback behavior)

## Learnings Captured
- Progressive gen on cloud STT transport works well — don't need to segment the audio, just segment the transcript
- ReactFlow `const` declaration ordering matters — useEffect deps can't reference variables declared later (temporal dead zone)
- `fitView` with `minZoom` parameter prevents over-zooming on center
- Fuzzy name matching (exact → case-insensitive → substring) dramatically improves edge resolution
- App-scoped context is the right pattern for background tasks in React — page-scoped hooks die on unmount

## Running Processes
- Backend and frontend were started via `start.command` but the background task completed (services may have stopped). Restart with `bash start.command` from project root.

## Resume Instructions
1. Check if Codex review triggered on PR #49
2. If not, investigate GitHub App installation for `live_conversational_threads`
3. Start the app (`bash start.command`) and test the full flow with a file upload
4. Verify: nodes appear progressively, transcript panel works, cluster levels render, edges have colors
5. Test diarization pipeline (#12) against the active IndrasNet route at `100.81.65.74`, and inspect `/api/gpu/status` plus coordinator fallback behavior if latency remains high

---
*Handover by Claude Opus 4.6 at end of session*

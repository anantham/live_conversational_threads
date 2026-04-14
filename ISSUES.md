# ISSUES

Last updated: 2026-04-13

## Verification Follow-ups (2026-04-13)
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py::test_graph_timer_forces_update_when_accumulator_keeps_accumulating` currently fails under local verification because `TranscriptProcessor._run_batch_timer()` defers flush when pending text remains below `graph_min_flush_chars` (default 80 chars), so the test's short `"First finalized transcript chunk."` input never forces a graph update after the timer. Impact: unrelated runtime verification noise during graph-work sessions; blocker status: non-blocking for authored-hierarchy rewrite, but it weakens confidence in timer-path coverage. Recommended next step: decide whether the test fixture should lower `graph_min_flush_chars` explicitly or whether the timer behavior has drifted from the intended product rule and should be changed in code.

## Runtime Blockers (2026-02-10)
- Live/import LLM routing mismatch (confirmed 2026-04-03): import graph generation loads `llm_providers` and can honor the saved provider list, but `/ws/transcripts` only loads `llm_config` and constructs `TranscriptProcessor` without `providers`, so live graph generation silently falls back to `get_default_providers()` from `llm_config.py` instead of the saved provider order/credentials. Impact: live and import can use different LLM backends under the same visible settings, and any serious LLM BYOK implementation must fix the live seam first. Recommended next step: thread runtime provider lists into `WsSessionContext` and standardize runtime LLM overlay behavior across live + import.
- Online STT credential blocker (confirmed 2026-03-20): the currently configured OpenAI audio credential returns `401 Unauthorized` against `https://api.openai.com/v1/audio/transcriptions`, so the online diarized fallback route is configured in settings but will not execute successfully until that key is replaced/rotated.
- `live_conversational_threads` STT defaults point all providers to `ws://localhost:43001/stream`, but no local listener is running on port `43001`.
- Active local Parakeet service (`http://localhost:5092`) is HTTP-only (`/v1/audio/transcriptions`) and does not provide the websocket `/stream` endpoint expected by `AudioInput` provider socket flow.
- Live graph updates from `/ws/transcripts` depend on local LLM generation (`lct_python_backend/services/transcript_processing.py`), but configured LLM base URL `http://100.81.65.74:1234` is intermittently unreachable/timing out; result is no `existing_json` updates even when transcript events are persisted.
- During shutdown, long-running local LLM calls can keep backend workers alive long enough for `start.command` to force-kill the backend process after grace timeout; investigate graceful cancellation/timeout handling in transcript processing path.
- E2E input blocker for cloud-backed media: Google Drive file-provider paths can be present in Finder with size metadata but not materialized locally; direct reads/ffmpeg decode can block indefinitely until file is downloaded (`/Users/aditya/Library/CloudStorage/.../ZOOM0123.MP3` repro).
- Under sustained high-throughput websocket streaming (scripted `audio_chunk` bursts), `final_flush` ack can still take ~28s (`flush_ack_ms=27940` observed on 2026-02-14) even with Gemini mode enabled; likely backlog-dependent in STT/flush sequencing and needs follow-up if low-latency stop behavior is required.
- After the latest flush refactor, `flush_ack` is intentionally near-immediate (~1 ms) but graph updates now arrive asynchronously after ack; clients that disconnect immediately after receiving `flush_ack` can miss late `existing_json`/`chunk_dict` updates unless they keep the socket open briefly.
- During `POST /api/import/process-file` retries on 2026-02-25, STT chunk requests to `http://100.81.65.74:8001/v1/audio/transcriptions` still fail repeatedly with transient transport errors (`ReadError`, `RemoteProtocolError`), so retry/backoff improves resilience but does not fully recover while WhisperX connectivity remains unstable.
- Remote IndrasNet `/api/transcribe` defaults missing `diarize` form fields to `"true"` (confirmed via remote code inspection on 2026-03-08). Callers that omit the field can trigger unexpected diarization latency/GPU load even when their local feature flag is off; fix callers to send `diarize=false` explicitly or change the proxy default.
- Remote IndrasNet GPU overflow path is currently unreliable under contention: a live probe on 2026-03-08 fell through to Modal WhisperX and returned `workspace billing cycle spend limit reached`, so queued/live transcription can fail instead of spilling over cleanly when local WhisperX is busy.
- Path-A local diarization prerequisite gap (2026-02-25): `live_conversational_threads/.venv` currently lacks `torch` and `pyannote.audio`, so enabling `STT_PARAKEET_PYANNOTE_ENABLED=true` will fail fast until optional diarization dependencies are installed in the runtime venv.
- Path-A compatibility gap (2026-02-25): `pyannote.audio==3.1.1` is incompatible with `huggingface_hub>=1.0` (runtime error: unexpected `use_auth_token` argument); local setup requires pinning `huggingface_hub<1.0`.
- Path-A media decoding instability (2026-02-25): direct MP3 diarization path intermittently fails in torchaudio/libmpg123 with tensor-size mismatch (`Expected size 160000 but got 159165`) on some files; converting inputs to PCM WAV before diarization avoids this failure in current testing.
- Local Parakeet content variance (2026-02-25): some short mp4/webm uploads return empty transcripts (no text segments) while equivalent speech WAV clips transcribe correctly; likely codec/content sensitivity that needs a deterministic preprocessing fallback in upload flow.
- ~~Obsidian canvas export gap for upload-generated conversations (2026-02-25)~~ **RESOLVED (2026-03-05)**: `persist_import_graph()` added to `import_persistence.py` and called after `processor.flush()` in `import_bulk_pipeline.py`. `Node`/`Relationship` rows are now materialized for import-flow conversations; `POST /export/obsidian-canvas/{conversation_id}` returns 200.
- ~~Live/headless conversation semantic-persistence gap (confirmed 2026-03-20)~~ **RESOLVED (2026-03-20)**: ADR-019 Phase 1 moved canonical live graph persistence to the backend (`live_graph_persistence.py` + `stt_ws_session.py`). Finalized live/headless graph updates now materialize durable `Node`/`Relationship` rows without depending on the browser autosave hook.
- ~~Imported-audio speaker-materialization gap (confirmed 2026-03-20)~~ **RESOLVED (2026-03-20)**: import audio now persists canonical `Utterance` rows and speaker evidence, and the Anand 10-minute validation conversation (`1349fc27-c9dc-4b97-92e0-571df28c9754`) materialized `79` utterances plus `79` speaker-segment assignments. Paired `.canvas` + `.txt` export now reads from that durable transcript/read-model state instead of an utterance-less fallback.
- Import diarization job observability gap (confirmed 2026-03-20): `import_diarization_queue.py` still keeps job state in memory, so background job ids can disappear after process restarts or when debugging later from a fresh client. Impact: non-blocking for the new immediate import speaker-materialization path, but still weak for operator visibility, retry/debug UX, and long-running background refinement. Recommended next step: move import diarization job state into a durable store and expose terminal job outcomes independently of process lifetime.
- ~~Artifact auto-routing confirmation gap (confirmed 2026-03-21)~~ **RESOLVED (2026-03-21)**: artifact exports are now tracked in `PipelineArtifact`, and renaming speakers from the legend triggers a backend reroute/re-export pass via `POST /api/conversations/{conversation_id}/artifacts/reroute`. The first import still lands safely at the root `Conversations/` folder, but once names are confirmed the paired `.canvas` + `.txt` files can be regenerated into the participant folder without rerunning STT or spending additional API credits.
- ~~Import graph densification semantics gap (confirmed 2026-03-21 on Anand rerun `7c5e5141-1441-4120-bd29-3113a29cca0b`)~~ **RESOLVED (2026-03-21)**: `import_graph_refinement.py` now includes first-pass `contextual_relation` / `edge_relations` / `linked_nodes` in the refinement prompt and rejects any refined graph that collapses previously present contextual structure. Follow-up validation on conversation `8aa49f33-2e0e-4444-806c-318a71c58673` preserved and improved relational richness (`edge_count 40 -> 44`, `contextual_node_count 20 -> 20`, `linked_node_count 20 -> 20`, `tangent_count 0 -> 1`, `return_count 0 -> 3`), and the exported canvas shifted from a single-row strip to a multi-band graph (`21` text nodes, `174` edges, `14` x-columns, `13` y-bands).

## Validation & Testability (2026-04-03)
- Optional dependency import-coupling in backend module graph (confirmed 2026-04-03): importing `import_api` or `transcript_processing` in focused tests currently requires `google-genai`, `pydub`, and `pdfplumber` to be installed because optional LLM/media/parser integrations are imported eagerly at module load time. Impact: unit/integration tests on lean dev environments fail during collection before exercising actual behavior, which hides logic regressions behind workstation setup. Recommended next step: lazy-import optional integrations in production modules or centralize shared stubs in `conftest.py` / test helpers instead of duplicating them per test file.

## Sibling Repo UI Validation Debt (2026-04-09)
- `TemporalCoordination/grimoire/IndrasNet/indras-ui` does not currently offer a clean whole-app TypeScript build signal. `npm run build` hits two kinds of preexisting failure:
  - sandbox-unfriendly writes to `node_modules/.tmp/*.tsbuildinfo`
  - broad unrelated TS errors in untouched files under `_drafts`, `database-viewer`, `media-router`, `DesignPlayground`, and other UI modules
- Impact: non-blocking for the new GPU priority policy feature itself, but blocking for high-confidence frontend validation on future IndrasNet UI work until the baseline is cleaned up or a narrower CI target is introduced.
- Recommended next step: add a targeted UI validation command for production surfaces only, or reduce the existing `indras-ui` TS error floor so feature work can use full `npm run build` as a meaningful signal again.

## Frontend Persistence / Autosave (2026-04-03)

### Duplicate server autosave paths in the browser
- The frontend currently uses two separate server persistence paths for live/new sessions:
  - `lct_app/src/hooks/useAutoSave.js`
  - `lct_app/src/components/audio/useAudioInputEffects.js`
- Both can write conversation state back to the backend, which risks redundant writes and makes it
  harder to reason about future auth-gated save behavior.
- Blocker status: non-blocking for the new IndexedDB latest-draft slice; potentially confusing for
  the upcoming account-auth/save-ownership work.
- Recommended next step: consolidate browser-originated server persistence into one explicit path
  before adding auth-gated saved conversations.

## ADR-018 Edit History Contract Mismatch (2026-03-20)
- `EditHistory.jsx:178` expects `edit.user_comment`, `statistics.by_target_type`, and optional `edit.feedback` — these field names must match whatever the backend API returns. ADR-018 proposes collapsing `EditFeedback` into `annotations` and adding `actor_type`, but the frontend has not been updated to match either the current or proposed contract.
- Semantic overcount risk: if `user_comment` continues to mean "initial edit rationale" (set at creation time), then counting non-null `user_comment` as "feedback count" will overcount — every edit with a rationale will appear as having feedback. ADR-018 should clarify whether `user_comment` is rationale (immutable at creation) or annotation (post-hoc), and the frontend counter logic should match.
- `actor_type` is not yet on the `EditsLog` model (`models/interaction.py`), so the export endpoint cannot filter by actor. This is the real gap for training data export — without it, LLM-suggested edits cannot be excluded.
- Migration assumption bug (confirmed 2026-03-20): `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` originally assumed the legacy `edit_feedback` table always existed and called `op.drop_table('edit_feedback')` unconditionally. On local DBs that never had that table, `alembic upgrade head` stopped at `add_intent_signals`, which in turn blocked later schema work such as Phase 2A utterance speaker columns and broke canvas export with `column utterances.speaker_source does not exist`.
- Alembic version-width bug (confirmed 2026-03-20): the original Phase 2A migration revision id `add_speaker_segments_materialization` was longer than the local `alembic_version.version_num` width, so Alembic could run the DDL and still fail when writing the new version marker (`value too long for type character varying(32)`). This blocks `upgrade head` on local PostgreSQL until the revision id is shortened.
- Blocker status: non-blocking for current usage; blocking for training data export feature.
- Recommended next step: implement ADR-018 decisions on the model layer first (`actor_type` column + migration), then update the API response shape, then update `EditHistory.jsx` to match.

## Divergent Shadow Copies in Frontend (2026-03-20)
- Three `(1)` suffixed files in `lct_app/src/components/` are divergent shadow copies (not byte-identical duplicates): `AudioInput (1).jsx`, `ExportCanvas (1).jsx`, `ThematicView (1).jsx`. They are not imported anywhere but risk accidental use. Should be deleted after confirming no unique code worth preserving.

## Tech Debt Scan Findings (2026-03-19)

### Stale TODOs — Deferred Decisions
- **`analysis_events` table** (`intent_signal_persistence.py:12,101,235`): ADR-013 approved intent signals schema but the `analysis_events` table referenced in 3 TODOs was never created. **Decision: defer.** Intent signal persistence works without it. Remove TODOs and add `analysis_events` as a future schema extension when cross-session signal analytics are built (ADR-016 scope).
- **Alert handlers** (`instrumentation/alerts.py:339,349,359`): Email, Slack, and webhook handlers are stubbed with log-only implementations. **Decision: keep stubs, add deprecation note.** Alerting is not on the near-term roadmap. If a monitoring need arises, integrate with an external service (e.g., PagerDuty, Grafana alerting) rather than building custom delivery.
- **Edit `user_id` from auth** (`edit_history_api.py:58`): Resolved by ADR-018 — replace with role-based `actor_type` field.

### Layer 2 API Mounting
- **`claim_api.py` and `argument_api.py` are not mounted** in `backend.py`. The backend services are fully implemented but the HTTP endpoints are unreachable. **Decision: defer mounting until frontend consumers exist.** The services work as internal modules (called by analysis_api). Mounting them without a frontend would create unused attack surface. When argument tree visualization is built, mount them and add integration tests.

### Pre-existing Security/Settings Bugs (found during PR #44 review)
- **STT cloud API keys silently discarded on save** (`useSttSettingsForm.js:38-49`): `normalizeSttSettings(form)` calls `normalizeCloudFallbackProviders()` which forcibly rewrites every cloud provider's `api_key` to `""` before the save request is sent. Freshly entered OpenAI/OpenRouter keys never reach the backend. The UI looks writable but silently drops credentials. **Pre-existing, not introduced by PR #44.**
- **`AUDIO_DOWNLOAD_TOKEN` leaked to browser** (`stt_config.py:205-217`, `SttDiagnosticsPanel.jsx:160`): `sanitize_stt_config_for_client()` masks cloud provider API keys but leaves `download_token` untouched. The diagnostics panel renders it verbatim. **Pre-existing, not introduced by PR #44.**

### Data-Integrity Bug
- **`_iter_contextual_relations` fallthrough bug** (`import_persistence.py:78-88`): When `_add()` rejects a duplicate or empty relation in list-of-objects input, the code falls through to `item.items()` which yields raw dict keys (`related_node_name`, `relation_text`) as graph node names. This corrupts graph data for any LLM output with duplicate node references. Fix: add `continue` after the `_add` call in the list branch. Documented in `test_import_persistence_helpers.py`.

## Deployment Blockers (2026-04-03)

### VPS public ingress blocked outside host
- Backend bootstrap on `15.223.245.244` succeeded locally: Postgres, `lct-backend`, and Caddy all start; `http://127.0.0.1:8000/api/import/health` returns `200`.
- Public access to `http://15-223-245-244.sslip.io` and `https://15-223-245-244.sslip.io` times out from outside the VPS.
- Caddy/ACME logs show Let’s Encrypt `http-01` and `tls-alpn-01` challenge failures caused by connection timeouts to `15.223.245.244` on ports `80/443`, which strongly suggests an external firewall/security-group rule rather than an application failure.
- Blocker status: blocking public backend deployment and therefore blocking Vercel frontend cutover.
- Recommended next step: open inbound `80/tcp` and `443/tcp` (and keep `22/tcp`) in the VPS provider firewall / AWS security group, then re-run the public smoke test and allow Caddy to obtain the certificate.

## STT Orchestrator Findings (2026-04-08)

### Full IndrasNet startup can hang before port bind on Windows after agent autostart
- After surgically syncing the remote `agents/routes/transcription.py` websocket route and the Python-compat fallback fix to `100.81.65.74`, a controlled restart of the Windows `7777` web server no longer produced the old stale-HTML behavior, but the server still failed to accept traffic.
- Evidence from redirected remote startup logs:
  - `python -m grimoire.IndrasNet.agents.web_server.app` on port `7777` logs `Started server process [...]` and `Waiting for application startup.`, then never reaches `Application startup complete.` and never opens a `LISTEN` socket on `7777`.
  - The same app started with `PYTEST_CURRENT_TEST=1` and `PORT=7778` reaches `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`, proving the base FastAPI app and the new websocket route can boot when the test-skipped startup block is disabled.
- The isolating difference is the lifespan block guarded by `if not os.getenv("PYTEST_CURRENT_TEST")` in `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py`, which auto-starts agents/services and schedules background workers.
- Most likely root cause: Windows multiprocessing spawn during agent autostart. `TemporalCoordination/grimoire/IndrasNet/agents/web_server/agents.py` starts `beeper` / `obsidian` / `meet` via `multiprocessing.get_context("spawn")` during web-server startup; on the affected host, that path repeatedly imports `grimoire.IndrasNet.agents.web_server.app` (matching the repeated `runpy` warnings in stderr) and appears to prevent the parent Uvicorn process from completing startup/binding `7777`.
- Secondary observation: the temporary healthy diagnostic listener on `7778` was reachable on `127.0.0.1` from the Windows host, but timed out from the LCT machine over Tailscale. That suggests a separate external-access/firewall policy on nonstandard ports, but it is not the primary blocker for the real `7777` route.
- Impact: even with the websocket route deployed, the production `7777` web server can fail before bind, leaving LCT unable to reach either `/api/transcribe` or `/api/transcribe/stream`.
- Blocker status: blocking remote end-to-end validation of the orchestrated live websocket path.
- Recommended next step: make agent autostart deferrable or disable it during web-server boot on Windows, then confirm `7777` reaches `Application startup complete.` before re-testing `/api/transcribe/stream`. The lowest-risk diagnostic patch is an explicit env flag to skip only agent autostart (not the whole lifespan), which should confirm whether `start_agent_process(...)` is the true blocker.

### WhisperX websocket proxy on Windows must use `127.0.0.1`, not `localhost`
- During live validation on 2026-04-09, the Tailscale path itself was proven healthy: raw TCP, HTTP, and websocket handshakes to `100.81.65.74:7777` all worked while the remote IndrasNet server was alive.
- The remaining realtime-stream failure came from the orchestrator proxy's upstream hop. On the Windows host:
  - `http://127.0.0.1:8001/health` returned healthy status
  - `ws://127.0.0.1:8001/v1/audio/stream` connected successfully
  - `ws://localhost:8001/v1/audio/stream` timed out during opening handshake
- Root cause: the websocket proxy in `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` built its upstream URL from the WhisperX HTTP base URL and preserved `localhost` in the netloc. On this Windows host, the realtime websocket server is reachable via IPv4 loopback but not via `localhost`.
- Impact: clients could connect to `/api/transcribe/stream` over Tailscale, but the proxy immediately failed when it tried to reach WhisperX upstream, so no transcripts were produced.
- Status: fixed in sibling repo commit `3a999b1 fix(transcription): use IPv4 loopback for whisperx stream proxy`.
- Validation: after the fix, end-to-end websocket transcription through `ws://100.81.65.74:7777/api/transcribe/stream` succeeded from the LCT machine, reducing the sample turnaround from about `29.9s` on the old HTTP path to about `7.6s` on the first streamed run.

### Remote IndrasNet `/api/transcribe` route returns 500 after coordinator timeout
- Reproduced against the active Windows/Tailscale orchestrator at `http://100.81.65.74:7777/api/transcribe` with a short local sample posted from the LCT machine.
- Observed behavior: request spends about `10s` in the orchestrator path and returns `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}` instead of falling back cleanly.
- Root cause in remote orchestrator code: `core/gpu_backends.py:818-823` calls `asyncio.current_task().cancelling()` directly inside the `except asyncio.CancelledError` fallback path. That method exists on Python 3.11+, but the active Windows environment appears to be older (`_asyncio.Task` without `cancelling()`), so the fallback path itself crashes.
- Impact: live and upload callers using the `7777` route can hard-fail instead of degrading to Modal WhisperX when the local GPU slot is busy.
- Recommended next step: patch the remote orchestrator to use the same Python-3.9-safe pattern already present in `core/llm.py` (`getattr(task, "cancelling", lambda: False)()`), then re-test the `7777` path under load.

### Coordinator priority does not forcibly interrupt in-flight WhisperX work
- `agents/routes/transcription.py:75-84` already submits LCT requests at `priority=0` (`CRITICAL`), so there is no higher-priority knob available today for live transcription callers.
- The GPU coordinator can signal preemption (`core/gpu_coordinator.py:233-247`), but the active single-file WhisperX route in `core/gpu_backends.py:797-807` awaits one long HTTP call to `localhost:8001` and only inspects `task.preempt_signal.is_set()` after that call returns.
- Result: a CRITICAL live request can jump the queue for the next slot, but it does not forcibly stop an already-running background WhisperX transcription unless that background workflow is chunked/cooperative. Some reprocessing flows are cooperative (`core/reprocessing/audio.py:221-383`), but the direct `/api/transcribe` path is not.
- Impact: priority helps only at chunk boundaries or between jobs; it does not solve long in-flight background transcriptions monopolizing WhisperX.
- Recommended next step: either route live STT directly to the WhisperX server/streaming path, or make background WhisperX consumers chunked/cooperative so they can yield quickly to CRITICAL live requests.

## Developer Warnings (2026-02-14)
- `lct_app/src/components/ContextualGraph.jsx` and `lct_app/src/components/StructuralGraph.jsx` still emit preexisting `react-hooks/exhaustive-deps` warnings in local lint runs. These do not block runtime but create noisy CI/dev output and should be addressed in a dedicated cleanup PR to avoid mixing legacy graph refactors with the minimal-live-ui scope.
- Frontend production build still emits chunk-size warning (`dist/assets/index-*.js` > 500 kB). This is preexisting technical debt and not introduced by the bulk-upload patch; track for a separate code-splitting pass.
- Runtime settings still lack a unified cross-service readiness model. STT cloud fallback providers now support backend-backed `Save & Test`, but Gemini online credentials, embeddings credentials, and broader runtime confidence/benchmark states are still env-driven or probe-limited.
- Repo-wide `npm run lint` is currently red from a large preexisting ESLint backlog across unrelated UI files (`playwright.config.js`, thematic/formalism/export helpers, older graph components, analysis pages, etc.). New runtime-settings work can be linted file-by-file, but full frontend lint is not yet a reliable validation gate until that backlog is cleaned up.
- Remote STT topology documentation remains partially stale: `docs/HANDOVER.md` was corrected on 2026-04-08 after verifying the active `TemporalCoordination/grimoire/IndrasNet` orchestrator on `100.81.65.74`, but backend comments in `lct_python_backend/import_api.py` still describe the WhisperX route as `127.0.0.1:7777` / "local WhisperX". Keep repo docs and comments aligned with the verified Tailscale endpoint `http://100.81.65.74:7777/api/transcribe`.
- Validation on 2026-04-08 after the local Option B implementation found a deployment gap on the remote Windows host: `POST http://100.81.65.74:7777/api/transcribe` now succeeds again, but a 2.75s speech sample still took `29.9s` end-to-end and returned `_backend=local_whisperx`, which is too slow for live use.
- The new websocket route is not live on the remote host yet: `ws://100.81.65.74:7777/api/transcribe/stream` rejects the websocket handshake with plain `HTTP 200` HTML, and a read-only remote file check showed `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` does not yet contain `/api/transcribe/stream`. The listening Python process on port `7777` started at `2026-04-06T15:30:25.753Z`, so the remote service is still serving stale code relative to the local repo changes.
- Read-only SSH investigation on 2026-04-08 showed the remote `7777` listener is launched from the expected `TemporalCoordination\grimoire\IndrasNet` tree (`...\.venv\Scripts\python.exe agents/web_server.py` spawning `C:\Users\adity\anaconda3\python.exe agents/web_server.py`), so this is not a wrong-checkout problem. However, the remote `IndrasNet` repo itself is on branch `main` at commit `92bcbeb` and has many unrelated uncommitted changes. That makes `git pull` / branch switching on the Windows host risky; deploy should be a surgical sync of the touched transcription files plus a controlled restart.
- Recommended next step: sync/deploy the IndrasNet `agents/routes/transcription.py` websocket proxy changes to the remote host and restart the `7777` service before judging the live websocket path. After deployment, re-run the websocket smoke test and measure time-to-ready / time-to-final against the same sample.

## Resolved (2026-02-13)
- Alembic DAG/startup blocker resolved:
  - Fixed broken revision links in `lct_python_backend/alembic/versions/*`.
  - Made transcript settings migration idempotent for pre-existing local tables.
  - Shortened transcript migration revision ID to fit `alembic_version.version_num` width.
  - `alembic upgrade head` now succeeds in local startup flow.

## Recording & Data Retention
- Live capture does not store raw audio; cannot re-run improved ASR/diarization later.
- Browser mic session blocks parallel recorders; no way to capture a backup/high-fidelity stream alongside LCT.
- No per-speaker channel capture; group recordings are single-mix, making diarization/prayer detection harder.
- Request: speaker diarization support (e.g., HF `nvidia/diar_streaming_sortformer_4spk-v2`).
- Request: hardware/software path to record separate channels for each participant; open question on viable multi-channel mic hardware.
- Request: prayer mic drops (Aayush, Kuil) with channel-level handling; defer to integrate with Indra's Net.

## Models & Selection
- ASR quality ceiling; no UI to choose models or switch to local models (e.g., TheWhisper).
- Need model selection UI + backend routing; desire to run locally and choose microphone device in Settings.
- No way to pick a microphone input device today.

## Live vs Import Parity
- Live view lacks edge inspection; cannot click edges to see why nodes connect.
- Live view lacks thematic generation/inspection; only available after import/persisted transcript.
- Live sessions only persist on manual save; tab loss drops data and prevents mid-session analysis.

## Graph & UI Polish
- Imported audio/export graphs now preserve richer contextual edges and community-aware layout, but node granularity is still biased toward high-level topic chapters rather than finer tangents/returns. A later pass should either add subthread extraction or a second-pass graph refinement step so visually branchy canvases also surface richer thread structure.
- Layout should aim to minimize edge crossings; start with the simplest viable layout option (e.g., current default before exploring layered/Sugiyama) and iterate.
- Need a user setting to hide arrows/edges entirely (Matt’s preference) and to reduce motion.
- Edge animations/colors are distracting; need toggles to reduce motion/adjust theme.
- Auto-focus/follow request: keep view aligned as the conversation progresses.
- Want a toggle so clicking a node pulls linked nodes into the current view (to avoid offscreen neighbors).
- Need a way to surface all related nodes when edges leave the viewport (e.g., related-node tray or auto-cluster).

## Timeline View Friction
- Too many degrees of freedom; frequent zoom adjustments required—needs fixed/preset zoom levels and constrained zoom.
- Edges/flow should be left-to-right for readability.
- Clicking a node in timeline should sync focus/scope in the top view.
- Horizontal scrolling should be easy/smooth.

## Infrastructure / Runtime Drift
- IndrasNet Windows Scheduled Task `\IndrasNet-WebServer` was previously bypassed by a manual debug launcher `C:\Users\adity\run_web_server_skip_agents.ps1` that forced `INDRAS_SKIP_AGENT_AUTOSTART=1`; this disabled Beeper/Meet/Obsidian autostarts even though DB autostart settings were enabled. Status: mitigated in ops by repointing the task to the repo-owned `scripts/start_web_server_task.cmd` wrapper, but the historical drift explains earlier missing-ingestion incidents.
- The healthy scheduled-task launch still results in a two-step Python chain (`.venv\Scripts\python.exe` parent spawning `C:\Users\adity\anaconda3\python.exe -m grimoire.IndrasNet.agents.web_server.app`) and repeated `runpy` warnings. Impact: currently non-blocking because `7777` binds and agents autostart, but startup behavior remains harder to reason about. Recommended next step: trace why the app re-enters through `anaconda3\python.exe` and whether a single-interpreter launch path is possible.
- Remote Whisper finalization issue was traced to deployment drift at the real WSL `8001` service. The actual listener is a WSL `uvicorn whisperx_server:app` process importing `/home/adity/whisperx_server.py` from working directory `/mnt/c/Users/adity/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/services/transcription`. Impact: the finalization patch was already on disk but a stale long-running process kept serving pre-fix behavior until the WSL uvicorn process was restarted. Current status: mitigated; raw direct websocket validation now returns an `is_final=true` transcript before `done`. Recommended next step: make the WSL WhisperX service launch/restart path explicit and durable so future code syncs do not leave `8001` serving stale logic.
- The WSL WhisperX launch path had a second durability trap even after ownership was standardized: the remote mounted `run_whisperx_server.sh` could carry CRLF line endings, causing `bash` to fail on `set -euo pipefail` while the local repo copy remained healthy. Current status: mitigated manually on the host and guarded in-repo by `TemporalCoordination/.gitattributes` (`*.sh text eol=lf`). Recommended next step: ensure the remote sync/deploy path uses Git checkout semantics or another LF-preserving mechanism, not ad hoc file writes that can reintroduce CRLF.
- After introducing the two-phase `flush_ack`/`flush_complete` contract for `/ws/transcripts`, a real end-to-end Whisper benchmark on a 60s slice still produced `0` transcript events and only `graph_patch` updates. The new protocol exposed the actual blocker: post-flush processing now fails with `badly formed hexadecimal UUID string` before final transcript events can be sent to the client. Impact: the early-close protocol bug is fixed, but Whisper-backed live sessions still do not deliver transcript events end-to-end because a later persistence/graph path crashes during flush. Recommended next step: investigate the UUID parse failure inside `lct_python_backend/services/stt_ws_session.py` post-flush processing, likely around utterance/speaker reconciliation or graph persistence on benchmark-created conversation/session IDs.
- Real browser-driven Whisper validation on April 9, 2026 showed the UUID-error diagnosis above was too narrow. With valid browser-generated UUIDs, Whisper now delivers live transcript events end-to-end (`11` partials, `1` final), but `/ws/transcripts` still never sends `flush_complete` before the frontend’s `6000ms` stop timeout. Root cause from code inspection: `lct_python_backend/services/stt_ws_session.py` sends `flush_complete` only after `TranscriptProcessor.flush()` and `_ensure_graph_persisted(reason="final_flush")`, while `lct_python_backend/services/transcript_processing.py` can synchronously invoke `generate_lct_json(...)` during that flush. Impact: the client closes even after receiving a valid Whisper final because `flush_complete` is coupled to slow graph/LLM persistence work rather than transcript completion alone. Recommended next step: decouple transcript-complete signaling from graph completion, or substantially relax the frontend stop timeout if preserving the current contract.
- The `flush_complete` coupling issue above is now fixed. `lct_python_backend/services/stt_ws_session.py` emits `flush_complete` after transcript flush + `audio_ready`, before slow graph generation/persistence. Current residual issue after the real browser rerun: Whisper transport shutdown is healthy, but the specific validation run still produced only partial transcript events and no final transcript before `flush_complete`. Impact: users should no longer hit a client-side stop timeout just because graph work is slow, but Whisper finalization quality/availability remains inconsistent. Recommended next step: investigate upstream Whisper end-of-session final behavior and whether LCT should synthesize/promote a final when backend-websocket Whisper ends with only partials.

## Priorities & Scope
- Focus first on core transcript viewing/search/retrieval and navigation; defer pipeline steps (e.g., contextual progress markers/formalism triggers) until basics are solid.

## User Stories (When/Why)
- Primary: After a live or imported meeting, I need to quickly surface decisions, action items, and supporting quotes, then export/share them for slides, docs, or follow-up messages with minimal navigation overhead.
- Creative: During a brainstorming session, I want the graph to auto-cluster related ideas and let me hide edges so I can drag a “storyline” into a deck outline without visual clutter.
- Creative: While reviewing a contentious discussion, I want to click a node and have all related nodes pulled into view, then generate a concise narrative I can fact-check before sharing with stakeholders.
- Creative: In a workshop, I want a smooth left-to-right timeline with fixed zoom presets so I can jump between moments, bookmark highlights, and later re-run higher-quality ASR/diarization on the stored audio for a polished recap.

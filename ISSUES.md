# ISSUES

Last updated: 2026-03-20

## Runtime Blockers (2026-02-10)
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
- Live/headless conversation semantic-persistence gap (confirmed 2026-03-20): live websocket sessions and headless replays can produce transcript finals, graph patches, and speaker-reconciliation patches without producing durable `Node` rows unless the browser autosave hook hits `PATCH /conversations/{id}/graph`. Impact: export/read parity breaks; headless replay can collapse long same-speaker spans into one fallback node even when live graph state was richer in memory. Blocker status: non-blocking for realtime captions, blocking for canonical export correctness. Recommended next step: implement backend-owned semantic graph materialization per ADR-019 before adding automatic txt/canvas artifact export.

## ADR-018 Edit History Contract Mismatch (2026-03-20)
- `EditHistory.jsx:178` expects `edit.user_comment`, `statistics.by_target_type`, and optional `edit.feedback` — these field names must match whatever the backend API returns. ADR-018 proposes collapsing `EditFeedback` into `annotations` and adding `actor_type`, but the frontend has not been updated to match either the current or proposed contract.
- Semantic overcount risk: if `user_comment` continues to mean "initial edit rationale" (set at creation time), then counting non-null `user_comment` as "feedback count" will overcount — every edit with a rationale will appear as having feedback. ADR-018 should clarify whether `user_comment` is rationale (immutable at creation) or annotation (post-hoc), and the frontend counter logic should match.
- `actor_type` is not yet on the `EditsLog` model (`models/interaction.py`), so the export endpoint cannot filter by actor. This is the real gap for training data export — without it, LLM-suggested edits cannot be excluded.
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

## Developer Warnings (2026-02-14)
- `lct_app/src/components/ContextualGraph.jsx` and `lct_app/src/components/StructuralGraph.jsx` still emit preexisting `react-hooks/exhaustive-deps` warnings in local lint runs. These do not block runtime but create noisy CI/dev output and should be addressed in a dedicated cleanup PR to avoid mixing legacy graph refactors with the minimal-live-ui scope.
- Frontend production build still emits chunk-size warning (`dist/assets/index-*.js` > 500 kB). This is preexisting technical debt and not introduced by the bulk-upload patch; track for a separate code-splitting pass.
- Runtime settings still lack a unified cross-service readiness model. STT cloud fallback providers now support backend-backed `Save & Test`, but Gemini online credentials, embeddings credentials, and broader runtime confidence/benchmark states are still env-driven or probe-limited.
- Repo-wide `npm run lint` is currently red from a large preexisting ESLint backlog across unrelated UI files (`playwright.config.js`, thematic/formalism/export helpers, older graph components, analysis pages, etc.). New runtime-settings work can be linted file-by-file, but full frontend lint is not yet a reliable validation gate until that backlog is cleaned up.

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

## Priorities & Scope
- Focus first on core transcript viewing/search/retrieval and navigation; defer pipeline steps (e.g., contextual progress markers/formalism triggers) until basics are solid.

## User Stories (When/Why)
- Primary: After a live or imported meeting, I need to quickly surface decisions, action items, and supporting quotes, then export/share them for slides, docs, or follow-up messages with minimal navigation overhead.
- Creative: During a brainstorming session, I want the graph to auto-cluster related ideas and let me hide edges so I can drag a “storyline” into a deck outline without visual clutter.
- Creative: While reviewing a contentious discussion, I want to click a node and have all related nodes pulled into view, then generate a concise narrative I can fact-check before sharing with stakeholders.
- Creative: In a workshop, I want a smooth left-to-right timeline with fixed zoom presets so I can jump between moments, bookmark highlights, and later re-run higher-quality ASR/diarization on the stored audio for a polished recap.

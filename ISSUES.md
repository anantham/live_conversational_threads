# ISSUES

Last updated: 2026-02-14

## Runtime Blockers (2026-02-10)
- `live_conversational_threads` STT defaults point all providers to `ws://localhost:43001/stream`, but no local listener is running on port `43001`.
- Active local Parakeet service (`http://localhost:5092`) is HTTP-only (`/v1/audio/transcriptions`) and does not provide the websocket `/stream` endpoint expected by `AudioInput` provider socket flow.
- Live graph updates from `/ws/transcripts` depend on local LLM generation (`lct_python_backend/services/transcript_processing.py`), but configured LLM base URL `http://100.81.65.74:1234` is intermittently unreachable/timing out; result is no `existing_json` updates even when transcript events are persisted.
- During shutdown, long-running local LLM calls can keep backend workers alive long enough for `start.command` to force-kill the backend process after grace timeout; investigate graceful cancellation/timeout handling in transcript processing path.
- E2E input blocker for cloud-backed media: Google Drive file-provider paths can be present in Finder with size metadata but not materialized locally; direct reads/ffmpeg decode can block indefinitely until file is downloaded (`/Users/aditya/Library/CloudStorage/.../ZOOM0123.MP3` repro).
- Under sustained high-throughput websocket streaming (scripted `audio_chunk` bursts), `final_flush` ack can still take ~28s (`flush_ack_ms=27940` observed on 2026-02-14) even with Gemini mode enabled; likely backlog-dependent in STT/flush sequencing and needs follow-up if low-latency stop behavior is required.
- After the latest flush refactor, `flush_ack` is intentionally near-immediate (~1 ms) but graph updates now arrive asynchronously after ack; clients that disconnect immediately after receiving `flush_ack` can miss late `existing_json`/`chunk_dict` updates unless they keep the socket open briefly.

## Developer Warnings (2026-02-14)
- `lct_app/src/components/ContextualGraph.jsx` and `lct_app/src/components/StructuralGraph.jsx` still emit preexisting `react-hooks/exhaustive-deps` warnings in local lint runs. These do not block runtime but create noisy CI/dev output and should be addressed in a dedicated cleanup PR to avoid mixing legacy graph refactors with the minimal-live-ui scope.
- Frontend production build still emits chunk-size warning (`dist/assets/index-*.js` > 500 kB). This is preexisting technical debt and not introduced by the bulk-upload patch; track for a separate code-splitting pass.

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

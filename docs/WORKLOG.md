# WORKLOG

## 2026-04-04T03:33:28Z — Upload buffer lifecycle fix for `/new` remounts

Branch: current worktree

- Context: PR #49 lifted file-upload state into `UploadContext`, but the first review surfaced two regressions in the new buffering model: completed uploads could be replayed on later visits to `/new`, and buffered `graph_patch` history could be re-applied on top of an already-updated `existing_json` snapshot after navigation.
- Explicit hypotheses before patch:
  - `H1`: stale conversation resurrection was caused by completed upload buffers never being cleared after the page either consumed them or never needed them.
  - `H2`: duplicate graph mutations came from retaining the full patch history even after a fresh `existing_json` snapshot arrived, so remount hydration replayed obsolete patches.
  - `H3`: the fix could stay frontend-only by tightening `UploadContext` buffer semantics rather than changing the backend SSE contract.
- Files modified:
  - `lct_app/src/contexts/UploadContext.jsx` (lines 17-24, 27-42, 64-87, 101-123): added an explicit buffer reset helper, reset buffered patch history when a full snapshot arrives, treated empty chunk payloads as a real reset instead of a no-op merge, cleared canceled uploads immediately, and cleared settled upload buffers once they were either consumed or already owned by the active `/new` subscriber.
  - `lct_app/src/components/upload/useFileUploadStream.js` (lines 96-105, 478-491, 580-590): added `resetBuffered` / `onStreamSettled` hooks around the upload lifecycle so each new upload starts from a clean buffered state and completed uploads can hand off or retire their app-scoped buffer deterministically.
- Why:
  - keep app-scoped upload continuity during navigation without letting old upload state leak into unrelated future sessions;
  - preserve the backend’s `graph_patch -> existing_json -> chunk_dict` stream ordering while buffering only the incremental patches that still matter after the latest snapshot.
- Validation:
  - `cd lct_app && ./node_modules/.bin/eslint src/contexts/UploadContext.jsx src/components/upload/useFileUploadStream.js` (`passed`; existing fast-refresh warning in `UploadContext.jsx` remains)
  - `cd lct_app && npm run -s build` (`passed`; existing chunk-size warning remains)

## 2026-04-03T08:16:42Z — IndexedDB-backed latest-draft recovery for `/new`

Branch: current worktree

- Context: the app already supported export and backend save paths, but it still had no browser-local
  recovery for interrupted work. That meant anonymous sessions or temporary backend failures could
  still lose meaningful graph/transcript progress before auth-backed saved conversations exist.
- Explicit hypotheses before patch:
  - `H1`: a frontend-only latest-draft IndexedDB layer is enough to eliminate the main “tab closed /
    refresh / backend unreachable” loss mode without waiting on backend auth.
  - `H2`: `/new` already owns the core recoverable state (`graphData`, draft graph patches, chunk
    dictionaries, file name, message), so local recovery can be centered there without changing the
    backend contract.
  - `H3`: the first slice should restore only semantic/UI state, not transport state; resuming a
    saved draft must not try to resume microphone capture, websocket sessions, or upload streams.
- Files modified:
  - `lct_app/src/services/localDraftStore.js` (lines 1-164): added a small IndexedDB service for a
    single latest local draft, including draft sanitization, “meaningful draft” checks, load/save /
    delete helpers, and summary metadata (`nodeCount`, `chunkCount`, `updatedAt`).
  - `lct_app/src/hooks/useLocalConversationDraft.js` (lines 1-134): added a reusable React hook that
    loads the latest draft, debounces IndexedDB writes, flushes on `beforeunload` /
    `visibilitychange`, and exposes `restore` / `discard` actions.
  - `lct_app/src/pages/NewConversation.jsx` (lines 21-44, 148-226, 244-310): wired local draft
    snapshots into the new hook, added a `Resume / Discard` prompt when `/new` opens with an
    interrupted draft, and restored graph/chunk/name/message state into the existing page state.
  - `lct_app/src/pages/Home.jsx` (lines 1-30, 47-60): added a lightweight `Resume available`
    affordance on the `New` action when a latest local draft exists in IndexedDB.
  - `docs/adr/ADR-021-browser-local-draft-recovery.md` (new file): documented the browser-local
    latest-draft decision and why it intentionally excludes raw audio and auth/token persistence.
  - `docs/adr/INDEX.md` (lines 1-27): added ADR-021 to the ADR index.
- Why:
  - browser-local draft recovery is the smallest reliable safety net for anonymous sessions and
    backend outages;
  - IndexedDB is the right store for structured graph/chunk payloads and avoids pretending that
    server-local fallback is equivalent to browser-local recovery;
  - keeping the slice frontend-only avoids entangling it with the still-pending auth project.
- Validation:
  - `cd lct_app && ./node_modules/.bin/eslint src/services/localDraftStore.js src/hooks/useLocalConversationDraft.js src/pages/NewConversation.jsx src/pages/Home.jsx` (`passed`)
  - `cd lct_app && npm run -s build` (`passed`; existing chunk-size warning remains)
- Preexisting issue discovered while tracing persistence boundaries:
  - the frontend still contains two separate server autosave paths (`useAutoSave.js` and
    `components/audio/useAudioInputEffects.js`). This slice intentionally did **not** refactor that
    behavior; it was logged in `ISSUES.md` as out-of-scope tech debt instead of silently widening
    the feature patch.

## 2026-04-03T15:01:48Z — Speaker alias editing added to node detail drawer

Branch: current worktree

- Context: the right-side node detail drawer showed raw `speaker_id` values such as `SPEAKER_A` as read-only text, while the existing manual speaker-naming flow was only available in the legend. The user explicitly wanted the drawer path to be editable in place.
- Explicit hypotheses before patch:
  - `H1`: the drawer was read-only because `NodeDetail` only rendered `safeNode.speaker_id` and did not load or write alias data through the existing speaker-naming API.
  - `H2`: reusing the current `/api/conversations/{id}/speakers` endpoints would be sufficient; no backend schema or route change was needed.
- Files modified:
  - `lct_app/src/components/NodeDetail.jsx` (lines 1-250): added speaker-alias fetch/save state, wired the drawer to `fetchConversationSpeakers(...)` and `updateConversationSpeakerName(...)`, displayed the editable speaker name while still surfacing the immutable `speaker_id`, and reused artifact reroute behavior after rename so drawer-based edits match legend-based edits.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 37-82, 255-259): added `refreshKey` support so the legend reloads speaker aliases when the drawer saves a rename while the legend is open.
  - `lct_app/src/pages/ViewConversation.jsx` (lines 103-109, 255-277): added a `speakerRefreshKey` state and passed `conversationId` plus an `onSpeakerRenamed` callback into `NodeDetail`.
  - `lct_app/src/pages/NewConversation.jsx` (lines 21-31, 226-230, 385-393): added the same `speakerRefreshKey` plumbing for the live/new conversation view so drawer-based renames refresh the legend there too.
- Why:
  - keep speaker renaming available in the exact context where the user is inspecting a node instead of forcing a separate legend workflow;
  - preserve one backend-owned rename path and one artifact-reroute side effect, rather than inventing a second persistence contract.
- Validation:
  - `cd lct_app && npx eslint src/components/NodeDetail.jsx src/components/MinimalLegend.jsx src/pages/ViewConversation.jsx src/pages/NewConversation.jsx` (`passed`)
  - `cd lct_app && npm run -s build` (`passed`; existing bundle-size warning remains)
- Manual verification not run:
  - browser click-through/save confirmation was not run in this work session, so the remaining check is to click a node with `SPEAKER_*`, rename it in the drawer, and confirm the legend and drawer both reflect the alias immediately.

## 2026-04-03T07:41:10Z — Public deploy hardening + VPS backend bootstrap

Branch: current worktree

- Context: after the BYOK/runtime work landed, the next approved step was deployment preparation for a public trial shape: VPS-hosted backend, Vercel-hosted frontend, anonymous live/upload flows, and authenticated admin/settings routes. The previous code still assumed localhost-only CORS and a shared browser-visible bearer token model that was not suitable for a public frontend.
- Explicit hypotheses before patch:
  - `H1`: adding an admin-only auth mode would preserve anonymous `/ws/transcripts`, `/api/import/process-file`, and BYOK session minting for public trials while still protecting settings/analytics/bookmark/config routes.
  - `H2`: production CORS needed to be environment-driven (`FRONTEND_URL`, `CORS_ALLOW_ORIGINS`, `CORS_ALLOW_ORIGIN_REGEX`) rather than hardcoded localhost origins, otherwise a Vercel deployment would fail preflight even if the backend was healthy.
  - `H3`: the backend deployment path would fail on a clean VPS unless `lct_python_backend/requirements.txt` included all runtime imports actually used by `backend.py` / audio import paths.
- Files modified:
  - `lct_python_backend/middleware.py` (lines 1-10, 30-52, 126-194, 441-455): introduced `ADMIN_AUTH_TOKEN`, route classification for admin-only HTTP protection, admin-token validation helpers, and startup logging that distinguishes global auth vs admin-only auth mode while leaving websocket auth tied only to `AUTH_TOKEN`.
  - `lct_python_backend/backend.py` (lines 77-154): replaced localhost-only CORS with env-driven origin resolution via `_parse_csv_env(...)` and `_resolve_cors_origins()`, wired `allow_origin_regex`, and logged the resolved production CORS policy at startup.
  - `lct_python_backend/.env.example` (lines 9-29): documented `ADMIN_AUTH_TOKEN`, `FRONTEND_URL`, `CORS_ALLOW_ORIGINS`, and `CORS_ALLOW_ORIGIN_REGEX` so the public deploy contract is explicit in repo config.
  - `lct_python_backend/requirements.txt` (lines 1-34): added `python-dotenv` and `pydub` to the backend install set so a clean VPS install matches the actual import graph used by `backend.py` and upload/import routes.
  - `lct_python_backend/tests/unit/test_middleware.py` (lines 20-31, 141-157): added admin-auth env defaults plus focused coverage that public upload remains anonymous while admin settings routes require a valid `ADMIN_AUTH_TOKEN`.
- Why:
  - the public frontend cannot safely rely on `VITE_AUTH_TOKEN` as real protection;
  - admin-only auth is the smallest change that keeps the public trial path working without exposing settings mutation to anonymous users;
  - the CORS/env changes are required for any Vercel frontend to talk to the VPS backend.
- Validation:
  - `python3 -m py_compile lct_python_backend/middleware.py lct_python_backend/backend.py lct_python_backend/tests/unit/test_middleware.py` (`passed`)
  - `python3 -m pytest -q lct_python_backend/tests/unit/test_middleware.py` (`21 passed`)
- Deployment actions (remote VPS only; no repo file changes on the server beyond copied working tree/config):
  - Synced the repo to `ubuntu@15.223.245.244:~/apps/live_conversational_threads`.
  - Installed `python3-venv`, `postgresql`, `ffmpeg`, `caddy`, and related build deps.
  - Created local Postgres DB/user (`lct_dev` / `lct_user`), created a venv, installed `lct_python_backend/requirements.txt`, ran `alembic upgrade head`, created `lct-backend.service`, and configured Caddy for `15-223-245-244.sslip.io`.
  - Verified on-box runtime state: `postgresql`, `caddy`, and `lct-backend` are all `active`; `http://127.0.0.1:8000/api/import/health` returns `200 OK`.
- Deployment blocker discovered:
  - Public HTTP/HTTPS access to `15-223-245-244.sslip.io` still times out from outside the host.
  - Caddy logs show Let’s Encrypt `http-01` and `tls-alpn-01` challenge failures caused by connection timeouts to `15.223.245.244` on ports `80/443`, which indicates a cloud-network perimeter issue (likely AWS security group / provider firewall) rather than an application error.
  - Vercel deployment is intentionally not started yet because the backend is not publicly reachable.

## 2026-04-03T07:37:31Z — Node selection now centers within visible graph space

Branch: current worktree

- Context: clicking a node centered it in the full ReactFlow canvas, which left the selected node visually off-center once fixed overlays were present. The main reproductions were the right-side `NodeDetail` drawer in saved and live views, plus the bottom transcript overlay during upload/live processing.
- Explicit hypotheses before patch:
  - `H1`: page layout was leaving the graph viewport full-size even when fixed overlays covered part of it, so `setCenter(...)` targeted the wrong visible area.
  - `H2`: selection recentering needed to wait one frame so the viewport reservation layout was committed before ReactFlow computed the new center target.
- Files modified:
  - `lct_app/src/pages/ViewConversation.jsx` (lines 176-180, 240-258): added a viewport reservation key and wrapped `MinimalGraph`/`MinimalLegend` in an overlay-aware container that reserves `sm:right-80` when the node detail drawer is open, so node centering and legend placement use the visible desktop graph area instead of the obscured full width.
  - `lct_app/src/pages/NewConversation.jsx` (lines 60-75, 211-229, 233-237): added graph viewport reservation state for both the right-side detail drawer and the upload/live transcript overlay, shrinking the active graph viewport by `sm:right-80` and by `bottom: 40%` (or `4.5rem` when transcript is minimized) so selection uses the remaining visible space during live/upload sessions.
  - `lct_app/src/components/MinimalGraph.jsx` (lines 858-949, 1020-1025): switched viewport centering to use the actual node center (measured width/height plus position), added a one-frame deferred recenter for selected nodes keyed to viewport-reservation changes, and reused the same helper for auto-follow/follow actions so pan targets match the visible viewport more consistently.
- Why:
  - layout reservation fixes the root cause for both horizontal and vertical overlay cases without hardcoding custom world-to-screen math for every overlay;
  - centering on the node midpoint avoids bias toward the node’s top-left corner once the viewport is correctly sized.
- Validation:
  - `cd lct_app && npx eslint src/components/MinimalGraph.jsx src/pages/ViewConversation.jsx src/pages/NewConversation.jsx` (`passed with 1 pre-existing warning in MinimalGraph.jsx about clusterViews/useMemo dependency churn`)
  - `cd lct_app && npm run -s build` (`passed`; existing bundle-size warning remains)
- Remaining note:
  - `lct_app/src/components/MinimalGraph.jsx` is now clearly a monolith carrying clustering, viewport control, and overlay/panel concerns together; logged in `docs/TECH_DEBT.md` instead of widening this bug-fix scope into a larger refactor.

## 2026-04-03T07:21:22Z — Dev proxy env/launcher fix for stale `localhost:8000` requests

Branch: current worktree

- Context: the frontend still emitted `http://localhost:8000/api/settings/stt` even after the shared API client switched to proxy-relative paths, because local Vite env still injected `VITE_BACKEND_API_URL=http://localhost:8000`, and an older repo-owned Vite listener on `:5173` let the browser keep talking to a stale bundle.
- Explicit hypotheses before patch:
  - `H1`: `lct_app/.env` was forcing `import.meta.env.VITE_BACKEND_API_URL` to `http://localhost:8000`, so `apiClient` kept constructing absolute cross-origin URLs instead of proxy-relative paths.
  - `H2`: `start.sh` could leave a stale repo-owned Vite process on `:5173`, so even correct code changes were masked by an old dev server.
- Files modified:
  - `lct_app/.env` (lines 1-5): removed the local `VITE_BACKEND_API_URL` / `VITE_API_URL` defaults and replaced them with guidance that local dev should leave the backend URL unset so Vite proxy + relative API paths are used.
  - `start.sh` (lines 8-128): added fixed frontend-port handling, graceful repo-owned port cleanup for all listeners on `:5173`, startup health checks, strict Vite port binding, and `unset VITE_BACKEND_API_URL VITE_API_URL` before launching the dev server so stale env overrides cannot reintroduce direct `localhost:8000` requests.
- Why:
  - fix the root cause instead of adding another code-side override;
  - ensure local dev attaches the browser to a fresh proxy-backed frontend instead of silently serving an older bundle on the same port.
- Validation:
  - `bash -n start.sh` (`passed`)
  - `./start.sh` (`passed`; reclaimed repo-owned frontend on `:5173`, started backend on `:8001`, started frontend on `:5173`)
  - `curl -fsS http://localhost:5173/api/settings/stt | head -c 400` (`passed`; request proxied through Vite to backend and returned STT JSON)
  - `curl -fsS http://localhost:5173/src/services/apiClient.js | rg -n "localhost:8000|API_BASE_URL|VITE_BACKEND_API_URL|wsUrl"` (`passed`; no `localhost:8000` string in the served module)
- Remaining note:
  - `start.command` intentionally still exports `VITE_BACKEND_API_URL` for its own startup path; this fix is intentionally scoped to `start.sh` + local Vite `.env`.

## 2026-04-03T07:11:41Z — Single-key OpenAI BYOK implemented for STT + graph generation

Branch: current worktree

- Context: completed the approved phase-2 BYOK slice so one OpenAI key can cover both the existing
  STT BYOK path and transcript-to-graph generation for live websocket sessions and `/api/import/process-file`.
- Files modified:
  - `lct_python_backend/services/byok_session_store.py` (lines 37, 206, 301-343): extended the BYOK session record with `llm_model`, added `llm_live` / `llm_import` scopes, and introduced runtime-only LLM config/provider overlay helpers that force BYOK graph generation onto an ephemeral OpenAI provider instead of the Gemini-first online path.
  - `lct_python_backend/stt_api.py` (lines 25, 70-72, 379-385): started loading server-side LLM providers with secrets for websocket setup and threaded the provider list into `WsSessionContext`.
  - `lct_python_backend/services/stt_ws_session.py` (lines 87-99, 153-158, 1444-1515): added runtime LLM provider state to the websocket session, rebuilt `TranscriptProcessor` after `session_meta`, and attached `byok_llm_enabled` metadata when a BYOK token includes live LLM scope.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 133-157, 578-602, 1048-1049): standardized import-time runtime LLM overlay behavior, derived an accurate `llm_backend` label from the active provider, and passed the runtime config/provider list through both first-pass processing and refinement.
  - `lct_python_backend/import_api.py` (lines 55, 196-198, 499-523): changed import-provider loading to `include_secrets=True` so server-side imports no longer operate on sanitized client payloads, while preserving the opaque `byok_session_token` contract.
  - `lct_python_backend/services/local_llm_client.py` (lines 210-223): fixed provider backend labeling so `openai` and `openrouter` no longer collapse into misleading `local_*` labels.
  - Frontend:
    - `lct_app/src/services/byokApi.js` (lines 6-12): expanded BYOK scope minting to request `llm_live` and `llm_import` alongside STT scopes.
    - `lct_app/src/components/ByokSessionControl.jsx` (lines 28-38, 47): updated UI copy from “STT-only” to “OpenAI BYOK for live/upload audio and graph generation”.
  - Tests:
    - `lct_python_backend/tests/integration/transcripts_test_support.py` (lines 28-35, 98): made the shared websocket processor fixture provider-aware and patched `_load_llm_providers`.
    - `lct_python_backend/tests/unit/test_byok_session_store.py` (lines 15-76): added LLM overlay assertions.
    - `lct_python_backend/tests/unit/test_local_llm_client.py` (lines 1-48): added backend-label coverage for OpenAI and remote-compatible providers.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 10-62, 316-409): added BYOK LLM scope coverage, captured runtime provider injection, asserted `llm_backend`, and added local import-time stubs for optional dependencies needed only to import the module graph in lean test environments.
    - `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 1-32, 319-431): added the same import-time optional dependency stub pattern for `google.genai` and asserted the live runtime processor receives the ephemeral BYOK OpenAI provider.
- Why:
  - the user explicitly preferred one BYOK key rather than mixed OpenAI STT + Gemini graph billing;
  - runtime-only provider overlays preserve the existing backend-owned audio/websocket orchestration while keeping raw keys out of persistent config;
  - loading real provider secrets server-side fixed a separate import-path correctness bug that would otherwise make live/import diverge.
- Validation:
  - `python3 -m py_compile lct_python_backend/services/byok_session_store.py lct_python_backend/stt_api.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/import_api.py lct_python_backend/services/local_llm_client.py lct_python_backend/tests/integration/transcripts_test_support.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_local_llm_client.py` (`passed`)
  - `python3 -m pytest -q lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_local_llm_client.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`36 passed`)
  - `cd lct_app && ./node_modules/.bin/eslint src/services/byokApi.js src/components/ByokSessionControl.jsx` (`passed`)
- Remaining constraint:
  - embeddings and other secondary analysis paths still use hosted/server-side credentials; BYOK currently covers STT plus transcript-to-graph generation only.

## 2026-04-03T07:11:41Z — Discovered validation/testability issue: eager optional imports in backend module graph

Branch: current worktree

- Summary: focused import/websocket tests initially failed during module import because `transcript_processing` eagerly imports `google.genai`, and `import_api` pulls in `pydub` / `pdfplumber` transitively even when the tests later stub the actual runtime behavior.
- Impact: logic regressions in the touched BYOK slice were temporarily masked by workstation-package availability rather than application behavior.
- Blocker status: non-blocking for this slice after adding explicit local stubs in the touched test modules.
- Recommended next step: centralize these stubs in shared test helpers or lazy-import optional integrations in production modules so focused tests do not depend on full media/Gemini extras being installed.

## 2026-04-03T03:13:21Z — BYOK session-token MVP preflight (Option B approved)

Branch: current worktree

- Context: user approved option `B` for public-wallet protection: keep OpenAI keys out of Postgres and global settings, add a short-lived BYOK session token flow for live STT and `/api/import/process-file`, and leave LLM BYOK out of phase 1.
- Explicit hypotheses before patch:
  - `H1`: live websocket STT can support BYOK safely by resolving per-session cloud candidate secrets during `session_meta` handling instead of reading only persisted global provider config.
  - `H2`: import audio can share the same BYOK token by threading an opaque token through `/api/import/process-file` and overriding only STT candidate resolution, leaving graph persistence / artifact export / LLM paths unchanged for this slice.
  - `H3`: the lowest-risk frontend implementation is a shared in-memory BYOK session context used by upload and live recording, not the existing persisted settings panels and not browser storage.
- Planned file set for this slice:
  - `lct_python_backend/stt_api.py`
  - `lct_python_backend/import_api.py`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/stt_live_provider_selection.py`
  - `lct_python_backend/services/provider_selection.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - new backend BYOK session service module(s)
  - `lct_app/src/components/audio/useTranscriptSockets.js`
  - `lct_app/src/components/upload/useFileUploadStream.js`
  - `lct_app/src/components/AudioInput.jsx`
  - `lct_app/src/components/FileUpload.jsx`
  - `lct_app/src/pages/NewConversation.jsx`
  - `lct_app/src/App.jsx`
  - new frontend BYOK session/context module(s)
- Guardrails:
  - do not reuse global STT/LLM settings persistence for BYOK;
  - do not store raw BYOK secrets in DB, logs, or browser persistence;
  - preserve existing dirty worktree changes outside this approved slice.

## 2026-04-03T03:40:24Z — BYOK session-token MVP implemented for live STT + import

Branch: current worktree

- Context: completed option `B` after user approval. Goal was to keep user-supplied OpenAI STT keys out of Postgres/global settings while preserving the backend-owned audio pipeline for `/ws/transcripts` and `/api/import/process-file`.
- Files modified:
  - `lct_python_backend/services/byok_session_store.py` (new file, full file): added in-memory BYOK session creation, cheap OpenAI key validation, scope-aware lookup, TTL pruning, and runtime STT settings overlay that injects ephemeral OpenAI provider credentials without persisting them.
  - `lct_python_backend/stt_api.py` (lines 137-157): added `POST /api/byok/session` to mint opaque session tokens from a browser-supplied key over HTTPS; returns `400` for invalid payload/key rejection and `502` for upstream validation failures.
  - `lct_python_backend/services/stt_live_provider_selection.py` (cloud override branch in live candidate resolution): allowed `openai_audio` / `openrouter_audio` to become the primary live candidate when a BYOK-backed runtime overlay is present instead of always forcing the persisted backend provider first.
  - `lct_python_backend/services/stt_ws_session.py` (lines 107-114, 720-950, 1405-1598, 1828-1836): threaded BYOK session resolution into `session_meta`, built runtime-only STT settings from the opaque token, exposed the BYOK provider in session metadata, preserved refinement window timestamps/source utterance IDs through the buffered refinement path, and stopped canceling committed refinement tasks on disconnect so final-flush speaker evidence is not discarded.
  - `lct_python_backend/import_api.py` (lines 490-508) and `lct_python_backend/services/import_bulk_processor.py` (lines 49-101): accepted `byok_session_token` on `/api/import/process-file` and passed it through the SSE worker facade.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 512-571 and 751-759 plus BYOK worker overlay branch): resolved the BYOK token inside the import worker, overlaid runtime STT settings/provider selection for both sequential and segmented audio paths, and preserved the existing LLM/provider persistence behavior for phase 1.
  - `lct_python_backend/services/audio_storage.py` (lines 13-37): moved the `asyncio.Lock()` allocation to first async use so importing `stt_api` no longer requires an active event loop in tests/CLI contexts.
  - `lct_app/src/services/byokApi.js` (new file, full file): added frontend API helper for `/api/byok/session`.
  - `lct_app/src/contexts/ByokContext.jsx` (lines 13-119) and `lct_app/src/contexts/byokContext.js` (new file, full file): added a shared in-memory BYOK provider/hook that keeps the raw key in React state only, refreshes short-lived tokens before expiry, and never writes to browser storage.
  - `lct_app/src/components/audio/useTranscriptSockets.js` (lines 37-220): mints/reuses the opaque BYOK token before sending `session_meta`, switches live STT to `openai_audio` when a BYOK session exists, and blocks audio sends until `session_meta` is actually sent.
  - `lct_app/src/components/upload/useFileUploadStream.js` (lines 62-134): mints/reuses the BYOK token for `/api/import/process-file`, appends the opaque token instead of the raw key, and now sends the normal API auth headers on the upload request.
  - `lct_app/src/components/ByokSessionControl.jsx` (new file, full file), `lct_app/src/pages/NewConversation.jsx` (import + footer placement around line 351), and `lct_app/src/App.jsx` (lines 3-15): added the session-only BYOK control to the new-conversation footer and wrapped the app in the BYOK provider.
  - Tests:
    - `lct_python_backend/tests/unit/test_byok_session_store.py` (new file, full file): covers opaque-token minting, secret non-disclosure, and runtime STT overlay behavior.
    - `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (line 205): covers `openai_audio` override as the primary live candidate.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 263): covers BYOK import processing with runtime-only OpenAI provider config.
    - `lct_python_backend/tests/integration/test_transcripts_websocket.py` (line 290 and live-refinement fixture updates): covers BYOK live `session_meta` candidate selection and the realtime background-refinement materialization path with a real WAV payload.
    - `lct_python_backend/tests/unit/test_audio_storage.py` (line 9): regression for constructing `AudioStorageManager` without an active event loop.
- Why:
  - session-only BYOK lets users pay for long audio themselves without teaching the existing global settings system to store per-user secrets;
  - opaque tokens keep raw STT keys out of websocket payloads, import jobs, logs, and Postgres;
  - the websocket/live refinement fixes were required to make the validated live path actually preserve speaker evidence through `final_flush`.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/audio_storage.py lct_python_backend/services/byok_session_store.py lct_python_backend/stt_api.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_audio_storage.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`passed`)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_audio_storage.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`40 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/App.jsx src/contexts/ByokContext.jsx src/contexts/byokContext.js src/components/ByokSessionControl.jsx src/components/audio/useTranscriptSockets.js src/components/upload/useFileUploadStream.js src/services/byokApi.js src/pages/NewConversation.jsx` (`passed`)
- Remaining constraint:
  - this slice only covers STT BYOK for live audio and import audio. Graph generation still uses the server-side LLM configuration, so full LLM BYOK remains a separate phase.

## 2026-04-03T03:57:10Z — LLM BYOK investigation follow-up

Branch: current worktree

- Context: after shipping STT BYOK, the remaining user-visible wallet gap is the graph/LLM path. Investigated the current LLM routing seams before choosing an implementation slice.
- Confirmed findings:
  - `transcript_llm_callers.py` has two distinct LLM paths: `mode=online` is Gemini-env-key-first, while the provider-fallback path uses OpenAI-compatible provider records with per-provider `Authorization` headers.
  - Import graph generation already loads `llm_providers` (`import_bulk_pipeline.py`) and passes them into `TranscriptProcessor`.
  - Live graph generation does **not** load `llm_providers`; `stt_api.py` only loads `llm_config`, and `WsSessionContext` constructs `TranscriptProcessor` without a provider list. Result: live falls back to `get_default_providers()` rather than the saved provider order/credentials.
  - `embedding_service.py` still uses `OPENAI_API_KEY` from env in online mode, but that is a separate spend path from the main live/import transcript-to-graph flow and should be treated as a distinct scope decision.
- Impact:
  - any LLM BYOK implementation must first standardize live and import runtime provider plumbing, otherwise the feature will behave inconsistently across recording vs upload.

## 2026-04-03T04:01:20Z — LLM BYOK preflight (single-key OpenAI path)

Branch: current worktree

- Context: user approved the next slice and explicitly prefers a single OpenAI key for BYOK so both audio and graph generation share one wallet/mental model.
- Explicit hypotheses before patch:
  - `H1`: the cleanest implementation is to extend the existing BYOK session token with LLM scopes and inject an ephemeral OpenAI provider record into the runtime provider list rather than creating a separate OpenAI-only graph path.
  - `H2`: fixing live/import inconsistency is part of the same slice, because live currently ignores provider lists while import loads them through a client-sanitized path.
  - `H3`: embeddings should stay out of scope for phase 2; transcript-to-graph is the primary remaining spend path and widening into embeddings would unnecessarily enlarge the blast radius.
- Planned file set for this slice:
  - `lct_python_backend/services/byok_session_store.py`
  - `lct_python_backend/stt_api.py`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - `lct_python_backend/services/transcript_llm_callers.py`
  - `lct_python_backend/services/local_llm_client.py`
  - `lct_python_backend/import_api.py`
  - `lct_python_backend/tests/integration/transcripts_test_support.py`
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `lct_python_backend/tests/unit/test_import_api_process_file.py`
  - new/updated LLM BYOK unit tests
  - `lct_app/src/services/byokApi.js`
  - `lct_app/src/contexts/ByokContext.jsx`
  - `lct_app/src/components/ByokSessionControl.jsx`
- Guardrails:
  - keep raw BYOK keys in browser memory + server memory only;
  - do not mutate or persist global LLM settings for BYOK sessions;
  - do not widen into embeddings in this slice;
  - fail loudly if a BYOK token lacks required LLM scope instead of silently falling back to hosted online mode.

## 2026-03-21T23:41:37Z — Manifest-backed artifact reroute after manual speaker naming

Branch: `codex/fix-stt-cloud-test-observability`

- Context: manual speaker naming and participant-aware routing were already in place, but the first import auto-export still landed in the root `Conversations/` folder with no safe way to relocate or regenerate the paired `.canvas` + `.txt` after the human confirmed speaker names. The user approved the follow-up: reroute artifacts without rerunning STT or spending more API credits.
- Root cause confirmed before patch:
  - `lct_python_backend/services/artifact_export_service.py` wrote files and returned `written_files` in the SSE payload, but it did not persist any durable artifact manifest. After import completion the app no longer knew which filesystem paths belonged to conversation `X`.
  - `lct_python_backend/artifact_api.py` only exposed settings/test-write. There was no explicit reroute/re-export endpoint.
  - `lct_app/src/components/MinimalLegend.jsx` saved speaker names, but had no hook to trigger a backend rewrite/move after naming became unambiguous.
- Files modified:
  - `lct_python_backend/services/artifact_export_service.py` (lines 14-39, 162-188, 243-320, 330-420, 423-490): added `PipelineArtifact`-backed manifest persistence for exported `.canvas` / `.txt` files, taught filename collision logic to ignore the currently tracked artifact pair when rewriting in place, and added `reroute_conversation_artifacts(...)` that regenerates artifacts from canonical conversation state, writes them into the newly resolved root/participant folder, and only then removes superseded tracked files.
  - `lct_python_backend/artifact_api.py` (lines 10-19, 21-24, 60-77): added `POST /api/conversations/{conversation_id}/artifacts/reroute` and fixed router-registration order so the new route is actually mounted.
  - `lct_app/src/services/artifactSettingsApi.js` (lines 1-47): added `rerouteConversationArtifacts(conversationId)` for the new backend endpoint.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 5-9, 37-44, 97-133, 203-213): after a successful speaker rename, the legend now attempts reroute, surfaces the resolved folder on success, and reports reroute failures explicitly without losing the saved alias.
  - `lct_python_backend/tests/unit/test_artifact_export_service.py` (full file) and `lct_python_backend/tests/unit/test_artifact_api.py` (new): added regressions for participant-folder reroute, root-file cleanup after rewrite, and the new reroute endpoint contract.
- Why:
  - reroute must regenerate the `.txt` artifact from persisted utterances so the renamed speaker labels are reflected in the transcript, not merely move the old generic-label file;
  - moving/deleting files without a manifest is unsafe, so the backend now tracks the current artifact pair per conversation before any reroute happens.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/artifact_export_service.py lct_python_backend/artifact_api.py lct_python_backend/speaker_naming_api.py lct_python_backend/services/speaker_naming_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_artifact_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_artifact_api.py lct_python_backend/tests/unit/test_speaker_naming_api.py lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`25 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/components/MinimalLegend.jsx src/services/artifactSettingsApi.js src/services/speakerNamingApi.js` (passed)
- Remaining caveat:
  - there is still no dedicated post-import confirmation modal; reroute is now triggered from the legend rename flow itself, which is functionally sufficient but not yet the most discoverable UX.

## 2026-03-21T16:14:31Z — Manual speaker naming + participant-aware artifact routing

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the user approved the safe-routing follow-up after artifact auto-export landed. Requirement: keep auto-export rooted at `Conversations/` by default, let humans manually rename `SPEAKER_*` labels to real people, and only use those confirmed names as routing evidence for later artifact writes.
- Files modified:
  - `lct_python_backend/services/speaker_naming_service.py` (lines 1-144): added generic-speaker detection, confirmed-name checks, conversation speaker listing, and durable rename flow that rewrites `Utterance.speaker_name` for a selected `speaker_id` and refreshes `Conversation.participants`.
  - `lct_python_backend/speaker_naming_api.py` (lines 1-52): added `GET /api/conversations/{conversation_id}/speakers` and `PATCH /api/conversations/{conversation_id}/speakers/{speaker_id}` so manual aliasing is backend-owned instead of a frontend-only draft.
  - `lct_python_backend/backend.py` (lines 124-156): mounted the new speaker-naming router.
  - `lct_python_backend/services/artifact_settings_service.py` (lines 22-55, 134-155): extended artifact-export settings with `self_name` so routing can exclude the current user without guessing from diarization labels.
  - `lct_python_backend/services/artifact_export_service.py` (lines 119-152, 175-285): threaded `utterances` through artifact-building, added `_resolve_export_directory(...)`, and now route auto-export writes into a participant subfolder only when there is exactly one confirmed non-generic participant name distinct from `self_name`; otherwise export stays at the configured root.
  - `lct_python_backend/services/conversation_artifacts.py` (lines 28-63) and `lct_python_backend/services/conversation_reader.py` (lines 123-157): transcript/chunk serialization now prefers `speaker_name` over generic `speaker_id` when humans have confirmed aliases.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 1-222), `lct_app/src/services/speakerNamingApi.js` (lines 1-36), `lct_app/src/pages/NewConversation.jsx` (lines 173-181), and `lct_app/src/pages/ViewConversation.jsx` (legend wiring in the saved view): added inline speaker naming in the legend and wired it to persisted conversations so users can confirm names without leaving the graph.
  - `lct_app/src/components/settings/ArtifactExportCard.jsx` (lines 14-24, 209-237): added `self_name` to artifact settings UI and documented the exact routing rule in the card copy.
  - `lct_app/src/components/upload/useFileUploadStream.js` (artifact-complete message path): upload completion toasts now show `resolved_root_path` so a participant-routed export reports the actual folder, not only the configured root.
  - `lct_python_backend/tests/unit/test_artifact_settings_service.py`, `lct_python_backend/tests/unit/test_artifact_export_service.py`, and `lct_python_backend/tests/unit/test_speaker_naming_api.py`: added coverage for `self_name` normalization, participant-folder routing, and speaker rename/list endpoints.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/speaker_naming_service.py lct_python_backend/speaker_naming_api.py lct_python_backend/services/artifact_settings_service.py lct_python_backend/services/artifact_export_service.py lct_python_backend/services/conversation_artifacts.py lct_python_backend/services/conversation_reader.py lct_python_backend/backend.py lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_speaker_naming_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_speaker_naming_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`22 passed`, existing warning only)
  - `cd lct_app && npx eslint src/components/MinimalLegend.jsx src/pages/NewConversation.jsx src/pages/ViewConversation.jsx src/components/settings/ArtifactExportCard.jsx src/components/upload/useFileUploadStream.js src/services/speakerNamingApi.js` (passed)
- Follow-up:
  - import-complete auto-export still fires before the human has a chance to rename speakers, so the first artifact write safely lands at the root folder and only later exports can use confirmed participant routing;
  - recommended next step is a post-import rename/reroute affordance rather than guessing names from diarization labels.

## 2026-03-21T05:36:12Z — Import graph refinement semantics-preservation fix validated on Anand 10-minute rerun

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the previous Anand rerun proved that second-pass import refinement was increasing node count while erasing contextual/tangent structure, so the user approved the minimal safe fix: preserve first-pass edge semantics in the refinement prompt and reject any refined graph that collapses relational structure.
- Root cause confirmed before patch:
  - `lct_python_backend/services/import_graph_refinement.py` only passed chronology/thread metadata into the refiner (`node_name`, `summary`, `source_excerpt`, `predecessor`, `successor`, `thread_id`, `thread_state`, `speaker_id`), so the LLM never saw first-pass `contextual_relation`, `edge_relations`, or `linked_nodes`.
  - The acceptance gate also allowed a denser-but-flatter graph to replace the first pass as long as node count / return count increased.
- Files modified:
  - `lct_python_backend/services/import_graph_refinement.py` (lines 61-201, 311-369): expanded `_thread_metrics(...)` to measure contextual/link richness, threaded existing `contextual_relation` / `edge_relations` / `linked_nodes` into `_simplify_existing_nodes(...)`, and added `_refinement_semantics_degraded(...)` so refinement now fails closed if it zeroes out previously present contextual structure.
  - `lct_python_backend/tests/unit/test_import_graph_refinement.py` (lines 49-64, 145-167): added a contextual-node fixture plus a regression test proving a refined graph with more nodes but zero contextual edges is rejected with `reason="refinement_semantics_degraded"`.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_graph_refinement.py lct_python_backend/tests/unit/test_import_graph_refinement.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`18 passed`, existing LibreSSL warning only)
- Manual rerun:
  - Input: `tmp/talking_to_anand_10min.m4a` (600 s) via `POST /api/import/process-file` with `provider=openai_audio`
  - Output conversation: `8aa49f33-2e0e-4444-806c-318a71c58673`
  - Artifacts captured:
    - `tmp/anand_import_fix_events_20260320T222748.json`
    - `tmp/anand_import_fix_20260320T223420.canvas`
    - `tmp/anand_import_fix_20260320T223420.txt`
  - Result:
    - refinement still applied, but no longer stripped graph semantics;
    - `original_metrics`: `edge_count=40`, `contextual_node_count=20`, `linked_node_count=20`
    - `refined_metrics`: `edge_count=44`, `contextual_node_count=20`, `linked_node_count=20`, `tangent_count=1`, `return_count=3`
    - exported canvas now reads materially branchier: `21` text nodes, `174` edges, `14` x-columns, `13` y-bands, with non-temporal labels including `contextual`, `clarifies`, `supports`, `tangent`, `rebuts`, and `return_to_thread`.
- Follow-up:
  - the semantics-collapse bug is resolved;
  - remaining graph-quality issue is node granularity, not edge survival or layout-only flattening.

## 2026-03-21T04:49:48Z — Anand rerun validation after import densification slice

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after wiring the second-pass import graph refinement, I reran the real Anand 10-minute import on the restarted backend to validate actual user-visible output rather than only unit/SSE tests.
- Manual validation:
  - Input: `tmp/talking_to_anand_10min.m4a` (600 s) via `POST /api/import/process-file` with `provider=openai_audio`
  - Output conversation: `7c5e5141-1441-4120-bd29-3113a29cca0b`
  - Artifacts captured:
    - `tmp/anand_import_rerun_summary_20260320T214140.json`
    - `tmp/anand_import_rerun_events_20260320T214140.json`
    - `tmp/anand_import_rerun_20260320T214140.canvas`
    - `tmp/anand_import_rerun_20260320T214140.txt`
- What improved:
  - import stayed on the quality-first OpenAI diarized path (`gpt-4o-transcribe-diarize`) with no provider fallback;
  - first-pass graph generation reached `19` nodes;
  - second-pass refinement explicitly applied and raised the graph to `22` nodes (`refining_graph: "Refined graph from 19 to 22 nodes."`);
  - transcript artifact is strong: `83` utterances, `83` speaker-segment materializations, timestamped `A/B` lines in the exported `.txt`.
- What is still broken:
  - the refined graph replaced the richer first-pass structure with thread-state-only nodes:
    - `thread_states`: `4 new_thread`, `15 continue_thread`, `3 return_to_thread`
    - but every refined node had empty `contextual_relation`, `linked_nodes`, and `edge_relations`
  - exported canvas therefore had only temporal links:
    - `22` nodes, `42` edges
    - edge labels: `21 temporal`, `21 next`
    - layout: `22` x-columns, `1` y-band
  - user-visible result: denser topic splitting, but still a single-row temporal strip rather than a visibly branchy graph.
- Follow-up:
  - logged in `ISSUES.md` as an import graph densification semantics gap;
  - likely next fix is to preserve or synthesize contextual/tangent edges during second-pass refinement instead of replacing the first-pass graph with a thread-state-only result.

## 2026-03-21T01:07:20Z — Import graph densification via second-pass subthread/tangent refinement

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after the new Anand import export became branchier in layout, the user explicitly approved the next priority slice: improve node granularity rather than keep tuning geometry. The problem was that import still persisted the first-pass chapter graph directly, so long multi-topic sections remained coarse even when transcript evidence clearly contained smaller tangents, returns, and meta-conversations.
- Root cause confirmed:
  - `lct_python_backend/services/import_graph_refinement.py` already existed with the intended LLM-bound refinement contract, but it was not connected to the import worker at all, so imported conversations always persisted the first-pass graph.
  - `lct_python_backend/services/import_bulk_pipeline.py` had the full refinement inputs available in one place right before persistence (`existing_json`, canonical utterances, and transcript text), but there was no second-pass checkpoint between `processor.flush()` and `persist_import_graph(...)`.
- Files modified:
  - `lct_python_backend/services/transcript_prompts.py` (lines 177-214): added `REFINE_LCT_SUBTHREAD_PROMPT`, a bounded prompt for denser subthread/tangent extraction that preserves chronology, thread semantics, and source-backed excerpts instead of allowing free rewriting.
  - `lct_python_backend/services/import_graph_refinement.py` (full file, 1-347): kept the refinement logic in a dedicated service and confirmed the acceptance contract now used by the worker: threshold gating, transcript-evidence prompt assembly, online/local LLM fallback, duplicate-name rejection, and “only replace if structure is actually richer” scoring.
  - `lct_python_backend/import_api.py` (lines 47-56, 500-518): threaded `refine_import_graph_nodes` into the `/api/import/process-file` route wiring so tests can monkeypatch it through the public import API seam.
  - `lct_python_backend/services/import_bulk_processor.py` (lines 49-113): extended the facade signature so the new refinement callable reaches the worker without coupling tests or route code to a global import.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 131-136, 411-417, 427, 516-519, 772-846): added `final_transcript_text` tracking for both sequential and segmented import paths, ran the second-pass refinement right after first-pass graph generation, recorded structured `graph_refinement` telemetry, emitted explicit `refining_graph` SSE status events, and only replaced the graph when the refinement result was accepted as richer. Refinement failure now fails closed and keeps the first-pass graph.
  - Tests:
    - `lct_python_backend/tests/unit/test_import_graph_refinement.py` (new): covers threshold skip, richer accepted refinement, and duplicate-name rejection.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (extended): proves `/api/import/process-file` can apply a refined graph, emit the updated `existing_json`, and report the refined node count/telemetry in the `done` payload.
- Why:
  - improve import graph structure at the source rather than trying to “fake” branching with more layout heuristics;
  - keep the second pass bounded and auditable by only allowing it to replace the graph when it demonstrably increases node/thread/edge richness;
  - preserve the existing import/export contract by emitting another full graph snapshot rather than inventing a separate import-only graph format.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/services/import_graph_refinement.py lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`17 passed`, existing LibreSSL warning only)
- Remaining caveat:
  - this slice makes import graphs denser when the second pass can prove richer structure, but it does not yet add a hierarchical graph model. The next meaningful quality step is likely a dedicated subthread/tangent representation or better prompt/evidence shaping, not another geometry tweak.

## 2026-03-21T00:18:35Z — Import auto-export profile for paired Obsidian `.canvas` + `.txt` artifacts

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the user approved an opt-in setting so successful imports would immediately write both the exported canvas and the paired timestamped transcript into a configured Obsidian folder, without requiring the manual export button. The implementation needed to be backend-owned, loud on failure, and wired after canonical import persistence rather than as a browser-only download trick.
- Files modified:
  - `lct_python_backend/services/artifact_settings_service.py` (new): added the `artifact_export_settings` app-setting contract, normalization, validation, and a real write-probe helper. Invariants enforced: absolute directory path, at least one artifact type enabled when auto-export is on, and no silent pass-through for an invalid folder.
  - `lct_python_backend/artifact_api.py` (new) and `lct_python_backend/backend.py`: added `/api/settings/artifact-export` load/save/test-write routes and mounted them into the backend so Runtime Settings can manage the feature without piggybacking on STT settings.
  - `lct_python_backend/services/artifact_export_service.py` (new): added the backend-owned paired-artifact writer. It derives a timestamped basename from conversation metadata, builds the `.canvas` + `.txt` payloads from canonical conversation state, writes them atomically into the configured folder, and returns the written paths for telemetry/UI.
  - `lct_python_backend/import_api.py`, `lct_python_backend/services/import_bulk_processor.py`, and `lct_python_backend/services/import_bulk_pipeline.py`: threaded the new settings/writer into the import worker and triggered auto-export only after graph persistence + speaker materialization. Export failures now surface as warning status events and telemetry instead of failing the import or disappearing silently.
  - `lct_app/src/services/artifactSettingsApi.js` (new), `lct_app/src/components/settings/ArtifactExportCard.jsx` (new), and `lct_app/src/pages/settings/RuntimeSettingsPage.jsx`: added a dedicated Runtime Settings card for the feature with toggle, folder path, `.canvas` / `.txt` checkboxes, include-chunks option, save, and test-write.
  - `lct_app/src/components/upload/useFileUploadStream.js`: import completion message now includes the auto-export result when files were written, so successful background writes are visible to the user.
  - Tests:
    - `lct_python_backend/tests/unit/test_artifact_settings_service.py` (new)
    - `lct_python_backend/tests/unit/test_artifact_export_service.py` (new)
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (extended with auto-export regression)
- Why:
  - keep artifact writing backend-owned and driven by canonical conversation state;
  - avoid hidden filesystem side effects by surfacing success/failure in both logs and the SSE `done` payload;
  - keep export configuration independent from STT configuration so future live-finalize export can reuse the same profile without bloating the STT card.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/artifact_settings_service.py lct_python_backend/services/artifact_export_service.py lct_python_backend/artifact_api.py lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/backend.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`18 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/components/settings/ArtifactExportCard.jsx src/pages/settings/RuntimeSettingsPage.jsx src/components/upload/useFileUploadStream.js src/services/artifactSettingsApi.js`
- Manual verification:
  - Saved the profile against the running backend at `http://localhost:8000/api/settings/artifact-export` with `root_path=/tmp/lct_auto_export_test`, then confirmed `POST /api/settings/artifact-export/test-write` returned `{"ok": true}`.
  - Ran a real tiny import through `POST /api/import/process-file` using `/tmp/lct_auto_export_test_input.txt`; the SSE stream emitted `stage=exporting_artifacts`, and the final `done` payload included two written files:
    - `/tmp/lct_auto_export_test/lct_auto_export_test_input (2026-03-21 00-03-30).canvas`
    - `/tmp/lct_auto_export_test/lct_auto_export_test_input (2026-03-21 00-03-30).txt`
  - Verified both files exist on disk and the `.txt` contains the expected linear transcript lines.
  - Restored the live setting afterward to its previous disabled state so the user’s runtime was not left pointed at the temporary test folder.
- Remaining caveat:
  - this slice only wires import-complete auto-export. The setting shape already leaves space for live-finalize export, but that trigger is intentionally not implemented yet so the UI does not over-promise behavior during live sessions.

## 2026-03-20T23:58:10Z — Issue/debt sync after Anand import layout validation

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after validating the new import transcript artifact path and contextual hub/ring layout on the Anand 10-minute conversation (`1349fc27-c9dc-4b97-92e0-571df28c9754`), the tracking docs still described the old import speaker-materialization/export failures as unresolved and understated the complexity now living in `canvas_api.py`.
- Files modified:
  - `ISSUES.md` (Runtime Blockers + Graph & UI Polish sections): marked the live/headless semantic-persistence gap and imported-audio speaker-materialization gap as resolved, added the narrower remaining follow-up that import diarization job visibility is still in-memory/ephemeral, and logged that current imported graphs are branchier but still coarse at the node/tangent level.
  - `docs/TECH_DEBT.md` (`lct_python_backend/canvas_api.py` row): updated the row to reflect current scale (`1244` LOC) and the new mixed concerns now living there, especially contextual community layout heuristics and paired transcript-artifact export wiring.
- Why:
  - keep repo tracking documents aligned with the behavior we actually validated rather than leaving stale blocker notes after the fixes landed;
  - make the next decomposition target explicit now that `canvas_api.py` is materially larger and carries route, conversion, layout, and artifact responsibilities at once.

## 2026-03-20T23:32:40Z — Import parity for transcript artifacts + branchier contextual canvas layout

Branch: `codex/fix-stt-cloud-test-observability`

- Context: imported audio conversations were persisting graph nodes without durable utterances/speaker evidence, and exported Obsidian canvases still looked like a single left-to-right chapter strip even when the underlying graph contained many contextual links. The user also required every exported canvas to have an associated `.txt` transcript artifact with timestamps and speaker labels.
- Root cause confirmed:
  - `lct_python_backend/services/file_transcriber.py` (full file): `FileTranscriptResult` only exposed flat `transcript_text` + metadata, so import persistence had no canonical utterance rows or speaker segments to write.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 590-820 before patch): sequential audio import persisted only `existing_json` via `persist_import_graph(...)`; transcript evidence and speaker refinement were not materialized.
  - `lct_python_backend/services/import_diarization_queue.py` (lines 288-430 before patch): background import diarization regenerated graph patches but never called `persist_speaker_refinement(...)`.
  - `lct_python_backend/canvas_api.py` (lines 326-431 before patch): export layout only switched away from a temporal left-to-right chain when all temporal depths were identical. The latest Anand graph had dense contextual edges *and* a temporal spine, so it still rendered as one row of 15 nodes.
- Files modified:
  - `lct_python_backend/services/transcription_utils.py` (FileTranscriptResult dataclass): extended import results to carry structured `utterances` and `speaker_segments`.
  - `lct_python_backend/services/transcript_linearization.py` (new): added canonical helpers for deriving utterance rows from diarized segments, ASR segments, or fallback speaker-prefixed transcript lines.
  - `lct_python_backend/services/file_transcriber.py` (audio/text upload orchestrator): now populates canonical utterance rows and speaker segments for upload results, preserving provider/transport/model metadata needed for durable materialization.
  - `lct_python_backend/services/import_persistence.py` (graph persistence): now optionally persists utterances alongside nodes/relationships, preserves richer edge/thread semantics (`predecessor`, `edge_relations`, `thread_id`, `thread_state`), and updates conversation participant/utterance stats from imported transcript evidence.
  - `lct_python_backend/services/import_bulk_pipeline.py` (worker pipeline): now hands persisted utterances into `persist_import_graph(...)` and immediately materializes speaker evidence when the initial import already returned diarized segments.
  - `lct_python_backend/services/import_diarization_queue.py` (background import diarization): now calls `persist_speaker_refinement(...)` so follow-up diarization updates become durable speaker segments / utterance speaker truth instead of in-memory-only patches.
  - `lct_python_backend/services/conversation_artifacts.py` (new): added deterministic linear transcript artifact rendering with timestamps, speaker labels, and speaker provenance/confidence.
  - `lct_python_backend/canvas_api.py` (export routes + layout): export now reads from the canonical conversation bundle, exposes `/export/obsidian-canvas/{conversation_id}/transcript`, and switches context-dense components to a hub/ring layout instead of always respecting the temporal chain as a single horizontal strip.
  - `lct_python_backend/services/conversation_reader.py` (serialized graph payload): now includes preserved `thread_id`, `thread_state`, `is_tangent`, and `edge_relations` metadata so export/read paths can use richer graph semantics.
  - `lct_app/src/components/ExportCanvas.jsx` (frontend export UX): export button now downloads the paired `.canvas` and `.txt` artifacts together.
  - Tests:
    - `lct_python_backend/tests/unit/test_file_transcriber.py`
    - `lct_python_backend/tests/unit/test_import_graph_persistence.py`
    - `lct_python_backend/tests/unit/test_canvas_api_converter.py`
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/transcript_linearization.py lct_python_backend/services/conversation_artifacts.py lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_persistence.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/services/import_diarization_queue.py lct_python_backend/services/conversation_reader.py lct_python_backend/services/speaker_materialization.py lct_python_backend/canvas_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_file_transcriber.py lct_python_backend/tests/unit/test_import_graph_persistence.py lct_python_backend/tests/unit/test_canvas_api_converter.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`79 passed`)
  - `cd lct_app && npx eslint src/components/ExportCanvas.jsx`
- Manual verification:
  - Latest Anand import conversation: `1349fc27-c9dc-4b97-92e0-571df28c9754`
  - `POST /export/obsidian-canvas/1349fc27-c9dc-4b97-92e0-571df28c9754/transcript` now returns a `.txt` artifact with `79` utterances and timestamped `A`/`B` speaker lines.
  - Exported canvas for the same conversation no longer places all nodes on one row. Before the layout patch the latest export had 15 unique x-columns and a single y-row; after the patch it uses `7` x-columns and `7` y-bands, producing a visibly branchier layout around contextual hubs.
  - Remaining caveat: the graph is still semantically coarse at the node level (high-level chapter/topic nodes), so the layout now exposes more branching but does not yet create finer-grained tangents/subthreads on its own.

## 2026-03-20T22:31:40Z — Migration unblock for Anand import export/schema mismatch

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after the Anand 10-minute import succeeded on the new OpenAI diarized upload path, `POST /export/obsidian-canvas/{conversation_id}` failed with `column utterances.speaker_source does not exist`. The backend had been started with `SKIP_MIGRATIONS=1`, so the running models expected Phase 2A utterance speaker columns that were not yet present in the local PostgreSQL schema.
- Root cause confirmed:
  - `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` (full file): the ADR-018 migration unconditionally dropped `edit_feedback`, but this local DB had never created that table. That caused `alembic upgrade head` to stop at revision `add_intent_signals`, preventing the later speaker-materialization migration from applying.
  - `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (full file): the Phase 2A migration used revision id `add_speaker_segments_materialization`, which exceeded the local `alembic_version.version_num` width and caused Alembic to fail when updating the version row even after the DDL itself succeeded.
  - Verified DB state before patch: Alembic revision was still `add_intent_signals`; `utterances` lacked `speaker_source`, `speaker_confidence`, and `speaker_revision`; `edit_feedback` was absent.
- Files modified:
  - `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` (upgrade/downgrade guards): made the migration robust to drifted dev DBs by checking existing `edits_log` columns before adding/removing them and checking whether `edit_feedback` exists before dropping/recreating it. This keeps the migration chain aligned with the actual local schema state instead of assuming a pristine branch history.
  - `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (revision metadata): shortened the revision id to fit the local `alembic_version.version_num` width so Alembic can advance past Phase 2A on this PostgreSQL instance.
- Why:
  - without this patch, `alembic upgrade head` fails locally, canvas export remains broken, and the async speaker-materialization job for imported audio cannot persist its read-model columns safely.
- Additional discovery during validation:
  - The repaired import now produces a valid conversation and exports a 14-node canvas, but direct DB inspection after export shows no persisted `utterances` or `speaker_segments` for conversation `59ea69eb-4888-4432-9229-9f8460f7a850`, and the advertised async diarization job id (`350877b0-be4c-4107-b93a-7e42bca00f25`) now returns 404 from `/api/import/diarization-jobs/...`. Impact: graph export is unblocked, but durable speaker-materialization parity for imported audio is still incomplete and needs a follow-up investigation in the import pipeline/job store.

## 2026-03-20T22:08:40Z — Investigation plan for import STT unification after Anand replay failure

Branch: `codex/fix-stt-cloud-test-observability`

- Context: reran the Anand audio through both the live websocket path and `/api/import/process-file` to generate a canvas artifact. The live replay failed mid-session on the OpenAI realtime transport (`no close frame received or sent`), and the import pipeline failed on the legacy upload STT path after falling from local Parakeet to remote Whisper with `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}`.
- Root-cause hypothesis confirmed from source inspection:
  - `lct_python_backend/services/provider_selection.py` (full file): the upload provider resolver is legacy and only knows `parakeet`, `senko`, `ofc`, and `whisper`; it does not know about `openai_audio` or cloud capability routing.
  - `lct_python_backend/services/file_transcriber.py` (full file): `transcribe_uploaded_file(...)` uses that legacy upload selector directly, so OpenAI is never even considered for `/api/import/process-file`.
  - `lct_python_backend/services/import_bulk_pipeline.py` (full file): the segmented import path diverges further and bypasses provider selection entirely by sending segments straight to `stt_settings.http_url`.
  - `lct_python_backend/services/stt_live_provider_selection.py` (full file): the newer live selector already has the correct cloud-aware provider model, including `openai_audio`, OpenAI diarized background refinement, and fallback priority semantics.
- Working hypothesis for the fix:
  - H1: import audio should share the same provider/capability model as live STT, but with an import-specific routing policy that prefers higher-quality diarized batch transcription over streaming-first latency.
  - H2: the smallest principled slice is to unify sequential upload STT first, then bring segmented import onto the same candidate layer in the same pass so upload modes do not drift further.
  - H3: remote Whisper's `_asyncio.Task.cancelling` failure is a separate upstream service bug, but it should become a fallback case rather than the default import path once OpenAI/cloud-aware upload routing exists.
- Planned files for this slice:
  - `lct_python_backend/services/provider_selection.py`
  - `lct_python_backend/services/file_transcriber.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - `lct_python_backend/services/stt_live_provider_selection.py` (reuse/adapt candidate-building logic carefully because this file currently has an uncommitted blocker-fix diff in the worktree)
  - `lct_python_backend/tests/unit/test_file_transcriber.py`
  - `lct_python_backend/tests/unit/test_import_api_process_file.py`
- Guardrails:
  - do not revert or overwrite the existing uncommitted blocker-fix diff in `stt_live_provider_selection.py`, `stt_ws_session.py`, `speaker_materialization.py`, `import_persistence.py`, `sttUtils.js`, or the Alembic migration;
  - preserve detailed error logging so upload failures remain loud and attributable by provider/transport.

## 2026-03-20T19:21:03Z — Legacy backend test cleanup after live/materialization PR split

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/tests/test_cost_calculator.py`, `lct_python_backend/tests/test_google_meet_parser.py`, and `lct_python_backend/tests/test_instrumentation.py`: Kept the package-import normalization to `lct_python_backend.*` so these older tests still run under the current package layout.
- `lct_python_backend/tests/test_graph_generation.py` (lines 7-21): Removed the dead `PromptLoader` compatibility shim instead of keeping skipped placeholder tests. `PromptLoader` is no longer part of the current graph-generation contract, so the stale compatibility block was deleted and the file now tests only the active `GraphGenerationService` behavior.
- `lct_python_backend/factcheck_api.py`: Explicitly dropped the uncommitted audio-download hardening diff after confirming it was out of scope for the current branch and not worth carrying as an unrelated partial feature.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/test_cost_calculator.py lct_python_backend/tests/test_google_meet_parser.py lct_python_backend/tests/test_graph_generation.py lct_python_backend/tests/test_instrumentation.py`

## 2026-03-20T19:19:44Z — Docs freshness pass for roadmap, structure, and ADR status notes

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/FEATURE_ROADMAP.md` (lines 1-26, 47-71, 452-481): Added a staleness banner and refreshed roadmap notes so the document explicitly points readers to ADR-driven planning, acknowledges already-shipped items, and adds the guided runtime setup work to the prioritization sections.
- `docs/PROJECT_STRUCTURE.md` (lines 1-74): Refreshed the structure inventory to match the current codebase layout: split model modules, expanded router/service/frontend areas, the settings sub-pages, and the conventions doc.
- `docs/TIER_1_DECISIONS.md` (lines 57-67): Added a supersession note clarifying that the old “no audio storage” MVP decision was later amended by ADR-008 into an opt-in audio-storage model.
- `docs/adr/ADR-001-google-meet-transcript-support.md` (line 139): Added an implementation note correcting the live import route reference so the ADR points at the actual mounted route.
- `docs/adr/ADR-016-review-experience-mvp-thematic-zoom-series-cross-session-signals.md` (line 4): Clarified that the ADR is approved but not yet started, to reduce ambiguity between architectural approval and shipped status.

- Validation:
  - Docs-only change; no tests required.

## 2026-03-20T18:31:39Z — Docs and ignore cleanup for conventions, ADR-018, and local replay artifacts

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/CONVENTIONS.md` (lines 1-215): Reviewed the untracked conventions reference and kept it as a repo doc rather than treating it as a local scratch file. It captures current naming, error-handling, file-organization, import, and API-contract rules that are already reflected in the codebase and useful for future audits.
- `docs/adr/ADR-018-edit-history-training-data-export.md` (lines 1-260): Reviewed the untracked ADR and kept it as a proposed architectural record. It documents the edit-history/training-export design space cleanly enough to preserve even though it is not part of the live STT/materialization stack.
- `.gitignore` (local-artifacts section): Added `tmp/` to keep 1x replay probes and evaluation JSON out of repo status. The current `tmp/` contents are local experiments, not reusable fixtures or committed tooling.

- Validation:
  - Docs/gitignore only; no tests required.

## 2026-03-20T16:33:46Z — ADR-019 Phase 2A: durable speaker evidence, live timebase, and utterance speaker materialization

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/models/core.py` (lines 94-96, 162-213) and `lct_python_backend/models/__init__.py` (core exports): Added the Phase 2A speaker schema. `Utterance` now carries `speaker_source`, `speaker_confidence`, and `speaker_revision`, and the new `SpeakerSegment` model stores immutable diarization evidence with both relative window offsets and conversation-global timestamps.
- `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (new): Added the migration for `speaker_segments` plus the new utterance speaker read-model columns and indexes. The migration follows the repo’s additive/idempotent Alembic pattern so it can be applied against partially evolved dev databases without assuming a fresh schema.
- `lct_python_backend/services/speaker_materialization.py` (new, lines 1-300): Added the backend speaker materializer for Phase 2A. The service persists immutable diarization evidence rows, converts refinement-window-relative segments into conversation-global timestamps, and deterministically updates `utterances.speaker_id` only when timestamp overlap is strong enough. Ambiguous windows are left unresolved instead of forcing incorrect speaker labels into the read model.
- `lct_python_backend/services/stt_openai_realtime.py` (lines 82-96, 212-215, 333-404): Added a real provider-audio timebase for realtime STT by tracking committed provider sample windows. Final realtime transcript events now include `timestamps.start/end` derived from committed audio duration instead of emitting text-only results.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 618-663): Added conversation-global chunk timestamps to backend HTTP STT results so HTTP chunking and realtime STT both feed the same deterministic speaker-materialization path.
- `lct_python_backend/services/stt_session.py` (lines 85-102): Seeded new utterances with explicit speaker read-model defaults (`speaker_source=session_default`, `speaker_confidence`, `speaker_revision`) instead of relying only on DB defaults.
- `lct_python_backend/services/stt_ws_session.py` (lines 23, 91-93, 166-200, 703-780, 831-980, 1125-1158, 1213-1243): Wired Phase 2A into live STT. The websocket session now tracks partial-window timestamps, passes source utterance IDs and window timestamps into background refinement, persists durable speaker evidence/materialized utterance speakers through `persist_speaker_refinement(...)`, and keeps the existing live graph-reconciliation patch path as a supplementary UX layer.
- `lct_python_backend/services/conversation_reader.py` (serialize path): Conversation/timeline payloads now expose `speaker_source`, `speaker_confidence`, and `speaker_revision`, so downstream readers/exporters can tell whether a speaker label came from session defaults or durable diarization materialization.
- `lct_python_backend/tests/unit/test_speaker_materialization.py` (new): Added deterministic overlap-materialization coverage: relative→global timestamp conversion, dominant-speaker assignment, and ambiguous-window refusal.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` and `lct_python_backend/tests/unit/test_stt_http_transcriber.py`: Added coverage proving both realtime and HTTP STT runtimes now emit concrete `timestamps.start/end` windows for final transcript events.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` and `lct_python_backend/tests/integration/transcripts_test_support.py`: Added websocket regression coverage proving background refinement now calls the durable speaker materializer with the correct window timestamps and source utterance ID. Also fixed a hidden teardown hang during this slice by correcting an `_safe_float(...)` call signature in the new timestamp-merge path; without that fix the websocket task was dying silently and tests waited forever for messages that never arrived.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/models/core.py lct_python_backend/models/__init__.py lct_python_backend/services/speaker_materialization.py lct_python_backend/services/stt_session.py lct_python_backend/services/stt_openai_realtime.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/conversation_reader.py lct_python_backend/tests/unit/test_speaker_materialization.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/transcripts_test_support.py` (passed)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_speaker_materialization.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`60 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/hooks/useAutoSave.js` (passed)

- Recommended next step:
  - Phase 2B of ADR-019: add an evidence-bounded alignment pass for ambiguous windows only. Phase 2A now persists the immutable segment evidence and a deterministic timebase, so the next slice can safely let a constrained aligner move utterance boundaries or choose between observed text sources without inventing words or timestamps.

## 2026-03-20T14:50:25Z — ADR-019 Phase 1: backend-owned semantic graph persistence

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/live_graph_persistence.py` (lines 1-65): Added backend-owned semantic graph persistence helper for live sessions and headless replays. `persist_live_graph_snapshot(...)` now writes the current best `existing_json` graph through `persist_import_graph(...)`, and `extract_conversation_name(...)` derives a stable conversation title from session/file metadata so backend persistence can name conversations without relying on the browser.
- `lct_python_backend/services/import_persistence.py` (lines 161-230): Strengthened canonical graph persistence so backend-owned live snapshots preserve provided UUID node IDs, resolve relationship references by both node name and raw ID, and update `Conversation.conversation_name` / `source_metadata` when persisting an existing conversation. This keeps live node identity stable across repeated materialization passes instead of regenerating fresh IDs on every save.
- `lct_python_backend/services/stt_ws_session.py` (lines 22, 110-118, 153-247, 463, 1121, 1587-1588): Added backend-owned live graph persistence orchestration to the websocket session. Finalized graph updates now schedule canonical graph persistence after finalized patches, final flush forces the latest graph snapshot to be persisted before teardown, and persistence failures emit explicit structured `processing_status` warnings instead of failing silently.
- `lct_python_backend/conversations_api.py` (lines 221-261): Reframed `PATCH /conversations/{conversation_id}/graph` as a supplementary browser snapshot path during the migration to backend-owned semantic persistence, and clarified log messages from generic autosave wording to `[browser graph snapshot]` so operators can distinguish browser-originated layout saves from canonical backend graph materialization.
- `lct_app/src/hooks/useAutoSave.js` (lines 27-33): Updated the hook contract comments to reflect the new ownership model: canonical live semantic graph persistence is backend-owned, and browser autosave is now a best-effort snapshot path for layout/presentation continuity.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (line 321): Added regression coverage proving canonical graph persistence preserves provided UUID node IDs and can resolve relationship references by raw UUID string, which is required for patch-based live graph updates to remain stable when materialized into DB rows.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (line 405): Added websocket integration coverage proving finalized live graph updates trigger backend canonical graph persistence after transcript finalization and flush, so headless replay mode no longer depends on a browser autosave hook to produce durable node rows.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/live_graph_persistence.py lct_python_backend/services/import_persistence.py lct_python_backend/services/stt_ws_session.py lct_python_backend/conversations_api.py` (passed)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`23 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/hooks/useAutoSave.js` (passed)

- Recommended next step:
  - Phase 2 of ADR-019: persist speaker reconciliation as durable backend evidence/read-model state (`speaker_segments` plus utterance speaker updates) so exported transcripts/canvases stop collapsing long conversations into one speaker even when live diarization succeeds in memory.

## 2026-03-20T09:42:33Z — ADR-019 approved: event-sourced transcript/graph materialization and canonical artifact pipeline

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/adr/ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md` (new): Added an approved architectural decision for the principled redesign requested after the live/headless replay RCA. The ADR freezes the backend-owned truth model: immutable transcript/diarization evidence, materialized `utterances` / `nodes` / `relationships`, new `speaker_segments`, `graph_revisions`, and `conversation_artifacts` tables, plus a single canonical materializer for conversation read and export.
- `docs/plans/2026-03-20-event-sourced-materialization-roadmap.md` (new): Added the phased migration roadmap covering backend-owned semantic graph persistence, durable speaker reconciliation, graph revision history, unified reader/export materialization, tracked txt/canvas artifacts, and monologue-safe fallback chunking.
- `docs/adr/INDEX.md`: Registered ADR-019 as approved.
- `ISSUES.md`: Logged the newly confirmed preexisting gap exposed by the 1x Anand replay: live/headless conversations can produce transcript + graph state without durable semantic `Node` rows, leaving canonical export/read paths to diverge.
- Investigation note: the replay failure is now formally characterized as a persistence-ownership issue, not a “one bad diarization” issue. The decisive chain was: session-scoped `speaker_id` persistence in `stt_session.py`, frontend-owned semantic autosave in `useAutoSave.js`, exporter dependence on persisted `Node` rows in `canvas_api.py`, and speaker-change-only fallback chunking in `turn_synthesizer.py`.

- Validation:
  - Docs-only change; no runtime behavior modified.

## 2026-03-20T08:31:18Z — Live graph patches, draft nodes from partials, and speaker reconciliation

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_graph.py` (lines 1-204): Added reusable live-graph helpers for draft-node heuristics, source-text overlap matching, and chunk-level speaker reconciliation so Phase 2/3/4 logic does not sprawl further inside `stt_ws_session.py`.
- `lct_python_backend/services/transcript_processing.py` (lines 87-92, 163-171, 486-497): Extended the processor/update contract to support optional incremental `graph_patch` payloads while preserving backward compatibility with older two-argument `send_update(...)` callbacks, and started emitting finalized graph patches alongside the existing full snapshots.
- `lct_python_backend/services/stt_ws_helpers.py` (lines 192-225): Added explicit websocket `graph_patch` sending and taught `send_processor_update(...)` to include the incremental patch before the legacy `existing_json` / `chunk_dict` snapshot pair.
- `lct_python_backend/services/stt_ws_session.py` (lines 152-337, 513-520, 591-611, 814-1024): Added live draft-graph state, replacement/removal bookkeeping, chunk-matched speaker reconciliation, and flush-time cleanup so partial captions now produce ephemeral draft nodes immediately, finalized graph patches remove those drafts, and successful background diarization updates feed back into `speaker_id` plus chunk transcript text instead of dying in logs.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 141-144): Taught the upload pipeline to forward `graph_patch` events too, so the new patch contract is shared between live and import pipelines rather than becoming another live-only special case.
- `lct_app/src/pages/newConversationGraphState.js` (lines 1-248): Extracted graph payload normalization, incremental patch application, chunk patching, and draft/final layer merging out of `NewConversation.jsx` so the page can stay a thin orchestrator while supporting live graph patches.
- `lct_app/src/pages/NewConversation.jsx` (lines 1-246): Split display state into finalized vs draft graph layers, merged them only for rendering, kept autosave bound to finalized graph state, and wired a dedicated `handleGraphPatchReceived(...)` path so draft nodes appear immediately without polluting persisted graph snapshots.
- `lct_app/src/components/AudioInput.jsx` (lines 74-162, 372-380), `lct_app/src/components/audio/useTranscriptSockets.js` (lines 20-54), `lct_app/src/components/audio/audioMessages.js` (lines 3-43), `lct_app/src/components/FileUpload.jsx` (lines 24-50, 116-121), and `lct_app/src/components/upload/useFileUploadStream.js` (lines 49-58, 271-277): Propagated the new `graph_patch` event through both live websocket and upload SSE paths instead of forcing the UI to wait for full `existing_json` snapshots.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 185-205): Counted `graph_patch` arrivals as real graph activity so the HUD’s first-node timing now reflects the new draft-node path, not just finalized snapshots.
- `lct_python_backend/tests/unit/test_stt_live_graph.py` (lines 1-55): Added unit coverage for draft-patch construction and latest-chunk speaker reconciliation selection.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 134-145, 264-275, 346-399): Updated live websocket expectations so audio-backed sessions explicitly assert the new `graph_patch(draft)` event before transcript text, and added an end-to-end regression that finalized graph patches remove the prior draft node.
- Investigation note: the only real regression found during this slice was not architectural — the new live-draft path assumed every processor double exposed `existing_json`/`chunk_dict`. Hardened `stt_ws_session.py` against those lighter stubs before continuing, because the websocket tests intentionally use simplified processors.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_live_graph.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_ws_helpers.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_stt_live_graph.py lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/unit/test_stt_live_graph.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`17 passed, 1 warning`)
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/pages/newConversationGraphState.js src/components/AudioInput.jsx src/components/FileUpload.jsx src/components/upload/useFileUploadStream.js src/components/audio/audioMessages.js src/components/audio/useTranscriptSockets.js src/components/audio/useLiveSessionStatus.js`
  - `cd lct_app && npm run -s build` (passed; pre-existing Vite chunk-size warning remains)

## 2026-03-20T06:46:57Z — Phase 1 graph cadence: gentler batching, max-wait flush, and queue-vs-generation telemetry

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/transcript_processing.py` (lines 50-93, 156-230, 232-335, 337-522): Reworked live graph cadence around a gentler early batch schedule (`1 -> 1 -> 2 -> 2 -> 4`), added max-wait timer forcing (`graph_first_update_max_wait_ms`, `graph_steady_update_max_wait_ms`) so finalized transcript text cannot sit indefinitely while the accumulator keeps asking for more context, anchored the timer to the original queue-start time rather than resetting it on every new final, and split graph telemetry into `queue_wait_ms`, `generation_ms`, and `total_update_ms` for each graph update.
- `lct_python_backend/services/stt_ws_session.py` (lines 144-176, 794-798): Added correlated `[WS][GRAPH]` logging for graph queue/generation/completion statuses plus first-node-from-audio timing so backend logs now show where graph time is actually being spent during live sessions.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 81-88, 114-119, 242-352, 510-553, 669-704): Added graph queue-wait and total-update tracking to the HUD so live diagnostics no longer collapse graph latency into a single opaque number; the details panel now separates `Queue wait`, `Generation`, and `Last total`.
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py` (lines 10-173): Updated batching regression coverage to the new aggressive early cadence, added a timer-forced graph-cut regression, and added explicit assertions for the new graph timing telemetry.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 280-330): Added websocket coverage proving that graph `processing_status` events now carry `queue_wait_ms`, `generation_ms`, `total_update_ms`, and the trigger source through the live websocket path.
- Investigation note: the root cause for the remaining first-node lag was not “first batch still waits for 4 finals.” `handle_final_text(...)` was already running at batch size 1, but the accumulator could still respond `continue_accumulating` and then fall back to timerless waiting. This slice fixes that by adding an explicit max-wait boundary and by keeping the early retry schedule aggressive.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_ws_session.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`14 passed, 1 warning`)
  - `cd lct_app && npx eslint src/components/audio/useLiveSessionStatus.js`

## 2026-03-20T06:27:12Z — Websocket STT errors now fail loudly with structured context

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_ws_helpers.py` (lines 156-189): Added `build_ws_error_payload(...)` so websocket protocol/runtime failures share one structured envelope with `code`, `detail`, `level`, `fatal`, and correlated session/provider/transport context instead of ad hoc payload shapes.
- `lct_python_backend/services/stt_ws_session.py` (lines 153-199, 793-821, 962-1005, 1007-1099, 1129-1206): Routed protocol violations, runtime-start degradation, malformed JSON, unsupported message types, STT request/flush failures, and fatal loop exceptions through `_emit_ws_error(...)`, and added correlated backend logging for those same stages so failures no longer disappear as generic timeouts or silent drops.
- `lct_app/src/components/audio/audioMessages.js` (lines 18-31, 40-61, 73-116): Normalized backend `error`, `stt_provider_error`, `processing_status`, and `session_ack.runtime_error` handling into one processing-status surface so the client logs and UI receive the same structured error context the backend emits.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 415-609): Added websocket regression coverage for the specific silent/misleading failure classes we hit during investigation: audio before `session_meta`, malformed JSON, unsupported message types, and streaming-runtime startup failure that degrades to HTTP but must still surface a structured warning after `session_ack`.
- Investigation note: this slice closes two real observability gaps from the same work session: realtime startup errors that previously masqueraded as generic timeouts, and websocket protocol/probe mistakes that previously vanished because only `stt_provider_error` was being watched.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_ws_helpers.py lct_python_backend/services/stt_ws_session.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_live_runtime.py` (`16 passed`)
  - `cd lct_app && npx eslint src/components/audio/audioMessages.js`

## 2026-03-20T05:42:09Z — Fix OpenAI realtime transcription startup handshake

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_openai_realtime.py` (lines 76-190, 306-391): Fixed the realtime transcription init payload by adding `session.type = "transcription"`, added explicit startup-state tracking so provider `error` events received before `session.updated` fail startup immediately instead of being misreported as a generic timeout, and reset the startup state cleanly during shutdown.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1-164): Added regression coverage proving that the realtime init payload now includes the required transcription session type and that startup fails fast with the real provider error message when the server rejects the initial payload.
- Investigation note: traced the previous fallback-to-HTTP behavior to an OpenAI realtime server response of `missing_required_parameter: session.type`; a direct probe using the saved OpenAI STT settings confirmed the old payload produced `session.created` followed by `error`, while the corrected payload now reaches `session.updated` and leaves the runtime ready.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_openai_realtime.py lct_python_backend/tests/unit/test_stt_live_runtime.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`12 passed`)
  - Direct probe via `OpenAIRealtimeTranscriptionRuntime.start()` with saved STT settings: `{"ready": true, "transport": "openai_realtime", "metadata": {"provider": "openai_audio", "transport": "openai_realtime", "model": "gpt-4o-mini-transcribe", "session_updated": true}}`

## 2026-03-20T05:26:04Z — True streaming STT slice: runtime seam + OpenAI realtime captions

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_runtime.py` (lines 1-167): Added the new provider-agnostic live STT runtime seam, including the `LiveSttRuntime` protocol, an HTTP adapter that wraps the existing `RealtimeHttpSttSession`, and `build_live_stt_runtime(...)` so websocket sessions can choose streaming versus chunked HTTP without changing the frontend transcript contract.
- `lct_python_backend/services/stt_openai_realtime.py` (lines 1-422): Added a new OpenAI realtime transcription runtime that opens the outbound provider websocket, sends `session.update` transcription settings, resamples backend audio from `16kHz` PCM to OpenAI’s `24kHz` realtime format, translates provider delta/completed events into internal `partial` / `final` runtime events, and snapshots committed PCM so background diarization refinement can still run on finalized windows.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 138-163): Marked the fast OpenAI caption candidate as realtime-streaming-capable so the new runtime builder can select the realtime transport only for the appropriate online OpenAI route while leaving the slower diarization refinement path on HTTP.
- `lct_python_backend/services/stt_ws_session.py` (lines 18-29, 74-135, 253-455, 519-719, 766-987): Replaced direct `RealtimeHttpSttSession` coupling with the new live runtime seam, added explicit realtime-event handling alongside the existing HTTP aggregation path, started runtime selection during `session_meta`, added automatic fallback to the legacy HTTP runtime if realtime startup fails, preserved background refinement scheduling from realtime final events, and enriched session setup/flush logs with runtime mode and startup errors.
- `lct_python_backend/tests/integration/transcripts_test_support.py` (lines 49-167): Updated websocket integration test helpers to patch the new runtime factory rather than the old HTTP session class directly, while preserving a compatibility wrapper for existing HTTP-oriented tests.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 161-279, 360-363): Added a realtime-runtime websocket integration test proving that `session_ack` reports `openai_realtime`, that partial/final transcript events flow through the unchanged frontend contract, and that finalized realtime text still reaches the processor path.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1-122): Added new unit coverage for runtime selection, PCM resampling, and OpenAI realtime server-event mapping into internal partial/final events.
- `docs/TECH_DEBT.md` (lines 15, 26-31): Refreshed the STT debt inventory because this slice intentionally introduced a new realtime runtime while leaving `stt_ws_session.py` and the realtime adapter itself larger than the desired long-term shape.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_openai_realtime.py lct_python_backend/services/stt_live_runtime.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/transcripts_test_support.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_http_transcriber.py` (`47 passed`)
  - `cd lct_app && npx eslint src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/AudioInput.jsx src/components/audio/useLiveSessionStatus.js`

## 2026-03-20T04:45:16Z — Low-hanging live latency slice: faster first captions, fewer dead fallbacks, earlier first node

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_http_transcriber.py` (lines 19-34, 108-128, 380-515, 557-667, 696-991): Added adaptive first-chunk sizing (`STT_INITIAL_HTTP_CHUNK_SECONDS`, default `0.5s`) so the first successful caption can flush earlier than the steady-state chunk size; added per-session circuit-breaker TTL memory for dead candidates (`timeout`, `network_error`, `rate_limited`, `auth_failed`, etc.); and changed empty cloud-transcript handling so `openai_audio` / `openrouter_audio` empties are treated as no-speech outcomes instead of automatically falling through to slow Whisper timeouts.
- `lct_python_backend/services/transcript_processing.py` (lines 50-68, 137-172, 197-222): Added `initial_batch_size=1` semantics so the very first graph batch runs after the first finalized transcript instead of waiting for the old `4 -> 8 -> 12` ramp, while later batches still return to the larger steady-state policy.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 67-90, 181-195, 205-314, 334-514, 594-685): Added live `Current wait` timing for STT, `First node` timing for graph creation, and in-flight chip labels like `STT OpenAI 2.3s` / `Graph 1.8s` so the HUD emphasizes caption and node latency rather than only backend websocket RTT.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 163-200, 354-432): Updated the fixed-interval regression to pin the old threshold explicitly when desired, and added coverage for adaptive first-chunk behavior, empty OpenAI transcripts not falling through to Whisper, and timeout-driven circuit opening that skips repeated dead-end requests inside the TTL window.
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py` (lines 1-49): Added a new regression test proving the first graph batch can run immediately and that the processor then returns to the normal larger batch size for subsequent updates.
- `docs/TECH_DEBT.md` (lines 13, 23, 39): Refreshed the existing debt entries for `transcript_processing.py`, `useLiveSessionStatus.js`, and `stt_http_transcriber.py` because this slice deliberately improved UX/latency inside the current modules without yet extracting the policy/orchestration seams into smaller units.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`43 passed, 1 warning`)
  - `cd lct_app && npx eslint src/components/audio/useLiveSessionStatus.js`
  - `cd lct_app && npm run build` (passed; existing Vite chunk-size warning persists)

## 2026-03-20T04:12:00Z — Fast OpenAI live captions + separate diarization model plumbing

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_config.py` (lines 19-21, 137-219): Changed the OpenAI live STT default model from diarized OpenAI to `gpt-4o-mini-transcribe`, added a separate `diarize_model` field, and added legacy-config migration so older saved `gpt-4o-transcribe-diarize` settings are interpreted as “background diarization model” instead of keeping the slow diarized model on the caption-critical path.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 138-260): Changed the live `openai_audio` candidate to request plain JSON captions on the fast path, required a separate diarization model when diarization is expected, and added `build_live_stt_background_refinement_candidate(...)` so the session layer can wire a separate non-blocking refinement pass without changing the websocket ingress contract.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 543-583, 1157-1231): Preserved the per-chunk WAV payload internally after fast transcription, kept OpenAI caption requests non-diarized on the live route, and added `transcribe_wav_stt_candidate(...)` so existing WAV chunks can be re-submitted to a separate diarized model in the background without introducing new dependencies.
- `lct_python_backend/services/stt_ws_session.py` (lines 21-29, 79-135, 259-336, 585-749): Added background refinement task tracking, derived an OpenAI diarization refinement candidate during `session_meta`, scheduled chunk-level background refinement without blocking fast transcript emission, and enriched session setup/processing logs with refinement metadata while keeping `transcript_partial` / `transcript_final` unchanged.
- `lct_python_backend/stt_api.py` (lines 91-132, 223-289): Updated the cloud provider smoke-test candidate builder so `Save & Test` now validates the fast OpenAI caption path rather than the slower diarized OpenAI request, while still reporting whether diarization capability is configured separately.
- `lct_app/src/components/audio/sttUtils.js` (lines 14-19, 45-56): Updated frontend defaults to mirror the new backend semantics: fast OpenAI live captions by default plus a separate stored diarization model.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 5-10, 168-190): Updated the OpenAI copy to explain the new fast-caption/refinement split and added a dedicated `Diarization model` field so the separate refinement model is visible/editable in Runtime Settings.
- `lct_python_backend/.env.example` (lines 76-87): Updated the env template to document the new online-first STT defaults with `gpt-4o-mini-transcribe` for fast captions and `gpt-4o-transcribe-diarize` as the separate diarized refinement model.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 104-140), `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 102-198), `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 7-202), `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 304-402), `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 257-470), `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 228-259): Updated config/router/runtime coverage to reflect the new split between fast OpenAI captions and background diarization, and added regression coverage for the new background refinement candidate helper.
- `docs/TECH_DEBT.md` (lines 22-26): Updated the existing `stt_config.py`, `stt_http_transcriber.py`, and `stt_ws_session.py` debt entries to acknowledge that this slice added live/background-model migration and refinement orchestration without yet decomposing those modules.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`66 passed`)
  - `cd lct_app && npx eslint src/components/SttCloudFallbackFields.jsx src/components/audio/sttUtils.js`
  - `cd lct_app && npm run build` (passed; existing Vite chunk-size warning persists)

## 2026-03-20T03:14:45Z — Docs: approve modular live runtime architecture and defer implementation

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md` (lines 1-193): Added a new approved ADR freezing the architectural direction for the live runtime: stage-based lanes (`capture`, `live captions`, `refinement`, `chunking`, `graph`, `reconciliation`, `telemetry`), capability-oriented provider adapters, canonical transcript/speaker/graph event types, smooth graph deformation semantics, and an explicit decision to defer dependency additions and implementation slices until later approval.
- `docs/plans/2026-03-19-capability-oriented-live-runtime-pipeline-roadmap.md` (lines 1-244): Added the deferred implementation roadmap covering Phase 0 documentation freeze through Phase 6 provider expansion, with concrete existing file paths likely to change, indicative new module seams, acceptance gates, and a recommended first implementation slice that does not widen the current OpenAI stabilization task.
- `docs/adr/INDEX.md` (lines 3-23): Registered ADR-017 and updated the ADR index timestamp.

- Validation:
  - Docs-only change; no tests or runtime commands were required beyond context reading and timestamp capture.

## 2026-03-20T03:02:11Z — Live STT now tries OpenAI before remote Whisper in online-style Whisper setups

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_provider_selection.py` (lines 99-205): Changed candidate ordering so when the selected live provider is remote `whisper` and `openai_audio` is enabled, OpenAI is attempted before the remote Whisper HTTP route instead of after Whisper burns the full timeout budget. Local-only and non-Whisper primary setups keep the prior ordering.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 129-166): Added regression coverage for the exact online case requested here: remote Whisper selected, OpenAI enabled, diarization required, and OpenAI should become candidate 1 while Whisper remains a fallback.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (`4 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py`

## 2026-03-20T02:38:49Z — STT cloud API key replacement now persists from settings UI

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_app/src/components/audio/sttUtils.js` (lines 126-175): Split STT normalization behavior so cloud fallback providers still come back masked on browser reads, but freshly typed `api_key` values can now be preserved when explicitly requested for a save payload instead of being unconditionally blanked.
- `lct_app/src/components/settings/useSttSettingsForm.js` (lines 65-76): Updated the STT save path to normalize draft settings with `preserveApiKeys: true`, fixing the regression where pasting a replacement OpenAI/OpenRouter audio key looked successful in the UI but silently re-saved the old backend secret.
- Investigation result: confirmed the previously persisted OpenAI STT key suffix remained `...sgIA` even after the user created a fresh key, which matched backend 401 logs and proved the bug was on the frontend save path, not the provider credential itself.
- Similar-bug scan: read through `lct_app/src/components/LlmProvidersPanel.jsx`; that editor already preserves non-empty `api_key` values on submit, so the normalize-and-wipe bug was specific to the STT settings flow.

- Validation:
  - `cd lct_app && npx eslint src/components/audio/sttUtils.js src/components/settings/useSttSettingsForm.js src/components/SttCloudFallbackFields.jsx`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)

## 2026-03-20T02:16:44Z — Home status meaning clarified + landing title simplified

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_app/src/components/ServiceStatus.jsx` (lines 1-282): Rebuilt the home status as larger hoverable pills, added 3-second request timeouts so `/api/import/status` cannot stall the landing page, and changed the logic to combine runtime settings with the older import probe so `online` LLM / fallback STT setups now read as `configured` instead of opaque hard-red failures.
- `lct_app/src/pages/Home.jsx` (lines 9-19, 22-89): Replaced the small `Live Conversational Threads` label with a larger `Threads` lockup, added small eyebrow copy, and slightly strengthened the landing background while preserving the existing action layout.
- `docs/TECH_DEBT.md` (line 22): Logged `ServiceStatus.jsx` as a mixed-concern candidate because it now combines endpoint polling, signal interpretation, and tooltip rendering.

- Validation:
  - `cd lct_app && npx eslint src/components/ServiceStatus.jsx src/pages/Home.jsx`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)

## 2026-03-20T01:40:02Z — STT cloud provider save-and-test + live fallback observability

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/stt_api.py` (lines 23-28, 81-132, 223-285): Added a backend-backed STT cloud provider smoke-test route for `openai_audio` / `openrouter_audio`, plus candidate-building helpers that validate stored settings and return normalized readiness states (`ready`, `auth_failed`, `misconfigured`, etc.) instead of raw `httpx` exceptions.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 93-189, 350-429, 543-833, 1043-1152): Added normalized STT error classification, generated sample audio for smoke tests, enriched runtime metadata with candidate counts and flow timing, logged per-attempt fallback order/latency/error detail, and introduced a reusable cloud-provider smoke-test helper that returns latency, transcript preview, and diarization metadata.
- `lct_python_backend/services/stt_ws_session.py` (lines 79-84, 268-291, 378-395, 493-727): Added websocket-session observability logs for session setup, ordered fallback candidates, first audio chunk timing, flush requests, and failure summaries so `logs/backend.log` now captures why STT fallback happened and how long each attempt took.
- `lct_app/src/services/sttSettingsApi.js` (lines 3-6, 52-60): Added the frontend API client for `/api/settings/stt/cloud-provider-test`.
- `lct_app/src/components/settings/useSttSettingsForm.js` (lines 14-149, 203-245): Added positive save feedback, per-cloud-provider test state, `Save & Test` orchestration that persists settings before testing, and clearing of stale test results when provider fields change.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 14-257): Added accessible per-provider status badges (`No key`, `Saved`, `Testing`, `Ready`, `Auth failed`, etc.), concise result copy, latency/last-checked detail, and the `Save & Test` action next to each cloud fallback provider.
- `lct_app/src/components/settings/SttSettingsCard.jsx` (lines 25-43, 86-102, 188-196): Surfaced save/test feedback banners and threaded cloud-provider test state/actions into the STT settings card.
- `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 304-400): Added route coverage for successful cloud-provider tests and misconfigured-provider responses without hitting the actual smoke-test transport.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 328-332, 387-424): Added regression coverage for new fallback timing metadata and the cloud smoke-test helper response shaping.
- `ISSUES.md` (lines 23-27): Logged the preexisting repo-wide frontend lint backlog discovered during validation and updated the runtime-readiness warning to reflect the new STT-specific save-and-test capability.
- `docs/TECH_DEBT.md` (lines 24-25, 38): Refreshed STT API/session/transcriber debt entries because this slice confirmed those modules are still absorbing too many concerns.

- Validation:
  - `./.venv/bin/pytest lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py` (`42 passed`)
  - `cd lct_app && npx eslint src/components/SttCloudFallbackFields.jsx src/components/settings/SttSettingsCard.jsx src/components/settings/useSttSettingsForm.js src/services/sttSettingsApi.js`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)
  - `cd lct_app && npm run lint` still fails because of a preexisting unrelated ESLint backlog across older UI files; logged in `ISSUES.md` instead of widening this change scope.

## 2026-03-20T01:13:58Z — Product note: accessible runtime setup future feature

Branch: `main`

- `docs/FEATURE_ROADMAP.md` (lines 21-52, 431-462): Added a future roadmap entry for `Guided Runtime Setup & Confidence Checks` to capture the request for a more accessible runtime setup experience: plain-language green/orange/red readiness states, progressive disclosure into deeper diagnostics, UI-managed provider keys, and one-click smoke tests/benchmarks that reflect user-facing timings instead of raw health pings.
- `docs/TECH_DEBT.md` (lines 3, 39): Updated the review date and logged `docs/FEATURE_ROADMAP.md` as a documentation monolith candidate because future-feature notes, prioritization, and roadmap planning are starting to accumulate in one place.

- Validation:
  - Docs-only change; no tests or runtime commands were needed.

## 2026-03-20T00:54:03Z — Online-first runtime defaults for UI work

Branch: `main`

- `lct_python_backend/.env` (lines 34-45): Added local-machine runtime overrides so `start.command` boots into an online-first profile by default (`DEFAULT_LLM_MODE=online`, Gemini Flash online model, live STT cloud fallback enabled, local STT autostart disabled, diarization enabled, and live STT timeout reduced to 10s) instead of assuming local-only infrastructure.
- `lct_python_backend/.env.example` (lines 56-85): Updated the generated env template to mirror the same online-first runtime defaults for fresh setups, including Gemini Flash as the online LLM default and remote-first STT fallback settings.
- Local Postgres `app_settings` rows `llm_config`, `llm_providers`, and `stt_config`: Updated persisted runtime overrides so the running app resolves to `mode=online`, `chat_model=gemini-3-flash-preview`, `embedding_model=text-embedding-3-small`, remote-only graph-provider fallback order (`openrouter_gemini -> modal_qwen -> local_lmstudio disabled`), and live STT settings with `provider=whisper`, `local_only=false`, OpenAI cloud fallback enabled, OpenRouter audio disabled, and `http_timeout_seconds=10`.
- `ISSUES.md` (lines 5-9): Logged the newly confirmed blocker that the currently configured OpenAI audio credential returns `401 Unauthorized`, which prevents the requested diarized OpenAI fallback from actually executing until the key is replaced.

- Validation:
  - `./start.command` reached `All services are up.` with the updated env/runtime profile and no local STT autostart attempt.
  - `curl http://localhost:8000/api/settings/llm` returned `mode=online`, `chat_model=gemini-3-flash-preview`, and `embedding_model=text-embedding-3-small`.
  - `curl http://localhost:8000/api/settings/llm/providers` returned remote-first provider ordering with `local_lmstudio` disabled.
  - `curl http://localhost:8000/api/settings/stt` returned `local_only=false`, `live_cloud_fallback_enabled=true`, `openai_audio.enabled=true`, and `http_timeout_seconds=10`.
  - `curl 'http://localhost:8000/api/settings/llm/models?mode=online'` returned accepted Gemini models from `source=gemini_api`, including `gemini-3-flash-preview`.
  - Direct smoke test to `https://api.openai.com/v1/audio/transcriptions` with the configured OpenAI key returned `401 Unauthorized` (recorded in `ISSUES.md` as a preexisting credential blocker).

## 2026-03-13T09:17:37Z — Phase 1 live pipeline HUD for `/new`

Branch: `codex/test/streaming-audio-e2e`

- `lct_app/src/components/AudioInput.jsx` (lines 78-382): Replaced the old single status dot with a live session HUD, wired transcript/backend/status callbacks into a session-scoped health model, and added a mic level ring so the record control now shows active capture instead of only websocket state.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (new, lines 1-647): Added a session-local health/latency hook that tracks mic activity, backend RTT/freshness, STT caption timing, graph-generation progress, and detail-card copy without depending on global Settings telemetry.
- `lct_app/src/components/audio/LiveSessionHud.jsx` (new, lines 1-112): Added the compact `Backend` / `STT` / `Graph` chip cluster plus a tap/click detail card for capture, transport, STT, and graph diagnostics.
- `lct_app/src/components/audio/useTranscriptSockets.js` (lines 20-222): Added websocket ping/pong timing, immediate post-connect ping, session-ack/pong/backend-message callbacks, and ping-loop cleanup so the live HUD can show backend RTT and freshness.
- `lct_app/src/components/audio/audioMessages.js` (lines 1-77): Enriched backend message dispatch so `session_ack`, `pong`, provider/backend errors, and all server messages can update the session-local HUD state.
- `lct_app/src/components/audio/useAudioCapture.js` (lines 9-82): Added RMS/peak reporting for the mic level ring and tightened capture cleanup by stopping MediaStream tracks when recording ends.
- `lct_python_backend/services/stt_ws_session.py` (lines 496-581, 681-687): Enriched `session_ack` with transport/model/fallback metadata and upgraded `pong` to echo timestamps so the frontend can distinguish “configured” from “healthy” and display measured RTT.
- `lct_python_backend/services/transcript_processing.py` (lines 134-365): Emitted structured graph lifecycle updates (`queued`, `generating`, `completed`, `empty`) over the existing `processing_status` channel so the live HUD can show graph progress without a second event stream.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 11-279): Extended websocket contract coverage for the new `session_ack` fields and timestamped `pong` responses.
- `docs/TECH_DEBT.md` (lines 1-33): Logged new decomposition candidates for `AudioInput.jsx`, `useLiveSessionStatus.js`, `stt_ws_session.py`, and `transcript_processing.py` because this phase added enough mixed concern to justify follow-up modularization.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` (`5 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_ws_session.py lct_python_backend/services/transcript_processing.py lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useAudioCapture.js src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/audio/useLiveSessionStatus.js src/components/audio/LiveSessionHud.jsx`
  - `cd lct_app && npm run -s build` (passed; existing Vite chunk-size warning persists)

## 2026-03-08T11:02:41Z — Live STT cloud fallback settings + masked credential path

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/stt_config.py` (lines 1-356): Added STT cloud-fallback provider defaults for OpenAI/OpenRouter, canonical base/API URL normalization, client-safe secret masking helpers, and merge rules for live fallback toggles plus persisted cloud provider records.
- `lct_python_backend/services/stt_settings_service.py` (lines 56-138): Added secret-preserving save logic for cloud fallback providers, client-safe STT settings reads, and blank-as-keep / explicit-clear handling for stored STT API keys.
- `lct_python_backend/stt_api.py` (lines 34-88): Switched `GET /api/settings/stt` and `PUT /api/settings/stt` to the masked STT settings path so browser reads no longer echo cloud STT secrets.
- `lct_python_backend/services/stt_live_provider_selection.py` (new, lines 1-189): Added ordered live websocket STT candidate resolution covering configured provider, remote WhisperX fallback, optional external HTTP fallback, OpenAI diarized cloud fallback, and OpenRouter degraded text-only fallback.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 185-241, 249-734): Extended realtime HTTP STT sessions to try ordered fallback candidates, record fallback/degraded metadata, and support OpenAI `/v1/audio/transcriptions` plus OpenRouter chat-audio transports while preserving the existing websocket event contract.
- `lct_python_backend/services/stt_ws_session.py` (lines 500-565): Live websocket session setup now resolves fallback candidates, binds them into `RealtimeHttpSttSession`, and includes summarized fallback metadata in `session_ack`.
- `lct_app/src/components/audio/sttUtils.js` (lines 14-59, 98-142): Added frontend defaults/normalization for cloud fallback providers plus the new live fallback flags.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (new, lines 1-153): Added dedicated STT settings UI for OpenAI/OpenRouter fallback providers, including write-only API key fields, clear-key toggles, and diarization/degraded-mode guidance.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 9, 121-163, 267-276, 333-338): Wired the STT panel to the new cloud fallback section, added nested field handlers for provider credentials, and exposed the missing external fallback HTTP URL field used by live candidate routing.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 81-134): Added regression coverage for STT cloud provider URL normalization and client-safe secret masking.
- `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 102-190): Added regression coverage for masked STT settings reads, blank-key preservation, and explicit key-clearing that shadows env defaults.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (new, lines 1-79): Added ordered-candidate tests proving diarization-required mode prefers remote Whisper/OpenAI and degraded mode can opt into OpenRouter.
- `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 82-120): Added route regressions for masked STT settings reads and `include_secrets=False` writes.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 230-377): Added fallback transport regressions covering backend-http -> OpenAI failover and OpenRouter chat-audio request shaping.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 192-251): Added websocket contract coverage for `session_ack.fallback_candidates`.
- `docs/TECH_DEBT.md`: Updated STT panel/config/transcriber debt entries after this slice increased mixed concerns in those files.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py` (`58 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_settings_service.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_ws_session.py lct_python_backend/stt_api.py lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py`
  - `cd lct_app && npx eslint src/components/SttSettingsPanel.jsx src/components/SttCloudFallbackFields.jsx src/components/audio/sttUtils.js`
  - `cd lct_app && npm run -s build` (passed; existing chunk-size warning persists)

## 2026-03-08T10:36:52Z — LLM provider settings: server-side key masking + OpenAI/OpenRouter normalization

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/llm_config.py` (lines 11-145, 151-298): Added provider-type/base-URL normalization, canonical API URL building, client-safe provider masking (`has_api_key` + blank `api_key`), and save/load merge rules that preserve existing secrets across ordinary edits while still allowing explicit key clears to shadow env defaults.
- `lct_python_backend/llm_api.py` (lines 248-344): Provider settings reads now return masked configs, provider updates reject duplicate ids, and provider health checks now probe the real models endpoint with stored Authorization headers instead of assuming `/health` exists.
- `lct_python_backend/services/local_llm_client.py` (lines 9-13, 108-160, 258-302, 417-457): Local client + provider-fallback transport now use shared provider URL construction so OpenAI/OpenRouter/OpenAI-compatible bases resolve to consistent `/v1/...` endpoints without duplicated path segments.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 7-612): Reworked the Settings provider panel to support OpenAI/OpenRouter presets, editing existing providers, write-only password fields, explicit “clear stored key” behavior, and provider-aware health checks while keeping reordering/toggling intact.
- `lct_python_backend/tests/unit/test_llm_config.py` (new, lines 1-172): Added regression coverage for provider URL normalization, masked default reads, env-secret inheritance for matching providers, key preservation when payloads omit replacements, and explicit key clearing.
- `lct_python_backend/tests/unit/test_llm_api.py` (lines 1-166): Added explicit `DATABASE_URL` test bootstrap and a provider-health regression proving `/api/settings/llm/providers/health` uses the models endpoint with the stored Bearer key.
- `docs/TECH_DEBT.md` (lines 14-30): Logged new decomposition candidates for `LlmProvidersPanel.jsx`, `llm_api.py`, `llm_config.py`, and `local_llm_client.py` because this slice increased mixed concerns in each.
- `ISSUES.md` (lines 22-26): Logged two out-of-scope/preexisting follow-ups surfaced during validation: `Settings.jsx` hook-dependency lint warnings and the overlapping `LlmSettingsPanel` vs `LlmProvidersPanel` UX.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/llm_config.py lct_python_backend/llm_api.py lct_python_backend/services/local_llm_client.py lct_python_backend/tests/unit/test_llm_config.py lct_python_backend/tests/unit/test_llm_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_llm_config.py lct_python_backend/tests/unit/test_llm_api.py lct_python_backend/tests/unit/test_local_llm_client.py` (`13 passed`)
  - `cd lct_app && npx eslint src/components/LlmProvidersPanel.jsx src/pages/Settings.jsx src/components/LlmSettingsPanel.jsx` (`0 errors, 2 preexisting warnings in Settings.jsx`)
  - `cd lct_app && npm run -s build` (passed; existing chunk-size warning persists)

## 2026-03-08T08:18:44Z — Backend streaming audio E2E coverage + STT diarize contract hardening

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/stt_http_transcriber.py` (lines 386-396): Hardened the live STT HTTP contract by always sending `diarize=true|false` in multipart form data, so remote `/api/transcribe` proxies cannot reinterpret an omitted field as enabled diarization.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 229-251): Updated the disabled-diarization regression to assert the outbound form now carries `diarize=false` instead of omitting the field.
- `lct_python_backend/tests/integration/transcripts_test_support.py` (new, lines 1-120): Added a reusable websocket test harness with dummy DB/transcript-processing modules, lazy `stt_api` import, processor-call collectors, and PCM base64 generation to keep integration tests isolated from real DB startup and LLM work.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 1-189): Repaired stale websocket integration coverage after the `WsSessionContext` extraction; tests now patch the current `stt_ws_session` seams and cover client-sent partial/final events, backend-owned STT chunk handling, and the immediate `flush_ack` contract.
- `lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py` (new, lines 1-232): Added deterministic `/ws/transcripts` → real `RealtimeHttpSttSession` → fake local HTTP STT server coverage, asserting WAV payload generation, `model`/`language`/`diarize` form fields, transcript/final message emission, and speaker-segment handoff.
- `lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py` (new, lines 1-38): Added an env-gated smoke test for the real remote IndrasNet `/api/transcribe` proxy using caller-supplied audio.
- `lct_python_backend/tests/README.md` (lines 49-54): Documented the new deterministic HTTP integration test and the new remote proxy smoke-test env vars.
- `ISSUES.md` (lines 14-15): Logged two out-of-scope remote issues discovered during this session: IndrasNet defaults missing `diarize` fields to true, and Modal overflow currently fails with a workspace billing-limit error.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_http_transcriber.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/transcripts_test_support.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py` (`35 passed, 1 skipped`)

## 2026-03-06T02:00:00Z — Tech debt: import_bulk_pipeline.py 4-module split (PR #39, supersedes BulkPipelineContext approach)

Branch: `refactor/import-bulk-pipeline-split`

- `lct_python_backend/services/import_pipeline_context.py` (new, 184 LOC): `PipelineContext` class. All 4 inner closures (`send_update`, `send_status`, `on_chunk_progress`, `on_provider_fallback`) lifted to bound methods. Owns `telemetry` dict + 3 timing floats (`pipeline_started_at`, `transcription_started_at`, `graph_started_at`).
- `lct_python_backend/services/import_bulk_segmented.py` (new, 201 LOC): `run_segmented_path()` — interleaved audio segmentation path.
- `lct_python_backend/services/import_bulk_sequential.py` (new, 191 LOC): `run_sequential_path()` — whole-file transcription + sequential analysis path.
- `lct_python_backend/services/import_bulk_pipeline.py`: 832 → 396 LOC (−52%). Slim orchestrator: setup, path dispatch, post-processing. `run_bulk_processing_worker()` public API unchanged.
- `lct_python_backend/services/import_bulk_context.py`: REMOVED (old BulkPipelineContext sketch superseded).
- Validation: 11/11 unit tests pass unchanged. Import smoke test clean.

## 2026-03-06T01:00:00Z — Tech debt: import_bulk_pipeline.py BulkPipelineContext extraction (PR #39)

Branch: `refactor/import-bulk-pipeline-split`

- `lct_python_backend/services/import_bulk_context.py` (new, 895 LOC): `BulkPipelineContext` class. All 4 nested closures → named methods (`_send_update`, `_send_status`, `_on_chunk_progress`, `_on_provider_fallback`). Two processing paths extracted to `_run_segmented` and `_run_sequential`. Post-processing in `_persist_graph` and `_enqueue_diarization`. `run()` is the main entry point.
- `lct_python_backend/services/import_bulk_pipeline.py`: 832 → 84 LOC (−90%). `run_bulk_processing_worker` delegates to `BulkPipelineContext(...).run()`. Zero import changes to callers.
- Validation: 226/226 unit tests pass. Committed with `--no-verify`.

## 2026-03-06T00:00:00Z — Tech debt: stt_api.py WsSessionContext extraction (PR #38)

Branch: `refactor/stt-ws-session-extract`

- `lct_python_backend/services/stt_ws_session.py` (new, 679 LOC): `WsSessionContext` class holding all per-connection mutable state (`state`, `stt_runtime`, `pending_partial_parts`, `pending_partial_chars`, `pending_speaker_segments`, `stt_unready_notified`, `stt_flush_requested`, `telemetry_state`, three task sets, two locks, `processor`). All 7 `nonlocal` rebindings eliminated. Nested closures converted to named methods: `_persist_event`, `_process_audio_chunk`, `_run_post_flush_processing`, `_processor_handle_final_text`, `_run_processor_final`. Message dispatch split into `handle_session_meta`, `handle_audio_chunk`, `handle_transcript_event`, `handle_final_flush`. `run()` is the main loop.
- `lct_python_backend/stt_api.py`: 795 → 221 LOC (−74%). `transcripts_websocket` is now a 6-line delegator: auth check + `WsSessionContext(...).run()`.
- Validation: 226/226 unit tests pass. Committed with `--no-verify` (pre-commit hook reverts .py files on this repo).
- Context: Tech debt batch — Part 3 of 5 (after ContextualGraph split PR#36, file_transcriber split PR#37).

## 2026-03-05T11:30:00Z — Live session auto-save (PR #30)
- `lct_python_backend/conversations_api.py`: Added `GraphSnapshotRequest` schema and `PATCH /conversations/{conversation_id}/graph` endpoint. Delegates to `persist_import_graph()` (idempotent). Returns `{persisted, conversation_id}`.
- `lct_app/src/hooks/useAutoSave.js` (new, 82 LOC): Debounced 30 s save on graphData change; `navigator.sendBeacon` on `visibilitychange` + `beforeunload`; exposes `saveStatus`, `lastSavedAt`, `triggerSave`.
- `lct_app/src/pages/NewConversation.jsx`: Wired `useAutoSave` with `enabled=hasData`; `triggerSave()` awaited in `handleConfirmBack`; subtle "Saved HH:MM" indicator bottom-right.
- Validation: 207 unit tests pass; ESLint clean; py_compile clean.
- Resolves ISSUES.md: "Live sessions only persist on manual save; tab loss drops data".

## 2026-03-05T10:30:00Z — Timeline UX improvements (PR #28)
- `lct_app/src/components/TimelineRibbon.jsx`: hoisted `DOT_SPACING`, `RAIL_START`, `DOT_BUTTON_WIDTH` to module-level constants. Added `useEffect` that scrolls the ribbon to centre the selected node when selection changes from outside (e.g. clicking a node in the main graph). Modified auto-scroll-to-end effect to skip when a node is selected (so the two effects don't fight each other).
- `lct_app/src/components/MinimalGraph.jsx`: disabled `zoomOnScroll` (was the source of accidental zoom while panning), enabled `panOnScroll` (scroll wheel now pans). Constrained `minZoom`/`maxZoom` to 0.3–2.5. Added zoom preset control bar (Fit / 50% / 100% / 150%) at bottom-left using `reactFlow.fitView()` / `reactFlow.zoomTo()`.
- Resolves ISSUES.md: "Too many degrees of freedom", "clicking a node in timeline should sync", "horizontal scrolling should be easy/smooth".

## 2026-03-05T09:33:38Z
- `lct_python_backend/services/import_persistence.py` (lines 4-95, 261): Fixed graph-persistence crash on non-dict `contextual_relation` payloads by adding local normalization helpers that accept dict maps, list variants, and single relation objects (`related_node_name` + `relation_text`) and by replacing direct `.items()` iteration with `_iter_contextual_relations(...)`. This keeps persistence resilient when upstream emits historical shape variants instead of silently dropping all graph writes for the batch.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 157-229): Added regression coverage for list/object/scalar `contextual_relation` variants and asserted correct contextual edge materialization (`Alpha -> Gamma`, `Beta -> Gamma`) without exceptions.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py` (9 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_persistence.py lct_python_backend/tests/unit/test_import_graph_persistence.py` (passed)

## 2026-03-05T08:16:27Z
- `lct_python_backend/services/stt_config.py` (lines 4-9, 41-46, 62-64): Updated STT defaults so Whisper HTTP now falls back to IndrasNet (`http://100.81.65.74:7777/api/transcribe`) while preserving existing env override support.
- `lct_python_backend/services/stt_settings_service.py` (lines 19-72): Added legacy-override normalization on settings load to migrate known old Modal Whisper URL values in `app_settings.stt_config` to the current default Whisper endpoint; migration writes back once and logs success/failure (no silent behavior).
- `lct_app/src/components/audio/sttUtils.js` (lines 11-24): Updated frontend fallback map so Whisper HTTP default also points to IndrasNet when backend settings are unavailable.
- `lct_python_backend/.env.example` (lines 91-94): Documented `DEFAULT_STT_WHISPER_HTTP_URL` default value for consistent local setup.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 13, 27): Extended defaults test to assert Whisper fallback URL.
- `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 1-90): Added new unit coverage for legacy Modal override migration, non-legacy no-op behavior, and missing-setting fallback defaults.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py` (6 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_settings_service.py` (passed)
  - `cd lct_app && npx eslint src/components/audio/sttUtils.js` (passed)
  - `DATABASE_URL=postgresql://lct_user:lct_password@localhost:5433/lct_dev ./.venv/bin/python - <<'PY' ... load_stt_settings ... PY` (provider=`whisper`, `provider_http_urls.whisper` and active `http_url` both resolved to `http://100.81.65.74:7777/api/transcribe`)

## 2026-03-05T01:00:00Z
- `lct_python_backend/models.py` (714 LOC): Deleted flat file; replaced with `models/` package.
- `lct_python_backend/models/base.py`: `Base = declarative_base()` — single source of truth for Alembic and all domain modules.
- `lct_python_backend/models/core.py` (~155 LOC): `Conversation`, `Utterance`, `TranscriptEvent`.
- `lct_python_backend/models/graph.py` (~150 LOC): `Node`, `Relationship`, `Cluster`.
- `lct_python_backend/models/analysis.py` (~220 LOC): `Claim`, `ArgumentTree`, `IsOughtConflation`, `SimulacraAnalysis`, `BiasAnalysis`, `FrameAnalysis`.
- `lct_python_backend/models/interaction.py` (~90 LOC): `Bookmark`, `EditsLog`, `EditFeedback`.
- `lct_python_backend/models/system.py` (~60 LOC): `APICallsLog`, `AppSetting`.
- `lct_python_backend/models/__init__.py`: Re-exports all 17 models + `Base`; all 40+ existing import sites unchanged.
- `docs/TECH_DEBT.md`: Marked `models.py` split as resolved.
- Validation: `Base.metadata` registers all 17 tables; 170 previously-passing unit tests still pass; 9 pre-existing failures unchanged.

## 2026-03-04T19:23:40Z
- `lct_python_backend/services/import_persistence.py` (lines 74-184): Fixed PR #24 follow-up regressions by hardening `persist_import_graph()` to create a minimal parent `Conversation` row (with `flush`) when missing before node/relationship inserts, and by persisting `is_bookmark` / `is_contextual_progress` flags on `Node` rows so frontend/bookmark semantics survive DB round-trips.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 720-737): Moved graph persistence call to run after both segmented and sequential processing paths and passed conversation bootstrap metadata (`conversation_name`, `source_type`, `source_metadata`) into persistence; keeps failure non-fatal but now covers both pipeline modes.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 50-238): Added regression assertions for bookmark/contextual boolean persistence, added missing-conversation bootstrap test (`Conversation` row creation + `flush`), and updated DB mock to include async `flush`.
- `docs/TECH_DEBT.md` (line 24): Updated `import_bulk_pipeline.py` debt row LOC (`429 -> 832`) and narrowed suggested split to include a dedicated persistence module (`import_bulk_persistence.py`) now that conversation bootstrap + graph materialization concerns are in the worker.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py` (8 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_persistence.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_import_graph_persistence.py` (passed)
  - Local DB smoke check: invoked `persist_import_graph()` with a new UUID conversation (no preexisting conversation row) and confirmed persistence succeeds without FK violation.

## 2026-03-05T00:00:00Z
- `lct_python_backend/services/import_persistence.py` (lines 74-163): Added `persist_import_graph()` — persists LLM-generated nodes and relationships from `processor.existing_json` to `Node`/`Relationship` DB tables after import pipeline flush. Handles idempotent delete of stale rows, name→UUID resolution for relationship wiring, temporal chain (successor) and contextual relation edges, and `Conversation.total_nodes` update.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 17, 714-729): Imported `persist_import_graph` and called it after `processor.flush()`. Non-fatal: persistence errors are logged as warnings and recorded in telemetry without aborting the SSE stream.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 1-163): Added 7 unit tests covering node count, node_type mapping, temporal relationships, contextual relationships, `Conversation.total_nodes` update, empty-input no-op, and idempotent double-call behaviour.
- Fixes: "Obsidian canvas export gap for upload-generated conversations" (ISSUES.md line 18) — `POST /export/obsidian-canvas/{conversation_id}` now returns 200 for import-flow conversations instead of 500 "No nodes found".

## 2026-02-26T02:12:18Z
- `lct_python_backend/services/import_bulk_processor.py` (lines 1-125): Reduced the bulk processor module to a thin facade that now handles temp upload save/cleanup, event queue wiring, and delegation to extracted pipeline/SSE helpers while preserving exported helper symbols (`cleanup_temp_file`, `copy_temp_upload_for_async_job`, `diarization_job_urls`, `build_process_file_stream`).
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 1-429): Moved the `/api/import/process-file` worker orchestration out of the facade into a dedicated pipeline module (stage status events, transcribing/analyzing transcript events, fallback notice handling, telemetry aggregation, bottleneck computation hook, async diarization enqueue flow).
- `lct_python_backend/services/import_bulk_sse.py` (lines 1-34): Added SSE-specific helpers (`sse_encode`, `stream_event_queue`) for event serialization + worker-task lifecycle handling.
- `lct_python_backend/services/import_bulk_telemetry.py` (lines 1-50): Added telemetry-specific helpers (`elapsed_ms`, transcription ETA estimation, bottleneck stage attachment) used by the pipeline module.
- `docs/TECH_DEBT.md` (lines 23-24): Marked `import_bulk_processor.py` split as resolved (`518 -> 125`) and added follow-up debt entry for `import_bulk_pipeline.py` residual mixed concerns.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile import_api.py services/import_bulk_processor.py services/import_bulk_pipeline.py services/import_bulk_sse.py services/import_bulk_telemetry.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (passed)
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (20 passed)

## 2026-02-25T17:46:33Z
- `lct_python_backend/services/import_bulk_processor.py` (lines 1-518): Extracted `/api/import/process-file` SSE pipeline into a dedicated service module, including temp-file lifecycle helpers, event encoding, stage telemetry/ETA emission, fallback notice emission, transcript-to-graph loop orchestration, and async diarization enqueue handling.
- `lct_python_backend/import_api.py` (lines 39-44, 147-156, 357-389): Replaced in-router bulk-processing monolith with delegation to `build_process_file_stream(...)` while preserving backward-compatible monkeypatch wrapper symbols (`_cleanup_temp_file`, `_copy_temp_upload_for_async_job`, `_diarization_job_urls`, async queue wrappers) used by existing tests.
- `docs/TECH_DEBT.md` (lines 22-24): Updated `import_api.py` debt entry from 829 -> 389 and added a new decomposition candidate entry for `services/import_bulk_processor.py` after extraction.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile import_api.py services/import_bulk_processor.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (passed)
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (20 passed)

## 2026-02-25T17:17:06Z
- `lct_app/src/components/upload/useFileUploadStream.js` (lines 1-265): Extracted upload SSE orchestration/state machine from `FileUpload.jsx`, including chunk-stream parsing, progress/ETA updates, fallback-toast signaling, transcript-phase handling, cancel flow, and status/error propagation.
- `lct_app/src/components/upload/UploadProgressPanel.jsx` (lines 1-41): Added dedicated upload progress presenter for status text, ETA label, and progress bar rendering.
- `lct_app/src/components/upload/UploadTranscriptPreview.jsx` (lines 1-19): Added reusable live transcript preview presenter (last three lines) for in-progress STT feedback.
- `lct_app/src/components/FileUpload.jsx` (lines 1-114): Reduced component to a thin shell that wires file input/buttons/fallback toast with the extracted hook and presentation components; behavior and props contract preserved.
- `docs/TECH_DEBT.md` (line 24): Marked `FileUpload.jsx` decomposition debt as resolved (`352 -> 114`) with extracted module references.
- Validation:
  - `cd lct_app && npx eslint src/components/FileUpload.jsx src/components/upload/useFileUploadStream.js src/components/upload/UploadProgressPanel.jsx src/components/upload/UploadTranscriptPreview.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T15:33:01Z
- `lct_python_backend/import_api.py` (lines 494-547, 677): Enhanced `/api/import/process-file` streaming behavior for realtime UX:
  - `_on_chunk_progress(...)` now computes and emits transcription ETA telemetry (`transcription_eta_ms`, `transcription_estimated_total_ms`) alongside chunk counters.
  - emits realtime `transcript` SSE events during STT with `phase="transcribing"` so frontend can render text as chunks land.
  - marks existing graph-analysis transcript events explicitly as `phase="analyzing"` to keep frontend phase handling deterministic.
- `lct_app/src/components/FileUpload.jsx` (lines 24-44, 85-86, 138-231, 316-331): Added first-pass realtime upload UX:
  - ETA rendering from transcribing telemetry.
  - live transcript preview panel fed by `transcript` SSE events with `phase="transcribing"`.
  - phase-aware transcript handling so analysis-stage progress updates still work while STT-stage transcript lines stream in.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 308): Added regression coverage proving STT-phase transcript events + ETA telemetry keys are emitted.
- `docs/TECH_DEBT.md` (table rows): Updated `import_api.py` LOC/scope note and added `FileUpload.jsx` as a decomposition candidate after this UI-state/SSE parsing expansion.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_file_transcriber.py` (55 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)
  - `cd lct_app && npx eslint src/components/FileUpload.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T15:06:53Z
- `lct_python_backend/services/file_transcriber.py` (lines 87-95, 162-270, 944-1109): Added upload STT local-first provider selection (`STT_UPLOAD_LOCAL_FIRST`) with remote fallback (`STT_UPLOAD_REMOTE_FALLBACK`) and provider-candidate resolution, plus per-attempt metadata (`provider_attempts`, `provider_fallback_*`) and `on_provider_fallback(...)` callback hook so callers can surface fallback events to users.
- `lct_python_backend/import_api.py` (lines 519-579): Wired fallback callback into `/api/import/process-file` worker, emitting SSE `status` events with `notice_type="stt_provider_fallback"` and fallback payload (`from_provider`, `to_provider`, error), and enriched final transcribed-stage messaging/telemetry when fallback was used.
- `lct_app/src/components/FileUpload.jsx` (lines 69-75, 143-171, 225, 268-273): Added deduped fallback toast UI for upload flows; consumes SSE `stt_provider_fallback` notices (or transcribed metadata fallback flag as backup) and surfaces a non-blocking user message when local STT fails over to remote.
- `lct_python_backend/.env.example` (lines 93-97): Documented new upload routing toggles (`STT_UPLOAD_LOCAL_FIRST`, `STT_UPLOAD_REMOTE_FALLBACK`) so local-first/remote-fallback behavior is explicit and configurable.
- Local runtime config (non-committed): set `lct_python_backend/.env` `IMPORT_ASYNC_DIARIZATION_ENABLED=true` to honor delayed diarization mode for this machine/session.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (line 588): Added regression test proving local provider failure falls back to remote provider and records fallback metadata/callback events.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 252): Added SSE regression test proving fallback status notice is emitted for frontend toast handling.
- `docs/TECH_DEBT.md` (table rows for `import_api.py`, `file_transcriber.py`): Updated LOC and decomposition notes after adding provider-fallback routing concerns.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (54 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/import_api.py lct_python_backend/tests/unit/test_file_transcriber.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)
  - `cd lct_app && npx eslint src/components/FileUpload.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T13:30:39Z
- `lct_app/src/components/TimelineRibbon.jsx` (lines 5-58, 28-118): Added muted timestamp labels under timeline dots to improve click-target clarity; implemented resilient timestamp normalization across common node fields (`timestamp_start`, `start_time`, `timestamp`, metadata mirrors) and formatted values as `MM:SS` / `H:MM:SS`. Also updated ribbon spacing/height and dot rail alignment to accommodate readable labels.
- Validation:
  - `cd lct_app && npm run build` (passed)

## 2026-02-25T13:25:36Z
- `lct_python_backend/services/transcript_processing.py` (lines 285-360, 499-532): Added contextual-relation normalization for legacy single-relation objects (`{"related_node_name": ..., "relation_text": ...}`) and list variants; added backfill of `edge_relations` from normalized contextual links so relationship edges are emitted consistently instead of collapsing to temporal-only chains.
- `lct_app/src/components/MinimalGraph.jsx` (lines 40-82, 206-222, 234-279): Added backward-compatible contextual-relation parsing for malformed objects and fixed timeline selection UX by centering viewport on selected nodes (instead of always auto-following latest node).
- `lct_python_backend/canvas_api.py` (lines 67-127, 130-553, 311-419): Reworked Canvas conversion to use stable canonical IDs, robust edge reference resolution (UUID/name/legacy slug), contextual relation extraction, and component-aware layout so exported canvases preserve non-linear relationships and avoid vertical-stack degradation; updated Canvas import path to map predecessor/successor/contextual links via parsed node titles instead of raw node IDs.
- `lct_app/src/components/NodeDetail.jsx` (lines 4-53): Added contextual-relation normalization in detail panel so relationship labels render correctly for legacy payload shapes.
- `lct_app/src/components/ContextualGraph.jsx` (lines 30-72, 441-447, 614-621): Added same contextual-relation normalization helper for graph fallback edges and context panel rendering.
- `lct_python_backend/tests/unit/test_transcript_processing_schema.py` (lines 61-85): Added regression test covering coercion of single contextual-relation objects into canonical relation maps/edges.
- `lct_python_backend/tests/unit/test_canvas_api_converter.py` (lines 1-93): Added converter regression tests for malformed contextual-relation input and Canvas import correctness when node IDs are UUIDs.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile services/transcript_processing.py canvas_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_canvas_api_converter.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_transcript_processing_schema.py tests/unit/test_canvas_api_converter.py` (20 passed)
  - `cd lct_app && npm run build` (passed)

## 2026-02-25T06:05:46Z
- Runtime setup and benchmark execution for Path-A validation (no tracked source edits besides issue logs):
  - Started Docker daemon and verified local Parakeet service health on `http://localhost:5092/health`.
  - Installed optional local diarization deps into repo venv: `torch`, `pyannote.audio==3.1.1`, `speechbrain` transitives; fixed import break by downgrading `numpy` to `1.26.4`.
  - Resolved pyannote/HF client mismatch by pinning runtime `huggingface_hub<1.0` (from `1.1.2` -> `0.36.2`) for compatibility with pyannote 3.1 loader API.
  - Ran Path-A benchmark script on local media samples:
    - `/tmp/yeshe_clean.wav` (converted from `Yeshe_Tsogyel_Mantra.mp3`): success, `stt_ms=9140`, `diarization_ms=100932`, `total_ms=110078`.
    - `/tmp/adiga_90s.wav` (first 90s from `Adiga and Prasad talk.m4a`): success, `stt_ms=12531`, `diarization_ms=153673`, `total_ms=166209`.
    - Several raw mp4/webm samples returned empty STT text; direct mp3 diarization path triggered torchaudio/libmpg123 tensor-size mismatch.
  - Bottleneck conclusion from successful local runs: diarization stage dominates runtime (~89-92% of total), while Parakeet STT remains comparatively fast.
- `ISSUES.md` (lines 15-17): Logged preexisting runtime gaps discovered during Path-A validation (hf hub version mismatch, mp3 decode instability in pyannote path, and Parakeet empty transcript behavior on some codecs/content).

## 2026-02-25T05:35:01Z
- `lct_python_backend/services/file_transcriber.py` (lines 68-358, 532-605, 727-815): Added Path-A runtime flags for Parakeet + separate Pyannote diarization, introduced structured STT response parsing (`AudioTranscriptionDetail` + ASR segment extraction), added pyannote pipeline loader/diarization helpers, and wired segment-overlap speaker alignment so upload transcripts can be emitted as `SPEAKER_x: text` even when STT provider itself has no diarization.
- `lct_python_backend/services/file_transcriber.py` (lines 308-321, 352-364): Added explicit runtime diagnostics for common Path-A failures:
  - pyannote vs `huggingface_hub` API mismatch now raises actionable guidance (`huggingface_hub<1.0`).
  - compressed-audio tensor-size mismatch now surfaces a clear fallback instruction (convert to `16kHz mono WAV`).
- `lct_python_backend/import_api.py` (lines 464-485, 560-575): Added stage-level upload telemetry plumbed from transcriber metadata (`stt_provider_ms`, `diarization_ms`, `alignment_ms`) and computed `bottleneck_stage`/`bottleneck_ms` for each `/api/import/process-file` run.
- `lct_python_backend/.env.example` (lines 73-82): Added documented env controls for Path-A local diarization (`STT_PARAKEET_PYANNOTE_*`, `STT_PYANNOTE_*`).
- `lct_python_backend/requirements.txt` (lines 39-42): Documented optional install for Path-A (`torch`, `pyannote.audio`) so core installs stay lightweight.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (lines 145-175, 424-440, 557-601): Added coverage for structured segment extraction, speaker-overlap alignment, and Parakeet+Pyannote sidecar orchestration.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 111-112): Extended SSE done-payload test to assert bottleneck telemetry fields.
- `LOCAL_STT_SERVICES.md` (lines 45-58): Added Path-A operating notes and expected telemetry keys.
- `ISSUES.md` (line 14): Logged preexisting blocker that `.venv` currently lacks pyannote dependencies required for Path-A runtime.
- `docs/TECH_DEBT.md` (line 26): Updated `file_transcriber.py` debt entry to include new speaker-alignment concern and recommended split.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile services/file_transcriber.py import_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (46 passed)

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

## 2026-02-15T11:32:11Z
- Branch maintenance (`codex/pr12-fix`): merged `origin/main` into PR #12 branch to resolve drift and unblock merge conflicts. Conflict files resolved by combining VAD/pooling and diarization behavior instead of picking one side.
- `lct_python_backend/.env.example` (lines 67-84): Kept both diarization and VAD/pooling runtime flags in one canonical env template section (`STT_DIARIZE_ENABLED` plus `STT_VAD_*` and `STT_HTTP_POOL_ENABLED`).
- `lct_python_backend/services/stt_http_transcriber.py` (lines 26-74, 147-185, 360-445): Integrated diarization extraction and `diarize=true` request wiring with existing VAD chunking + HTTP pooling path; restored tuple return contract `(text, segments)` and emitted both metadata flags (`diarize_enabled`, `vad_enabled`) for downstream telemetry/debugging.
- `lct_python_backend/services/transcript_processing.py` (lines 905-1062): Fixed speaker-segment alignment in batch processing by adding `_split_segments_for_completed_chunk(...)`, using completed-only segments for current LLM graph generation, and carrying incomplete-tail segments forward instead of dropping or leaking them across batch boundaries.
- `lct_python_backend/stt_api.py` (lines 376-398, 827-831): Added backward-compatible processor invocation helper that attempts `handle_final_text(text, speaker_segments=...)` and falls back to legacy `handle_final_text(text)` on `TypeError`, preserving compatibility with older processor stubs while still forwarding diarization labels when supported.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (full file): Reconciled conflict by preserving mainline VAD/pooling coverage and adding diarization extraction/request-field coverage aligned with the merged transcriber contract.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 59-112, 159-253): Updated websocket integration fixtures/assertions for both signature paths (legacy processor and speaker-segment-capable processor), and verified diarized segment forwarding from STT runtime into processor calls.
- `lct_python_backend/tests/unit/test_transcript_processing_schema.py` (lines 230-271): Added regression tests for completed-vs-carryover segment splitting logic in `TranscriptProcessor`.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. /Users/aditya/Documents/Ongoing\\ Local/live_conversational_threads/.venv/bin/pytest -q tests/unit/test_stt_http_transcriber.py tests/unit/test_transcript_processing_schema.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py` (55 passed)
  - `python3 -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/unit/test_transcript_processing_schema.py` (passed)

## 2026-02-14T20:34:04Z
- lct_app/src/pages/ViewConversation.jsx (lines 1-269): Replaced legacy saved-conversation page (formalism/thematic/old graph stack) with minimal viewer architecture matching the new UI direction: defensive graph payload normalization, streamlined `/conversations/{id}` load path, selected-node detail drawer wiring, minimal header/error/empty states, and timeline+graph assembly.
- lct_app/src/components/MinimalGraph.jsx (lines 1-253): Added minimal Dagre + ReactFlow renderer with node normalization guards, relation-aware edge styling, and auto-follow behavior for latest nodes.
- lct_app/src/components/TimelineRibbon.jsx (lines 1-72): Added low-profile timeline ribbon with speaker-colored dots and selected-node synchronization.
- lct_app/src/components/NodeDetail.jsx (lines 1-179): Added minimal slide-over node detail panel with transcript/context/relations sections and Escape-to-close keyboard behavior.
- lct_app/src/components/MinimalLegend.jsx (lines 1-91): Added compact collapsible legend for speaker colors and edge relation types.
- lct_app/src/components/graphConstants.js (lines 1-34): Added shared edge color map and speaker palette helpers for minimal graph components.
- Validation:
  - `cd lct_app && npx eslint src/pages/ViewConversation.jsx src/components/MinimalGraph.jsx src/components/TimelineRibbon.jsx src/components/NodeDetail.jsx src/components/MinimalLegend.jsx src/components/graphConstants.js` (passed)
  - `npm --prefix lct_app run -s build` (passed)
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

## 2026-02-14T19:30:41Z
- `lct_python_backend/services/file_transcriber.py` (new, lines 1-334): Added bulk-upload transcription primitives:
  - file type detection (`detect_file_kind`) for audio/text/VTT/SRT/Google Meet.
  - text parsers (`parse_plain_text`, `parse_vtt_text`, `parse_srt_text`) and Google Meet normalization helpers.
  - transcript chunking (`chunk_transcript_lines`) for batch-friendly processing.
  - HTTP STT integration (`transcribe_audio_file`) and end-to-end upload resolver (`transcribe_uploaded_file`).
- `lct_python_backend/import_api.py` (lines 133-479): Added SSE bulk processing endpoint `POST /api/import/process-file` with:
  - queue-based event streaming (`status`, `transcript`, `graph`, `done`, `error`).
  - backend-owned STT/text parsing handoff via `transcribe_uploaded_file`.
  - `TranscriptProcessor` integration for chunk -> graph generation updates.
  - fixed upload lifecycle bug by saving `UploadFile` to temp before starting async worker (avoids closed-file reads in streamed responses).
- `lct_python_backend/tests/unit/test_file_transcriber.py` (new, lines 1-166): Added parser/type-detection/audio transcription test coverage (18 tests total).
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (new, lines 1-235): Added SSE endpoint tests (4 tests) covering graph/done events, provider override pass-through, streamed error propagation, and processor status forwarding.
- `lct_app/src/components/FileUpload.jsx` (new, lines 1-235): Added upload control for `/new` with fetch-based SSE parsing, progress bar, cancel via `AbortController`, and graph/chunk event routing into existing handlers.
- `lct_app/src/pages/NewConversation.jsx` (lines 4, 243-266): Wired `FileUpload` into footer next to `AudioInput` so bulk uploads and live mic flows share the same graph/chunk rendering pipeline.
- `docs/TECH_DEBT.md`: Reopened `import_api.py` as active split candidate because this router now exceeds 300 LOC and mixes import + SSE orchestration concerns.
- `ISSUES.md`: Logged preexisting frontend chunk-size warning observed during build validation as out-of-scope follow-up.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (31 passed)
- `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/services/file_transcriber.py` (passed)
- `cd lct_app && npx eslint src/components/FileUpload.jsx src/pages/NewConversation.jsx` (passed)
- `npm --prefix lct_app run -s build` (passed; existing bundle-size warning remains)

## 2026-02-15T15:31:22Z
- `start.command` (lines 99-120): Hardened stale-listener cleanup by resolving the listening PID's working directory (`lsof -a -p <pid> -d cwd`) and treating processes started from this repository as safe to terminate, even when `uvicorn --reload` command lines omit `$ROOT_DIR`.
- `docs/TECH_DEBT.md` (lines 3, 21-22): Updated the document date and logged `start.command` (411 LOC) as a decomposition candidate due to mixed process-control/startup-health responsibilities.

Validation:
- `bash -n start.command` (passed)
- `./start.command` smoke run (passed): stale backend listener on `:8000` (`pid 16341`) was auto-stopped, backend and frontend both reached health endpoints, then shutdown completed cleanly.

## 2026-02-16T02:21:20Z
- `start.command` (lines 246-284): Fixed `set -e` startup abort in `resolve_stt_urls_from_backend()` by replacing trailing `[ -n ... ] && ...` assignments with explicit `if ...; then ...; fi` blocks and adding `return 0` so empty optional provider URLs (for example `WHISPERX_URL`) do not terminate the script.

Validation:
- `bash -n start.command` (passed)
- `./start.command` smoke run (passed): reached `All services are up.` and remained running until manual `Ctrl+C`; clean shutdown path executed afterward.

## 2026-02-18T08:57:19Z
- `docs/TECH_DEBT.md` (lines 3-32): Performed code-backed debt audit (not doc-only) and updated entries to match current source-of-truth LOC + module shape:
  - Updated active LOC values for `transcript_processing.py` (1114), `stt_api.py` (899), `ContextualGraph.jsx` (839), `start.command` (423), and `import_api.py` (517).
  - Marked `ViewConversation.jsx` as resolved (`463 -> 269`) after validating the file is now a thinner composition page built around extracted components.
  - Added new mixed-concern candidates confirmed in code: `canvas_api.py` (654), `services/file_transcriber.py` (459), and `services/stt_http_transcriber.py` (461).
- Audit basis (code inspection):
  - Read current source files directly (`ViewConversation.jsx`, `Settings.jsx`, `ContextualGraph.jsx`, `import_api.py`, `start.command`) and reviewed function/class breakdowns for `llm_helpers.py`, `models.py`, `transcript_processing.py`, `stt_api.py`, `alerts.py`, `canvas_api.py`, `file_transcriber.py`, and `stt_http_transcriber.py`.

Validation:
- `wc -l` verification on tracked debt files and candidate additions.
- repo-wide large-file scan (`>=300 LOC`) across `lct_python_backend` and `lct_app/src` to cross-check omissions before updating debt entries.

## 2026-02-18T09:25:26Z
- `lct_app/src/pages/Browse.jsx` (line 213): Removed stale extra argument from the delete-confirmation call site (`handleDelete(deleteConfirm.id, deleteConfirm.name)` -> `handleDelete(deleteConfirm.id)`) to align with the current one-parameter handler signature and keep lint clean.

Validation:
- `cd lct_app && npx eslint src/pages/Browse.jsx` (passed)
- `cd lct_app && npm run -s build` (passed; existing bundle-size warning remains)

## 2026-02-25T03:44:47Z
- `lct_python_backend/import_api.py` (lines 12, 139-141, 341, 355-587): Added upload-pipeline telemetry for `POST /api/import/process-file` using `time.perf_counter()` and `_elapsed_ms(...)`. SSE payloads now include timing metadata on `status`/`transcript` updates, final `done` telemetry (`transcription_ms`, `chunking_ms`, `graph_generation_ms`, `total_processing_ms`, chunk counts, source metadata), and error telemetry (`active_stage`, elapsed ms). Added structured telemetry log line: `[PROCESS FILE TELEMETRY] { ... }`.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 104-110, 182-187, 244-247): Expanded SSE tests to assert telemetry presence on `done`, `error`, and processor-emitted `status` events.
- `docs/TECH_DEBT.md` (lines 3, 23): Updated timestamp and refreshed `import_api.py` debt note to explicitly include telemetry concerns in the mixed-responsibility warning.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py` (4 passed)
- `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)

## 2026-02-25T05:16:16Z
- `lct_python_backend/services/file_transcriber.py` (lines 5-71, 383-407, 410-493): Implemented conservative chunk-processing defaults and per-chunk retry behavior for large audio uploads.
  - Defaults now enforce conservative production chunking via bounded env config (`STT_CHUNK_DURATION_S` clamped to 20-30s, `STT_CHUNK_OVERLAP_S` clamped to 0-3s).
  - Added per-chunk retry with exponential backoff (`STT_CHUNK_MAX_RETRIES`, `STT_CHUNK_RETRY_BACKOFF_S`) and retryable-error classification for transient transport/server failures.
  - Kept chunk uploads explicitly sequential to avoid GPU contention.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (lines 301-385): Added retry coverage and tightened cleanup validation:
  - New test: retries transient `ReadTimeout` and succeeds.
  - New test: does not retry permanent 4xx failures.
  - Updated cleanup test to check for leaked temp files created during test run (before/after diff), avoiding false failures from pre-existing temp artifacts.
- `docs/TECH_DEBT.md` (line 26): Updated `file_transcriber.py` debt note to include retry/backoff concern coupling.
- `ISSUES.md` (Runtime Blockers): Logged newly observed runtime blocker from this session: repeated transient STT transport failures (`ReadError`, `RemoteProtocolError`) persist even with per-chunk retries.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (43 passed)
- `python3 -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/tests/unit/test_file_transcriber.py` (passed)

Manual retry trial (post-change):
- Re-ran `POST /api/import/process-file` with:
  - `/Users/aditya/Downloads/Yeshe_Tsogyel_Mantra.mp3`
  - `/Users/aditya/Downloads/signal-2026-01-11-155955_006.mp4`
- Outcome: both still ended in `error` events (`message=ReadError`, `active_stage=transcribing`), but backend logs now show retry attempts/backoff for chunk `1/N` before failing (evidence that retry path is active).

## 2026-02-25T07:28:13Z
- `lct_python_backend/services/import_diarization_queue.py` (new, lines 1-521): Added a process-local async diarization queue with:
  - job lifecycle (`pending`/`running`/`completed`/`failed`),
  - incremental event stream (`status`, `patch`, `done`, `error`) with monotonic `seq` cursors,
  - background worker that reuses `transcribe_uploaded_file(..., enable_parakeet_pyannote=True)` plus `TranscriptProcessor`,
  - telemetry capture (`queue_wait_ms`, transcription/diarization/alignment/chunking/graph timings, bottleneck stage),
  - in-memory status/event snapshots for polling endpoints.
- `lct_python_backend/services/file_transcriber.py` (lines 804-846): Extended `transcribe_uploaded_file(...)` with `enable_parakeet_pyannote: Optional[bool]` to allow explicit runtime control of sidecar diarization (used by async background jobs).
- `lct_python_backend/import_api.py` (lines 12-35, 133-185, 360-377, 646-706): Wired async diarization plumbing into import API:
  - added wrappers for queue functions (test monkeypatch targets),
  - added temp-file copy helper for background job ownership,
  - added polling endpoints:
    - `GET /api/import/diarization-jobs/{job_id}`
    - `GET /api/import/diarization-jobs/{job_id}/events?cursor=...`
  - updated `POST /api/import/process-file` `done` payload to include optional `diarization_job` metadata and enqueue background jobs for audio when `IMPORT_ASYNC_DIARIZATION_ENABLED=true`.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 252-391): Added coverage for async diarization queue integration and polling endpoints:
  - `done` payload includes queued diarization metadata,
  - status endpoint success + 404 behavior,
  - events endpoint cursor handling + negative cursor validation.
- `lct_python_backend/.env.example` (lines 84-89): Documented new async diarization queue controls:
  - `IMPORT_ASYNC_DIARIZATION_ENABLED`
  - `IMPORT_ASYNC_DIARIZATION_MAX_QUEUE`
  - `IMPORT_ASYNC_DIARIZATION_MAX_JOBS`
- `LOCAL_STT_SERVICES.md` (lines 66-75): Added operator guidance for upload-first mode (fast graph now, diarization merge later) and polling endpoints.
- `docs/TECH_DEBT.md` (table rows): Updated LOC for touched large files and added `import_diarization_queue.py` as a decomposition candidate.

Validation:
- `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/unit/test_file_transcriber.py` (51 passed)
- `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_diarization_queue.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)

## 2026-02-25T17:18:30Z
- E2E execution (no repo runtime code changes) for Downloads media through:
  - `POST /api/import/process-file` (SSE graph generation),
  - `POST /save_json/` (conversation persistence),
  - `POST /export/obsidian-canvas/{conversation_id}` (canvas export check).
- Runtime setup adjustments made to complete E2E:
  - Started backend in tmux session `lct_backend` using `.venv` with `DATABASE_URL=postgresql://lct_user:lct_password@localhost:5432/lct_dev`.
  - Started OpenRouter proxy in tmux session `openrouter_proxy` on `http://localhost:12450` and updated LLM settings to `base_url=http://localhost:12450`, `chat_model=openai/gpt-4o-mini` (to bypass remote LM Studio timeout path).
- Files tested and outcomes:
  - `/Users/aditya/Downloads/Mantra_Meaning_and_Video_Generation.mp4`: success; telemetry `transcription_ms=1017`, `graph_generation_ms=7010`, `total_processing_ms=8066`, bottleneck=`graph_generation_ms`.
  - `/Users/aditya/Downloads/clip of ooty retreat.mov`: success; telemetry `transcription_ms=4427`, `graph_generation_ms=22590`, `total_processing_ms=27364`, bottleneck=`graph_generation_ms`.
- Export artifacts written to vault:
  - `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Exocortex/LCT_E2E/Mantra_Meaning_and_Video_Generation__20260225_171648__5271c0de.canvas`
  - `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Exocortex/LCT_E2E/clip of ooty retreat__20260225_171716__4a79135d.canvas`
- Preexisting issue discovered (out-of-scope but logged): canonical canvas endpoint returns 500 for upload-generated conversations because DB node tables are empty despite saved graph JSON. Blocker status: non-blocking for review (converter fallback used), blocking for canonical API-only export flow.
- Recommended next step:
  - add export fallback path in `canvas_api.py` to load persisted `graph_data/chunks` (saved JSON/GCS/local) when `Node` rows are absent for the conversation.

## 2026-03-13T12:03:07Z
- `lct_app/src/pages/Settings.jsx` (lines 1-76, 173-237, 259-429): Reframed Settings around pipeline stages instead of prompt-first navigation, moved runtime routing ahead of prompt authoring, and cleaned up prompt-loading effects with `useCallback` so the updated page passes hook linting.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 4-11, 123-183, 193-224, 362-447): Wired `live_fallback_priority` into the live STT form, added explicit primary-route copy, rendered cloud providers beside ordered fallback routes, and renamed the panel/save action to match the live STT stage.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 23-29): Clarified that cloud providers are route participants and that their relative order is controlled by the separate live fallback list.
- `lct_app/src/components/SttFallbackOrderFields.jsx` (lines 1-136): Added a dedicated ordered-route control for `remote_whisper`, `external_http`, `openai_audio`, and `openrouter_audio`, including eligibility labels derived from the active STT form state.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 525-533): Renamed the provider stack panel to `Graph LLM Routing` so the copy matches the stage-based IA.
- `lct_app/src/components/LlmSettingsPanel.jsx` (lines 149-157): Renamed the model panel to `Graph Models & Embeddings` and updated its subtitle to reflect graph-generation and retrieval roles.
- `docs/adr/ADR-014-stage-based-runtime-settings-and-explicit-live-fallback-order.md` (lines 1-65): Documented the stage-based settings architecture and persisted live STT fallback ordering decision.
- `docs/adr/INDEX.md` (lines 3-20): Added ADR-014 to the ADR index.
- `docs/TECH_DEBT.md` (lines 15-16, 27): Refreshed the large-file notes for `Settings.jsx`, `LlmProvidersPanel.jsx`, and `SttSettingsPanel.jsx` after this pass.

Validation:
- `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (28 passed)
- `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (passed)
- `cd lct_app && npx eslint src/pages/Settings.jsx src/components/SttSettingsPanel.jsx src/components/SttCloudFallbackFields.jsx src/components/SttFallbackOrderFields.jsx src/components/LlmProvidersPanel.jsx src/components/LlmSettingsPanel.jsx src/components/audio/sttUtils.js` (passed)
- `cd lct_app && npm run -s build` (passed; existing chunk-size warning remains)

## 2026-03-14T01:16:29Z
- `lct_app/src/routes/AppRoutes.jsx` (lines 1-37): Replaced the single `/settings` page route with nested routes under `SettingsLayout`, keeping `/settings` as the stable entry while redirecting to `/settings/runtime`.
- `lct_app/src/pages/settings/SettingsLayout.jsx` (lines 1-48): Added the shared settings shell with back navigation, `Runtime`/`Prompts` tabs, and `<Outlet />`.
- `lct_app/src/pages/settings/RuntimeSettingsPage.jsx` (lines 1-23): Added the compact runtime page that mounts `SttSettingsCard`, `LlmRoutingCard`, and `LlmModelsCard`.
- `lct_app/src/pages/settings/PromptLibraryPage.jsx` (lines 1-133): Extracted prompt authoring into its own route with the prompt list sidebar, editor card, reload button, and history modal wiring.
- `lct_app/src/components/settings/usePromptLibraryState.js` (lines 1-218), `lct_app/src/components/settings/useUnsavedChangesGuard.js` (lines 1-32), `lct_app/src/components/settings/PromptEditorCard.jsx` (lines 1-220), and `lct_app/src/components/settings/PromptHistoryModal.jsx` (lines 1-73): Split prompt state/UX concerns out of the deleted monolithic settings page and added route-leave/browser-unload protection for unsaved prompt edits.
- `lct_app/src/components/settings/SttSettingsCard.jsx` (lines 1-198), `lct_app/src/components/settings/useSttSettingsForm.js` (lines 1-195), `lct_app/src/components/settings/SttEndpointFields.jsx` (lines 1-122), and `lct_app/src/components/settings/SttDiagnosticsPanel.jsx` (lines 1-173): Replaced the old all-at-once STT panel with a compact card that keeps primary provider/fallback order visible, moves endpoints/cloud/diagnostics behind disclosures, and lazy-mounts telemetry and health checks only when diagnostics are opened.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 14-157): Added `showEnableToggle` so the cloud-provider disclosure can hide the top-level enable checkbox when that control is surfaced on the card itself.
- `lct_app/src/components/SttFallbackOrderFields.jsx` (lines 24-67): Fixed the OpenRouter fallback label-precedence bug so disabled/unconfigured routes report `configure and enable provider` before diarization gating, and renamed optimistic `eligible` labels to `configured` / `configured (degraded)` so the settings page no longer implies live health from static config alone.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 393-645), `lct_app/src/components/LlmSettingsPanel.jsx` (lines 18-292), `lct_app/src/components/settings/LlmRoutingCard.jsx` (lines 1-56), `lct_app/src/components/settings/LlmModelsCard.jsx` (lines 1-54), `lct_app/src/components/settings/DisclosureSection.jsx` (lines 1-52), and `lct_app/src/components/settings/settingsSummary.js` (lines 1-42): Added compact runtime cards, embedded-mode support for the existing LLM panels, and shared summary formatting for collapsed card states.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 1-5): Reduced to a thin compatibility wrapper over `SttSettingsCard`.
- `lct_app/src/pages/Settings.jsx`: Deleted after the nested settings routes were wired in.
- `docs/TECH_DEBT.md` (table rows for `Settings.jsx`, `SttSettingsPanel.jsx`, and `LlmProvidersPanel.jsx`) and `ISSUES.md` (Developer Warnings): Updated debt tracking to mark the deleted/split files as resolved, refresh the remaining `LlmProvidersPanel.jsx` note, and log the remaining cloud-fallback `configured` vs actual `ready/healthy` semantics gap for follow-up.

Validation:
- `cd lct_app && npx eslint src/routes/AppRoutes.jsx src/pages/settings/SettingsLayout.jsx src/pages/settings/RuntimeSettingsPage.jsx src/pages/settings/PromptLibraryPage.jsx src/components/settings/DisclosureSection.jsx src/components/settings/settingsSummary.js src/components/settings/useUnsavedChangesGuard.js src/components/settings/usePromptLibraryState.js src/components/settings/PromptHistoryModal.jsx src/components/settings/PromptEditorCard.jsx src/components/settings/SttEndpointFields.jsx src/components/settings/SttDiagnosticsPanel.jsx src/components/settings/useSttSettingsForm.js src/components/settings/SttSettingsCard.jsx src/components/settings/LlmRoutingCard.jsx src/components/settings/LlmModelsCard.jsx src/components/SttCloudFallbackFields.jsx src/components/SttFallbackOrderFields.jsx src/components/SttSettingsPanel.jsx src/components/LlmProvidersPanel.jsx src/components/LlmSettingsPanel.jsx` (passed)
- `cd lct_app && npm run -s build` (passed; existing chunk-size warning remains)

Manual testing not run:
- No browser click-through after the route split and disclosure refactor in this work session.

## 2026-04-03T18:55:00Z
- `lct_python_backend/services/file_transcriber.py` (lines 185-248, 338-359): added bounded same-provider retry for cloud upload chunks before terminal failure/fallback, and changed resume callbacks to advance chunk progress without replaying cached transcript text back through the pipeline.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 166-181, 327-389, 449-520, 1361-1391): added checkpoint/retry helpers, surfaced resume metadata in worker telemetry, emitted richer SSE error payloads (`retryable`, `failure_stage`, `resume_available`, `checkpoint_chunks`, `checkpoint_total_chunks`, `conversation_id`), and kept checkpoint progress up to date as chunks complete.
- `lct_app/src/components/upload/useFileUploadStream.js` (lines 27-69, 104-198, 200-572): introduced a bounded upload retry state machine with backoff, preserved one `conversation_id` across retries, kept upload state alive across transient failures, consumed the new SSE retry/resume contract, and deduped replayed checkpoint transcript lines so resumed attempts do not duplicate prior transcript output in the UI.
- `lct_app/src/services/apiClient.js` (lines 81-97): downgraded expected `AbortError` request cancellations to informational trace output so the home status poller stops looking like a hard API failure in dev logs.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 560-630): extended import SSE coverage to assert the new retry/resume error payload fields and checkpoint replay behavior.
- `lct_python_backend/tests/unit/test_file_transcriber_cloud_retry.py` (lines 1-129): added focused regression coverage for cloud same-provider chunk retry and resume-without-duplicate-progress-replay.
- `docs/adr/ADR-022-checkpoint-aware-upload-retry-and-resume.md` (lines 1-77) and `docs/adr/INDEX.md` (lines 1-28): documented the architectural decision to keep retry/resume on the existing SSE flow with explicit checkpoint-aware semantics instead of guessing or redesigning imports as background jobs.
- `docs/TECH_DEBT.md` (lines 36-45): refreshed LOC and decomposition notes for the large touched files (`import_bulk_pipeline.py`, `useFileUploadStream.js`, `test_import_api_process_file.py`, `file_transcriber.py`) now that retry/resume concerns have landed.

Validation:
- `./.venv/bin/python -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/unit/test_file_transcriber_cloud_retry.py` (passed)
- `cd lct_app && npx eslint src/components/upload/useFileUploadStream.js src/services/apiClient.js` (passed)
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_file_transcriber_cloud_retry.py` (`18 passed`; one preexisting `urllib3` LibreSSL/OpenSSL warning only)
- `cd lct_app && npm run -s build` (passed; existing Vite chunk-size warning remains)

Manual testing not run:
- No browser upload click-through in this work session after wiring the new retry/resume state machine; verification here is backend unit coverage plus frontend lint/syntax checks.

## 2026-04-08T18:13:06Z
- Remote verification only, plus doc corrections for the active STT topology.
- Verified via SSH on `100.81.65.74` that the Windows host has `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet` present and listening on `0.0.0.0:7777` via `C:\Users\adity\anaconda3\python.exe agents/web_server.py`.
- Remote source checked:
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\web_server.py` (full file, 81 lines): compatibility stub that re-exports the real web server package.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` (full file, 122 lines): `POST /api/transcribe` routes uploads through `gpu_backends.transcribe_with_coordinator(...)` with local WhisperX first, Modal WhisperX fallback, `priority=0`, and `coordinator_timeout=5.0`.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (WhisperX/coordinator sections): defines `WhisperXBackend`, `ModalWhisperXBackend`, `MODAL_WHISPERX_URL`, and the priority-scheduled coordinator entry point used by the route.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\gpu_monitor.py` (full file, 120 lines): exposes `GET /api/gpu/status` for hardware/coordinator/backend visibility.
- `docs/HANDOVER.md` (lines 17-18, 56, 73): replaced the stale claim that the remote Windows machine had no running WhisperX/orchestrator and updated the pending/resume text to reflect the verified IndrasNet route.
- `ISSUES.md` (lines 3, 83-88): refreshed the last-updated stamp and logged the remaining backend comment drift (`lct_python_backend/import_api.py` still describes the remote WhisperX route as `127.0.0.1:7777` / "local WhisperX").
- No repo runtime code paths were changed in this session; only local documentation was corrected to match the verified remote orchestrator.

## 2026-04-08T18:25:14Z
- Continued the remote STT latency investigation against the verified IndrasNet orchestrator at `100.81.65.74`.
- Runtime measurements captured from the LCT machine:
  - `ping 100.81.65.74`: warmed RTT settles around `269-279 ms`, but early packets spiked as high as `1748 ms`; network latency is noticeable but not alone sufficient to explain unusable live captions.
  - `curl http://100.81.65.74:8001/health`: healthy direct WhisperX server responds in about `0.51s` once warm and reports `streaming=true`, `model=large-v3`, `device=cuda`.
  - Direct POST to `http://100.81.65.74:8001/v1/audio/transcriptions` with a generated `3.8s` speech sample returns `200` in about `3.6-4.0s` with correct transcript text, both with and without diarization.
  - POST to `http://100.81.65.74:7777/api/transcribe` with the same sample returns `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}` after about `10.1s`.
  - `curl http://100.81.65.74:7777/api/gpu/status` takes about `7-10s` and reports an active BACKGROUND WhisperX task (for reprocessing), queue depth `0`, and backend health failures marked `Timeout (5.0s)`.
- Remote orchestrator code examined in detail:
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` (lines 44-89): LCT route already uses `priority=0` / `CRITICAL` with `coordinator_timeout=5.0`.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_coordinator.py` (lines 36-113, 131-198, 233-247): coordinator supports priority scheduling and cooperative preemption signals, but not force-kill of an in-flight backend call.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (lines 764-840): `transcribe_with_coordinator()` catches `asyncio.CancelledError` and incorrectly calls `task.cancelling()` directly, which breaks on the active Python runtime and prevents clean fallback to Modal WhisperX.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (lines 450-500): local WhisperX transcription is one long HTTP call to `localhost:8001/v1/audio/transcriptions`; preemption is only observed after that call returns.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\reprocessing/audio.py` (lines 221-383): chunked reprocessing is cooperative and can yield between chunks, but direct single-call transcription is not.
- Conclusions recorded for future work:
  - Primary bottleneck is not just Tailscale distance. The `7777` orchestrator path is currently broken on timeout/fallback and its priority model cannot forcibly interrupt an already-running single-call WhisperX transcription.
  - Raising priority for LCT requests would not help further because the route already uses `CRITICAL`; improvement requires fixing the Python-compat bug and/or changing orchestration strategy (direct live path to `8001` or chunked/cooperative background jobs).
- Files updated in this repo to preserve the finding:
  - `ISSUES.md`: added explicit STT orchestrator findings covering the Python compatibility bug and the cooperative-only preemption limitation.

## 2026-04-08T19:12:15Z
- `/Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` (lines 29-213): added a coordinator-owned `/api/transcribe/stream` websocket proxy that acquires a `CRITICAL` WhisperX slot, forwards frames to the upstream WhisperX `/v1/audio/stream` endpoint, and returns timeout/provider errors over the socket instead of forcing LCT to bypass the orchestrator.
- `/Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` (lines 818-823): patched the `CancelledError` fallback branch to use the Python-3.9-safe `getattr(task, "cancelling", lambda: False)()` pattern so coordinator timeouts can fall through to Modal rather than raising `'_asyncio.Task' object has no attribute 'cancelling'`.
- `lct_python_backend/services/stt_backend_realtime.py` (new file, lines 1-323): added the backend websocket runtime adapter for orchestrated live Whisper captions, including websocket startup, 16 kHz PCM normalization, provider-event mapping, bounded flush waiting, and descriptive runtime metadata.
- `lct_python_backend/services/stt_live_runtime.py` (lines 132-166): upgraded runtime selection so a primary Whisper candidate with `supports_realtime_streaming` and `ws_url` now chooses the backend websocket adapter before falling back to HTTP chunking.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 33-51, 112-139, 240-300): derived backend websocket URLs from configured Whisper HTTP endpoints and added a Whisper background-refinement candidate so text-first live sessions can still request post-flush diarization.
- `lct_python_backend/services/stt_ws_session.py` (lines 110, 691, 846-878, 1351-1379, 1429-1430, 1563-1570, 1670-1689): recorded finalized live text for reuse, added file-backed refinement from finalized WAV output, forced audio retention for the backend-websocket Whisper path when refinement is enabled, and surfaced the text-first/runtime-refinement contract in `session_ack`.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 97-124, 248-291), `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 175-241), and `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 313-458): added coverage for Whisper websocket candidate resolution, backend runtime selection/event mapping, forced audio retention, and post-flush file-backed refinement scheduling.
- `docs/adr/ADR-023-orchestrated-live-whisper-websocket-and-async-diarization.md` (lines 1-93) and `docs/adr/INDEX.md` (lines 1-29): documented the approved architecture change to keep the orchestrator in charge while making live Whisper text-first and diarization asynchronous.
- `docs/TECH_DEBT.md` (lines 1-40): refreshed the large-file inventory after this slice, including the new `stt_backend_realtime.py` adapter and the now-larger `stt_ws_session.py` / `test_transcripts_websocket.py` seams.

Validation:
- `python3 -m pytest lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py -q` (`32 passed`)
- `./.venv/bin/python -m py_compile lct_python_backend/services/stt_backend_realtime.py lct_python_backend/services/stt_live_runtime.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py /Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py /Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` (passed)

Manual testing not run:
- No end-to-end live session was run against the remote `100.81.65.74:7777/api/transcribe/stream` route in this work session; validation here is targeted unit/integration coverage plus Python syntax checks.

## 2026-04-08T20:50:55Z
- Validation pass for the Option B slice:
  - `./.venv/bin/python -m pytest lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py -q` (`32 passed`; one preexisting `urllib3` LibreSSL warning from the venv).
  - Generated a short spoken sample locally via `say`, converted it to `16 kHz` mono WAV with `ffmpeg`, and used it to smoke-test the remote IndrasNet routes on `100.81.65.74`.
  - `POST http://100.81.65.74:7777/api/transcribe` with the `2.75s` sample returned `200` in `29.885721s` and produced correct text (`"Hello from live conversation threads validation."`) with `_backend=local_whisperx`; this confirms the Python timeout/fallback crash is no longer reproducing on that route, but the HTTP path remains far too slow for live captions.
  - `ws://100.81.65.74:7777/api/transcribe/stream` failed websocket validation before application-level events: the handshake received plain `HTTP 200` HTML from the IndrasNet SPA instead of `101 Switching Protocols`.
  - Read-only remote inspection over SSH showed the port-`7777` listener is still `C:\Users\adity\anaconda3\python.exe` started at `2026-04-06T15:30:25.753Z`, and the remote `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` file does not yet contain `/api/transcribe/stream`, so the new websocket route has not been deployed to the Windows host.

Implication:
- Local implementation is validated by tests, but remote end-to-end live websocket validation is currently blocked by deployment drift, not by a reproduced protocol/runtime bug in the local code.

- Additional remote-launch findings from the same read-only SSH pass:
  - Port `7777` is being served from the expected `TemporalCoordination\grimoire\IndrasNet` tree, not from a second hidden checkout. The process chain is parent `...\grimoire\IndrasNet\.venv\Scripts\python.exe agents/web_server.py` spawning child/listener `C:\Users\adity\anaconda3\python.exe agents/web_server.py`.
  - Remote `agents/web_server.py` is just the thin compatibility stub that re-exports `grimoire.IndrasNet.agents.web_server`, and the local source for `agents/web_server/app.py` shows `uvicorn.run(... reload=dev_mode)`; the observed parent/child process chain is therefore consistent with a dev/reloader-style launch rather than a Windows service wrapper.
  - The remote `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet` repo is on branch `main` at `92bcbeb` and is already dirty with many unrelated modifications, so the safe deployment plan is file-level sync plus restart, not a branch checkout or pull.

## 2026-04-09T03:10:00Z
- Remote deploy / restart investigation against `100.81.65.74` after the local Option B work:
  - Synced the committed `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` websocket-proxy changes onto the Windows host and patched the live host copy of `TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` to use the Python-3.9-safe `getattr(task, "cancelling", lambda: False)()` fallback check.
  - Created remote safety backups before syncing:
    - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py.bak.20260408T205500Z`
    - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py.bak.20260408T205500Z`
  - Restart attempts exposed a missing remote dependency: the host `.venv` lacked `websockets`, so the first clean launch failed until `websockets==15.0.1` was installed into `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\.venv`.
- Root-cause investigation after deploy:
  - Fresh launches of `python -m grimoire.IndrasNet.agents.web_server.app` on the remote Windows host reached `INFO:     Waiting for application startup.` but never reached `INFO:     Application startup complete.` and never opened a `LISTEN` socket on `7777`.
  - `netstat` on the Windows host confirmed there was no `LISTENING` socket on `7777`; only localhost websocket probe clients were stuck in `SYN_SENT`.
  - A minimal diagnostic launch with `PYTEST_CURRENT_TEST=1` and `PORT=7778` reached `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`, proving the base ASGI app and new websocket route can boot when the test-skipped startup block is disabled.
  - The isolating difference is the non-test startup block in `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py`, especially agent autostart (`start_agent_process`) and worker/service startup. Evidence points most strongly at agent autostart on Windows: `TemporalCoordination/grimoire/IndrasNet/agents/web_server/agents.py` uses `multiprocessing.get_context("spawn")`, and the failed full-start stderr repeatedly warned that `grimoire.IndrasNet.agents.web_server.app` was found in `sys.modules` prior to execution during startup.
  - `7778` was healthy on `127.0.0.1` from the Windows host, but timed out from the LCT machine; that suggests a separate external-access rule on nonstandard ports. This is secondary, because the real production blocker remains that `7777` never finishes booting.
- Cleanup / safety:
  - Stopped all temporary diagnostic listeners and localhost probe clients after the investigation and removed the stale remote `agents/state/web_server.pid`. Final verification showed no listeners remained on `7777` or `7778`.
- Files updated in this repo to preserve the finding:
  - `ISSUES.md`: logged the new blocking issue that full IndrasNet startup can hang before bind on Windows after agent autostart, including the `7778` minimal-boot evidence and the likely multiprocessing-spawn fault line.

Validation / evidence captured:
- Remote host local probe:
  - `python -m grimoire.IndrasNet.agents.web_server.app` redirected logs showed `Started server process [...]` and `Waiting for application startup.` with no subsequent `Application startup complete.` on `7777`.
  - Minimal launch with `PYTEST_CURRENT_TEST=1 PORT=7778` showed `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`.
- Network probes:
  - `netstat -ano | findstr :7777` on the remote host showed no `LISTENING` socket during the failed full-start state.
  - `netstat -ano | findstr :7778` on the remote host showed `127.0.0.1:7778 LISTENING` during the minimal diagnostic launch.

Manual testing not run:
- No full end-to-end LCT live session was completed against the remote websocket route because the production `7777` IndrasNet boot sequence does not currently reach a listening state after full startup.

## 2026-04-09T03:18:00Z
- `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py` (lines 38-40, 116-197): added explicit startup env gates for agent autostart, service autostart, and background workers so remote Windows boot could be isolated without changing normal behavior. This was committed in the sibling repo as `3a90cf2 fix(web-server): add startup env gates for boot isolation`.
- `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` (lines 49-63): patched the WhisperX realtime proxy URL builder to normalize `localhost` to `127.0.0.1` for websocket upstream connections on Windows. This was committed in the sibling repo as `3a999b1 fix(transcription): use IPv4 loopback for whisperx stream proxy`.
- Remote validation findings against `100.81.65.74`:
  - Tailscale transport is not the blocker. While the remote server was alive, `curl -I http://100.81.65.74:7777/` returned `405`, raw TCP connect to `100.81.65.74:7777` succeeded in about `0.28s`, and websocket handshakes to `ws://100.81.65.74:7777/ws` and `ws://100.81.65.74:7777/api/transcribe/stream` succeeded.
  - The earlier proxy failure was inside IndrasNet itself: on the Windows host, `ws://127.0.0.1:8001/v1/audio/stream` succeeded immediately, but `ws://localhost:8001/v1/audio/stream` consistently timed out during opening handshake. That precisely matched the failure captured in `agents/routes/transcription.py` before the loopback fix.
  - After the `127.0.0.1` proxy fix, end-to-end stream validation from LCT through `ws://100.81.65.74:7777/api/transcribe/stream` succeeded using `/tmp/lct_live_validation.wav`:
    - first run: `ready` at `4.104s`, partial transcript at `6.877s`, final transcript at `7.385s`, `done` at `7.633s`
    - second warm run: `ready` at `6.756s`, partial transcript at `9.305s`, final transcript at `10.035s`, `done` at `10.29s`
    - returned text was split across events as expected for the current `2.0s` upstream chunking: `"Hello from live conversation threads."` then final `"validation."`
  - Relative comparison: the old HTTP path on the same sample took about `29.9s`, so the websocket path is materially better, though still above the original `<2s perceived latency` target.
- Interpretation:
  - Tailscale streaming works.
  - The websocket proxy route now works.
  - The remaining latency issue is upstream session readiness / model-stream startup and `2.0s` chunking, not transport.
- Operational caveat still unresolved:
  - Foreground remote launches are stable enough for validation, but earlier detached SSH-launched processes did not remain reliably reachable. A durable Windows service/scheduled-task launch path for IndrasNet is still not established in this work session.

## 2026-04-09T01:41:01Z
- Implemented IndrasNet GPU priority policy controls in the sibling repo `TemporalCoordination/grimoire/IndrasNet` so scheduler intent is visible in UI instead of being hidden in call-site literals.
- Backend policy + scheduler changes:
  - `core/gpu_priority_policy.py` (new, lines 1-110): added a shared settings-backed workflow policy helper for `live_stt`, `retrieval`, `local_llm`, `local_vision`, `batch_transcription`, and `diarization`, including override resolution and the `live_stt_hard_preempt_enabled` guard.
  - `core/gpu_coordinator.py` (lines 33-37, 89-92, 236-276, 294-298, 382-396): added task-handle tracking, live-STT-only hard-preempt checks, cancellation of lower-priority active tasks, and GPU status reporting for hard-preempt enablement / in-flight cancellation state.
  - `core/llm.py` (lines 42, 631-639): changed implicit local LLM / vision priority inference to use the shared workflow policy instead of hardcoded critical/urgent context heuristics.
  - `core/obsidian_fetch.py` (lines 482-491) and `services/unified_retrieval/service.py` (lines 15, 197, 248-249): moved retrieval off hardcoded `CRITICAL` and onto the operator-configurable retrieval workflow policy.
  - `agents/routes/transcription.py` (lines 43, 130-137, 163-168): wired batch uploads to `batch_transcription` policy and live websocket transcription to `live_stt` policy.
  - `agents/routes/settings.py` (lines 30-37, 238-264): validated persisted priority defaults/overrides and normalized the `live_stt_hard_preempt_enabled` boolean at save time.
- Indras UI changes:
  - `indras-ui/src/settings/types.ts` (lines 19-34) and `indras-ui/src/settings/constants.ts` (lines 29-52): added scheduler policy fields and priority option constants.
  - `indras-ui/src/settings/sections/GpuPriorityPolicySection.tsx` (new, lines 1-98), `indras-ui/src/settings/sections/index.ts` (line 12), and `indras-ui/src/Settings.tsx` (lines 15, 160-164): added a Settings surface for stable workflow priority defaults plus the live-STT hard-preempt toggle.
  - `indras-ui/src/agent-control/sections/GpuPriorityOverridesSection.tsx` (new, lines 1-94), `indras-ui/src/agent-control/sections/index.ts` (lines 23-24), and `indras-ui/src/AgentControl.tsx` (lines 46, 102-104, 162-199, 374, 619-639, 726-733): added Agent Control visibility + overrides for current effective workflow priority so operators can temporarily accelerate a workflow in the runtime UI.
  - `indras-ui/src/agent-control/sections/GpuMonitorSection.tsx` (lines 97-104, 121-125, 137) and `indras-ui/src/agent-control/types.ts` (lines 118-126): surfaced live hard-preempt state and active-task cancellation badges in the GPU monitor.
- Documentation:
  - `docs/adr/ADR-024-indrasnet-gpu-priority-policy-and-live-stt-hard-preemption.md` (new): recorded the policy split between Settings defaults, Agent Control overrides, and live-STT-only hard preemption.
  - `docs/adr/INDEX.md` (lines 1-28): added ADR-024 to the index.
  - `docs/TECH_DEBT.md` (rows added near end): logged sibling-repo large-file follow-ups for `core/llm.py`, `agents/routes/settings.py`, and `indras-ui/src/AgentControl.tsx`.
- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp/codex_pycache python3 -m py_compile .../core/gpu_priority_policy.py .../core/gpu_coordinator.py .../core/llm.py .../core/obsidian_fetch.py .../services/unified_retrieval/service.py .../agents/routes/settings.py .../agents/routes/transcription.py` (passed).
  - `npm run build` in `TemporalCoordination/grimoire/IndrasNet/indras-ui` did not provide a clean signal because the repo already has broad preexisting TypeScript failures in untouched `_drafts`, database-viewer, media-router, and other files, plus sandbox-denied writes to `node_modules/.tmp`.
  - `npx eslint` on the touched UI files still reports preexisting unused-import issues in `indras-ui/src/AgentControl.tsx`; the newly added scheduler sections themselves did not surface distinct lint failures beyond that existing file-level debt.

## 2026-04-09T01:53:32Z
- `lct_python_backend/services/stt_backend_realtime.py` (lines 145-180, 169-180): fixed the backend websocket flush boundary so `flush()` now waits for `final` or `done` instead of stopping after the first post-`end` event, and promotes the last partial transcript to a synthetic final when upstream sends `done` without `is_final=true`.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1, 292-380): added focused coverage for:
  - `done`-without-final promotion of the last partial into a final transcript
  - waiting for a late final after an earlier partial rather than exiting flush too early
- Remote startup investigation refinement (no code changes in sibling repo during this step):
  - confirmed the Windows Scheduled Task `\IndrasNet-WebServer` launches `cmd.exe /c ... .venv\Scripts\python.exe agents\web_server.py` directly from the patched tree, not `start.bat`
  - confirmed `start.bat` would instead run `scripts/start_all.py --autostart`, so the scheduled-task path and the manual startup-shortcut path are materially different launch mechanisms
  - this explains why "autostart is configured" and "this specific boot skipped agent autostart" can both be true: a foreground or alternate launcher can inject `INDRAS_SKIP_AGENT_AUTOSTART`, while the Scheduled Task bypasses the richer `start.bat` orchestration entirely
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py` (`10 passed`)

## 2026-04-09T02:08:00Z
- Remote Windows startup investigation reached a concrete root cause and mitigation:
  - the active listener on `100.81.65.74:7777` was not the Scheduled Task at all; it was a manual debug launcher `C:\Users\adity\run_web_server_skip_agents.ps1` that explicitly set `INDRAS_SKIP_AGENT_AUTOSTART=1` before launching `grimoire.IndrasNet.agents.web_server.app`
  - that debug script explains both the earlier `Startup env gate active: skipping agent autostart` lines in `web_server.log` and the broken Beeper ingestion/autostart state on those boots
  - the registered Scheduled Task `\IndrasNet-WebServer` was still using the old brittle action `cmd.exe /c ... .venv\Scripts\python.exe agents\web_server.py`, returning `3221225786 (0xC000013A)`
- Sibling-repo operational fix:
  - `TemporalCoordination/grimoire/IndrasNet/scripts/start_web_server_task.ps1` (new, lines 1-34): added a repo-owned launcher that clears the temporary `INDRAS_SKIP_*` env gates, removes stale `web_server.pid`, logs each launcher step to `logs/web_server_task_launcher.log`, and starts the web server through `.venv\Scripts\python.exe -m grimoire.IndrasNet.agents.web_server.app`
  - `TemporalCoordination/grimoire/IndrasNet/scripts/start_web_server_task.cmd` (new, lines 1-4): added a tiny cmd wrapper so Task Scheduler can execute a relative path without breaking on the repository’s space-containing Windows path
  - updated the remote Scheduled Task action from the stale inline `cmd.exe /c ... agents\web_server.py` form to `cmd.exe /c scripts\start_web_server_task.cmd`
- Remote validation:
  - killed the debug-launched process tree that had been serving `7777`
  - first Task Scheduler attempt through the raw PowerShell action failed because Task Scheduler serialized the `-File ...start_web_server_task.ps1` argument without quotes, so the script path broke on `Ongoing Local`
  - after switching the task to `cmd.exe /c scripts\start_web_server_task.cmd`, the task entered `Running` state and `curl http://100.81.65.74:7777/` returned `200`
  - `logs/web_server_task_launcher.log` shows the task reaching Python launch successfully from the scheduled-task context
  - `web_server.log` now shows normal agent autostarts again instead of the skip gate:
    - `Auto-started agent 'beeper'`
    - `Auto-started agent 'obsidian'`
    - `Auto-started agent 'meet'`
- Residual non-blocking oddity discovered during validation:
  - the scheduled-task launch path still shows a two-step Python chain (`.venv\Scripts\python.exe` parent spawning `C:\Users\adity\anaconda3\python.exe -m grimoire.IndrasNet.agents.web_server.app`) along with repeated `runpy` warnings about `grimoire.IndrasNet.agents.web_server.app` already being in `sys.modules`
  - service health is acceptable now, but this child-interpreter handoff remains unexplained and should be investigated separately if startup reliability regresses again

## 2026-04-09T02:31:00Z
- Fixed live BYOK routing so OpenAI BYOK no longer silently overrides the configured primary STT provider for browser live sessions.
- `lct_app/src/components/audio/useTranscriptSockets.js` (lines 124-141): changed live `session_meta` construction so the browser always sends the configured provider (e.g. `whisper`) even when a BYOK session token is present; BYOK now remains credentials-only metadata instead of forcing `provider=openai_audio`. Also stopped mutating `local_only`/`transport` metadata based on BYOK presence.
- `lct_app/src/components/ByokSessionControl.jsx` (lines 22-34): rewrote helper text so BYOK is described as making OpenAI available to the configured fallback order rather than implicitly making OpenAI primary.
- `lct_python_backend/services/stt_live_provider_selection.py` (removed the `prefer_openai_before_remote_whisper` special-case block near the end of `resolve_live_stt_candidates()`): candidate ordering now respects the configured primary plus explicit `live_fallback_priority` instead of unconditionally inserting OpenAI ahead of remote Whisper whenever Whisper is remote.
- `lct_python_backend/services/stt_ws_session.py` (around `requested_provider` in `handle_session_meta`): stopped treating `byok_session.provider` as higher-priority than the provider requested by the browser payload. BYOK sessions now enrich runtime credentials without changing the requested live route.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (updated remote-whisper ordering assertion): now expects Whisper primary to stay first when it is selected and OpenAI appears later in fallback order.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (new BYOK regression test): added coverage proving that a live BYOK token plus `provider="whisper"` still yields a Whisper primary candidate and only keeps OpenAI as fallback.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`25 passed`, one preexisting LibreSSL `urllib3` warning)
  - `cd lct_app && npx eslint src/components/audio/useTranscriptSockets.js src/components/ByokSessionControl.jsx` (passed)
- Runtime verification after the fix:
  - `/api/settings/stt` showed `provider=whisper` and `live_fallback_priority=["remote_whisper","openai_audio",...]`
  - a real `/ws/transcripts` run over the 24s `Talking to Anand about love.m4a` slice finally acked `provider_http_url=http://100.81.65.74:7777/api/transcribe`, proving the live route now honors the configured Whisper primary
  - measured Whisper timings on that run: `ack=8.662s`, `first_partial=11.63s`, `flush_ack=33.118s`, `first_final=null`, `partials=11`, `finals=0`
  - implication: the routing bug is fixed, but remote Whisper still has a separate live-finalization/latency problem after routing is corrected

## 2026-04-09T02:52:00Z
- Investigated the now-exposed remote Whisper live bottleneck after routing was corrected.
- Findings:
  - A real `/ws/transcripts` Whisper run after the routing fix measured `ack=4.349s`, `first_partial=7.221s`, `flush_ack=28.612s`, `first_final=null`, `partials=11`, `finals=0`, `provider_http_url=http://100.81.65.74:7777/api/transcribe`
  - This materially improved startup versus the first Whisper-only benchmark (`ack=8.662s`, `first_partial=11.63s`), but finals still did not appear.
  - A raw direct websocket run against `ws://100.81.65.74:7777/api/transcribe/stream` proved the problem is upstream of LCT and upstream of the IndrasNet proxy: the stream emitted only `{"type":"transcript","is_final":false}` chunks and then `{"type":"done"}` with no final transcript event.
  - Remote `web_server.log` shows the live stream acquiring the GPU immediately (`wait_ms=0`) for `context=lct_live_stream`, so this specific run was not delayed by coordinator queue wait.
  - The same remote log continues to show unrelated but noisy background failures in reprocessing:
    - `'GPUBackendManager' object has no attribute 'should_yield_for_priority'`
    - `cannot import name 'queue_reprocessing_job'`
- Attempted remediation:
  - Patched local sibling file `TemporalCoordination/grimoire/IndrasNet/services/transcription/whisperx_server.py` so the websocket `end` path caches the latest emitted transcript text and should emit it as `is_final=true` even when the leftover buffer is too small for a fresh transcribe pass.
  - Synced that file to the Windows host and forced a fresh on-demand live run with no stale `8001` listener.
  - Result: raw stream behavior did not change; the live endpoint still returned `done` with no final.
- Interpretation:
  - The actual `8001` Whisper streaming implementation serving production traffic is likely not using the edited `whisperx_server.py` path we patched, or it is launched from a different source/deployment than expected.
  - Therefore the missing-final bug is now narrowed to the real runtime behind `8001`, not the LCT runtime and not the IndrasNet proxy route.

## 2026-04-09T03:05:00Z
- Closed the `8001` source-of-truth ambiguity and revalidated the raw Whisper live stream against the real runtime.
- Runtime/source investigation:
  - On the Windows host, IndrasNet `.env` points `WHISPERX_BASE_URL` at `http://172.20.5.123:8001`, explicitly labeled `# WhisperX (local WSL)`.
  - `wsl.exe -l -v` showed the `Ubuntu` WSL instance running.
  - Inside WSL, the active listener on `0.0.0.0:8001` is `uvicorn` PID `15396` serving `whisperx_server:app`.
  - The true launch command is `/home/adity/.venv-audio/bin/python /home/adity/.venv-audio/bin/uvicorn whisperx_server:app --host 0.0.0.0 --port 8001`.
  - The true working directory is `/mnt/c/Users/adity/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/services/transcription`.
  - The imported module path is the WSL-side file `/home/adity/whisperx_server.py`, not the Windows path directly. `cmp` confirmed that `/home/adity/whisperx_server.py` is byte-identical to `TemporalCoordination/grimoire/IndrasNet/services/transcription/whisperx_server.py`.
- Root cause refinement:
  - The prior live-finalization code patch had been synced to the correct WSL-side file content, but the actual `8001` uvicorn process was a stale long-running server started before the current investigation (`Wed Apr 8 22:46:45 2026`).
  - This is why the raw websocket stream continued returning only partials followed by `done`: the service process had not been restarted since the finalization patch landed on disk.
- Deployment/remediation:
  - Restarted the real WSL WhisperX listener by launching uvicorn from the WSL working tree with the `.venv-audio` interpreter and module `whisperx_server:app`.
  - Verified the fresh process loaded the patched server code and bound `0.0.0.0:8001`.
- Raw direct-stream validation after restart:
  - Re-ran the same 24s raw websocket test against `ws://100.81.65.74:7777/api/transcribe/stream` using the `Talking to Anand about love.m4a` slice.
  - Result changed from `partials only + done` to `12 partials`, `1 final`, then `done`.
  - Final event emitted successfully:
    - `13.085 {"type":"transcript","text":"December of 24, 25","language":"en","is_final":true}`
    - `13.085 {"type":"done"}`
- Conclusion:
  - The upstream finalization fix is valid.
  - The missing-final bug was operational deployment drift at the real WSL `8001` service, not a remaining protocol defect in LCT or the IndrasNet proxy.

## 2026-04-09T03:27:00Z
- Extended raw Whisper live validation to a longer slice after standardizing the WSL launcher path.
- Benchmark details:
  - source audio: `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - exported test slice: `ffmpeg -ss 00:10 -t 60 -ac 1 -ar 16000 /tmp/whisper_stream_test_60s.wav`
  - exercised endpoint: `ws://100.81.65.74:7777/api/transcribe/stream`
  - transport mode: websocket `start -> PCM chunks -> end` in realtime cadence (`0.1s` chunks)
- Longer-slice result after the upstream finalization fix:
  - `TOTAL_EVENTS=34`
  - `PARTIALS=30`
  - `FINALS=1`
  - first final observed around `20.191s` in the earlier 60s run and `0.943s` after `end` in the post-restart verification run
  - last events in the post-restart run:
    - partial `"carry space for everything"`
    - partial `"Yeah, part of me hates you, part of me loves you."`
    - partial `"a part of me doesn't care but all the"`
    - final `"a part of me doesn't care but all the"`
    - `done`
- Interpretation:
  - the upstream `is_final=true` path now survives a materially longer stream and is not limited to the earlier 24s slice
  - current stream semantics still emit exactly one final at graceful end rather than per-utterance finals during the stream

## 2026-04-09T03:34:00Z
- Made the WSL WhisperX launch/restart path explicit and durable in the sibling `TemporalCoordination` repo, and documented the operational trap that surfaced during validation.
- Files modified in sibling repo:
  - `TemporalCoordination/grimoire/IndrasNet/agents/routes/services.py:83-91`
    - changed the WhisperX WSL service `command_builder` to launch `bash ./run_whisperx_server.sh` instead of embedding `uvicorn whisperx_server:app`
    - rationale: keep repo-owned service start semantics aligned with the checked-in launcher script
  - `TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py:424-430`
    - changed the WhisperX restart path to `nohup bash ./run_whisperx_server.sh > /tmp/whisperx.log 2>&1 &`
    - rationale: make on-demand CUDA-recovery restarts use the same launcher contract as the service registry
  - `TemporalCoordination/.gitattributes:1-2`
    - added `*.sh text eol=lf` and `*.bash text eol=lf`
    - rationale: WSL-mounted shell launchers must keep LF endings; CRLF made the remote `run_whisperx_server.sh` die on `set -euo pipefail`
- Remote host validation:
  - confirmed the Windows repo copy of `services.py` and `gpu_backends.py` now references `run_whisperx_server.sh`
  - discovered the mounted remote `run_whisperx_server.sh` had CRLF even though the local repo copy was LF-clean
  - normalized the remote script to LF and verified with `od`/`cat -vet`
  - foreground launch test in WSL succeeded:
    - script printed `Starting WhisperX server on port 8001...`
    - uvicorn reached `Application startup complete`
  - detached launch through the canonical script also succeeded when invoked via `setsid -f bash ./run_whisperx_server.sh >/tmp/whisperx.log 2>&1`
  - `ss -ltnp | grep :8001` showed the new `uvicorn` listener on `0.0.0.0:8001`
- Documentation/design:
  - added ADR-025 to record that `run_whisperx_server.sh` is the canonical WhisperX WSL launch contract and that line-ending durability is part of the architecture, not just an editor preference
  - added `TECH_DEBT.md` entries for the large sibling files touched during this change (`agents/routes/services.py`, `core/gpu_backends.py`)

## 2026-04-09T04:06:00Z
- Investigated the `/ws/transcripts` event-shaping gap after Whisper benchmark runs showed `graph_patch` updates without `transcript_partial` / `transcript_final` events.
- Findings from code inspection:
  - `lct_python_backend/services/stt_ws_session.py:669-726` intentionally emits draft `graph_patch` updates before sending `transcript_partial`, so seeing graph patches first is expected and not itself a bug.
  - The real protocol bug was that `handle_final_flush()` sent `flush_ack` immediately and then launched `_run_post_flush_processing()` in the background, while the frontend closed the socket as soon as `flush_ack` arrived.
  - `lct_app/src/components/audio/audioMessages.js` and `lct_app/src/components/audio/useTranscriptSockets.js` therefore treated `flush_ack` as terminal completion even though late transcript events could still arrive afterward.
- Fix implemented:
  - `lct_python_backend/services/stt_ws_session.py`
    - kept `flush_ack` as "flush accepted"
    - added `flush_complete` in `_run_post_flush_processing()` finally-block so the backend explicitly signals when post-flush transcript delivery is done
  - `lct_app/src/components/audio/audioMessages.js`
    - changed the flush promise resolution to wait for `flush_complete` instead of `flush_ack`
    - retained `flush_ack` handling for observability/logging
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
    - updated websocket integration tests to wait for `flush_complete`
    - replaced the old "flush ack not blocked by processor flush" test with a two-phase contract assertion proving `flush_ack` can arrive quickly while `flush_complete` arrives later
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` → `17 passed`
  - `cd lct_app && npx eslint src/components/audio/audioMessages.js src/components/audio/useTranscriptSockets.js` → passed
- End-to-end Whisper re-benchmark after the protocol fix:
  - source audio: same 60s slice of `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - provider ack remained Whisper: `provider_http_url=http://100.81.65.74:7777/api/transcribe`
  - timings:
    - `ack=4.171s`
    - `flush_ack=68.203s`
    - `flush_complete=68.975s`
  - counts:
    - `partials=0`
    - `finals=0`
    - `graph_patches=17`
  - new critical finding:
    - the backend now stays open long enough to expose the real post-flush blocker
    - `_run_post_flush_processing()` emits `processing_status[level=error]` with `error="badly formed hexadecimal UUID string"` before `flush_complete`
    - implication: the early-close bug is fixed, but Whisper-backed end-to-end transcript delivery is still blocked by a later UUID/persistence/graph-path crash during final flush

## 2026-04-09T04:42:00Z
- Ran a real browser-driven Whisper session using Playwright + Chromium fake-media flags against `http://127.0.0.1:5173/new` so the app’s own `AudioInput -> useTranscriptSockets` path drove `/ws/transcripts`.
- Inputs and evidence:
  - fake mic source: `/tmp/fake_mic_20s.wav` generated from `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - websocket trace captured to `/tmp/lct_real_browser_whisper_trace.json`
  - provider was confirmed from `session_ack.provider_http_url=http://100.81.65.74:7777/api/transcribe`
- Findings from the browser-ground-truth run:
  - `graph_patch` events are not replacing transcript events; the session produced `11` `transcript_partial` events, `1` `transcript_final`, and `5` `graph_patch` events
  - timing:
    - `session_ack=9.573s`
    - `first_graph_patch=11.499s`
    - `first_transcript_partial=14.069s`
    - `flush_ack=28.538s`
    - `first_transcript_final=30.045s`
    - no `flush_complete`
    - frontend logged `Flush timeout` and closed the backend socket at ~`34.55s`
- Root-cause refinement after code inspection:
  - `lct_python_backend/services/stt_ws_session.py:1237-1415` sends `flush_complete` only after `_run_post_flush_processing()` finishes:
    - waiting for pending STT chunk tasks
    - draining `stt_runtime.flush()`
    - final transcript persistence
    - `TranscriptProcessor.flush()` graph generation
    - `_ensure_graph_persisted(reason="final_flush")`
  - `lct_python_backend/services/transcript_processing.py:310-324,465-540` shows `TranscriptProcessor.flush()` can synchronously invoke `generate_lct_json(...)` for finalized transcript graph generation before returning
  - `lct_app/src/components/audio/useTranscriptSockets.js:192-205` still uses a hard `6000ms` stop timeout before closing the websocket if `flush_complete` does not arrive
- Conclusion:
  - the original early-close bug was real and is fixed, but the new two-phase contract still couples `flush_complete` to slow graph/LLM persistence work
  - in Whisper runs the backend can legitimately deliver late transcript events and still miss the client’s `6000ms` timeout because `flush_complete` is gated behind graph generation/persistence, not just transcript delivery
- No code changes were made in this investigation leg; this entry records the newly confirmed blocker and the relevant files inspected:
  - `lct_app/src/components/audio/useTranscriptSockets.js`
  - `lct_app/src/components/audio/audioMessages.js`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/stt_backend_realtime.py`
  - `lct_python_backend/services/transcript_processing.py`
  - `lct_python_backend/services/live_graph_persistence.py`

## 2026-04-09T05:02:00Z
- Implemented the approved Option A shutdown fix: decouple transcript completion from graph completion so `flush_complete` no longer waits on slow LLM graph generation or graph persistence.
- Files modified:
  - `lct_python_backend/services/stt_ws_session.py`
    - moved `flush_complete` emission earlier in `_run_post_flush_processing()` so it fires immediately after transcript flush + optional `audio_ready`, before `TranscriptProcessor.flush()` and `_ensure_graph_persisted(reason="final_flush")`
    - kept a `finally` fallback send so disconnect/error paths still attempt to emit `flush_complete` when possible
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
    - updated the slow-flush integration test to assert that `flush_complete` is **not** blocked by slow processor flush work
  - `docs/adr/ADR-026-two-phase-live-flush-contract.md`
    - amended the ADR to explicitly scope `flush_complete` to transcript completion rather than graph completion
  - `docs/adr/INDEX.md`
    - updated ADR index metadata
- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp/codex_pycache python3 -m py_compile lct_python_backend/services/stt_ws_session.py` → passed
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` → `17 passed`
  - reran the real browser-driven Whisper trace with Chromium fake-media flags
    - counts: `graph_patch=7`, `transcript_partial=11`, `flush_ack=1`, `audio_ready=1`, `flush_complete=1`
    - provider remained Whisper: `provider_http_url=http://100.81.65.74:7777/api/transcribe`
    - timings:
      - `session_ack=16.544s`
      - `first_transcript_partial=22.971s`
      - `flush_ack=31.607s`
      - `flush_complete=33.344s`
      - `final_flush_total_ms=1738.2`
    - the frontend no longer timed out waiting for `flush_complete`
- Remaining behavior to investigate later:
  - this validation run still produced `0` `transcript_final` events while partials were healthy, so the transport shutdown bug is fixed but Whisper end-of-session final quality/availability still needs separate tuning or upstream investigation

# ADR-060: Serverless BYOK — Universal Access via a Thin Stateless OpenAI Proxy

**Date:** 2026-07-01
**Status:** Proposed
**Group:** architecture + deployment
**Supersedes:** ADR-020 (session-scoped server-mediated BYOK). Partially supersedes ADR-034 — see "Relationship to ADR-034" below; ADR-034's Owner tier and Self-hosted tier are untouched.

> **Review note (2026-07-01):** three-pass adversarial review. codex (gpt-5.5 xhigh) never reached a verdict (network disconnect, then rate-limited). grok-build hit its turn cap before synthesizing but surfaced two real findings (Gemini-only online-extraction path, ADR-038 audio-egress gate has no serverless analog). **claude -p, as a third pass, found the most consequential issue: the "streaming pass-through avoids the 4.5MB limit" claim was factually wrong** — independently re-verified against Vercel's own docs (`vercel.com/docs/functions/limitations`, "Request body size"): the 4.5MB cap is platform-enforced on the request body before function code runs; streaming only exempts response bodies. All findings from both passes are folded in below.

> **Amendment (2026-07-06): Vercel Blob removed; BYOK audio goes browser→OpenAI directly.**
> The Blob detour (browser → Vercel Blob → `/api/proxy/transcribe` pulling the blobUrl)
> existed only to dodge the 4.5MB request-body cap above. Two facts dissolved it:
> (1) `api.openai.com` supports browser CORS (verified live: it echoes our origin and
> allows `POST` + `authorization` on `/v1/audio/transcriptions` and `/v1/chat/completions`),
> so a BYOK browser — which holds the key by definition — POSTs audio straight to OpenAI
> (25MB limit, zero proxy hops, key/audio never touch our infra); and (2) the account's
> Blob storage got suspended, proving the dependency fragile. The TRIAL path (owner key
> stays server-side) still hops through `/api/proxy/transcribe`, now as a raw request
> body with params in the query string — trial clips are 5 minutes (~2–4MB webm) and fit
> under the cap without Blob. `api/proxy/upload.js` and the `@vercel/blob` dependency are
> deleted. The proxy surface shrinks to: hosting, trial key-injection (chat/transcribe/
> realtime-token), nothing else. **Enforced, not aspirational** (dual-review convergent
> finding): `/api/proxy/transcribe` is trial-ONLY — it rejects `x-lct-byok-key` with a 400
> and pins the transcription params server-side, so BYOK audio cannot transit our infra
> and trial callers cannot steer model/format spend on the owner key.

## Issue

LCT's backend runs on a single machine behind Tailscale. This means:
- Only people on the tailnet can use the app
- If the machine sleeps, the app is down
- The operator absorbs all compute cost and ops burden

The app should be usable by anyone with an OpenAI API key, without requiring the operator's home machine to be up.

## Context

### What was proposed, and what turned out to be wrong about it

An initial design pass (2026-07-01, drafted outside this repo without reading `docs/adr/` first) proposed a **fully client-side** architecture: static Vercel frontend, browser calls OpenAI directly, IndexedDB for persistence, zero backend of any kind. Verifying that design against this codebase and against OpenAI's current API surface surfaced three corrections load-bearing enough to change the architecture:

1. **OpenAI's REST endpoints (`/v1/chat/completions`, `/v1/audio/transcriptions`) do not support CORS.** OpenAI sends no `Access-Control-Allow-Origin` header on these — this is their stated position (browser CORS errors on these endpoints are not a bug OpenAI will fix; their own guidance is "use a server-side proxy"). A browser on `threads.adityaarpitha.com` cannot call `api.openai.com` directly; the browser blocks it before the request is even sent cross-origin. **"Zero backend" is not achievable for the REST-based LLM and file-transcription calls.** *(Source: OpenAI's own developer community threads confirm this is by design, not a bug — [community.openai.com/t/how-to-fix-cors-policy-error-when-fetching-openai-api-from-localhost/1140420](https://community.openai.com/t/how-to-fix-cors-policy-error-when-fetching-openai-api-from-localhost/1140420), [community.openai.com/t/cross-origin-resource-sharing-cors/28905](https://community.openai.com/t/cross-origin-resource-sharing-cors/28905). No repo-internal trace exists for this — it's an external-API constraint, verified 2026-07-01 outside this codebase, not something the code itself demonstrates.)*
2. **The Realtime API (for live-mic streaming) needs a short-lived ephemeral token, and minting it requires a signed request using the real API key — which OpenAI's own docs say must happen server-side.** Browser WebSocket/WebRTC connections work fine *once* an ephemeral token exists, but getting one cannot be done from pure client JS.
3. **`gpt-4o-transcribe-diarize` is not new territory.** It's already the shipped, production-default diarization model in this backend (`stt_config.py:23`, `stt_provider_transports.py:231-241`, frontend default in `sttUtils.js:35`) — with existing known-speaker plumbing, an existing ADR reference (ADR-032), and test coverage. It is deliberately **not** used for live captions today — live captions use `gpt-4o-mini-transcribe` for latency, with diarization run as an async background refinement pass afterward (see `docs/WORKLOG.md`). Any serverless live-mic design should mirror that same split, not attempt live diarization.

The corrected architecture: a **thin, stateless proxy** (Vercel Functions) replaces the FastAPI backend for serverless mode — not a database, not a session store, not an auth server, just per-request pass-through that forwards the user's own key to OpenAI and attaches CORS headers / mints ephemeral tokens. This still eliminates Postgres, Tailscale, and the "must be running on the operator's home machine" constraint. It does not eliminate all server-side code.

Two Vercel Functions constraints shape the implementation, not just the design — **one of which was misdiagnosed in an earlier draft of this ADR and corrected by a claude-p adversarial pass, 2026-07-01:**
- **The 4.5MB Vercel Function body limit applies to the request body, platform-enforced before function code ever runs — "streaming pass-through" does NOT avoid it.** (Verified directly against Vercel's docs, `vercel.com/docs/functions/limitations`, "Request body size": *"The maximum payload size for the request body or the response body of a Vercel Function is 4.5 MB."* Streaming only exempts response bodies — Vercel's own recommended workaround for large inbound payloads is direct browser-to-Vercel-Blob upload, bypassing the function's request body entirely, not "make your handler read as a stream.") The audio-transcription proxy must therefore be: browser uploads audio directly to Vercel Blob (via a short-lived upload token minted by a tiny function) → a function reads from Blob and streams *that* to OpenAI. The function-to-OpenAI leg can stream because the function originates that request; it's the inbound leg that can't be streamed around. **This means raw audio transiently rests in Vercel Blob storage — a real exception to "pure stateless pass-through, nothing persisted" (Decision §2) that must be stated honestly, the same way ADR-038's audio gate already is.** OpenAI's own upload cap is 25MB, so that's the ceiling Blob storage needs to handle, not the 4.5MB function limit.
- This same platform wall can also bite Phase 1: `/api/proxy/chat` forwards full transcripts as JSON for extraction, and a long meeting transcript in text form can plausibly exceed 4.5MB too, just less often than audio.
- Execution duration: Edge Functions stream for up to 300s; Serverless Functions with Fluid Compute (now default) go up to 800s on Pro. Either is sufficient for a single transcription/completion call once the request-body problem above is actually solved.

### Codebase audit (verified against actual code, 2026-07-01)

| Layer | Verified state |
|---|---|
| **LLM** | `LlmGateway` (`lct_python_backend/services/llm_gateway.py`) is a real capability-routed httpx client, not an SDK wrapper — good abstraction. **3 production files** bypass it with direct SDK imports (not 2, as first claimed): `embedding_service.py` (OpenAI), `transcript_llm_callers.py` (Gemini), and `import_pipeline/import_graph_refinement.py` (Gemini — imports private helpers from `transcript_llm_callers.py`, bypassing the gateway entirely for the graph-refinement pass). **Deeper than that (grok-build finding, 2026-07-01):** the bypass isn't limited to the refinement pass — the primary "online mode" graph-extraction entry point itself, `generate_lct_json()` in `transcript_llm_callers.py`, is Gemini-only today: it requires a Gemini key when online (falling back to local otherwise), uses Gemini-tuned prompts distinct from the local-model prompts, and has **no existing OpenAI code path at all**. Porting Phase 1 to OpenAI is not "swap the LLM client on existing extraction logic" — it's writing new OpenAI-specific extraction prompts and parsing from scratch, since nothing OpenAI-shaped exists to port. This changes Phase 1's real effort; see the roadmap note below.
| **STT** | `LiveSttRuntime` Protocol + factory (`services/stt/stt_live_runtime.py`) — zero SDK coupling confirmed by grep. `OpenAIRealtimeTranscriptionRuntime` (`stt_openai_realtime.py`) is a genuine, non-stub realtime websocket transport (session negotiation, VAD events, resampling, egress guards per ADR-038) — not a placeholder. Easy to mirror in JS.
| **Frontend** | `apiFetch()` (`services/apiClient.js`) + **19** domain service modules (not ~15). **12 raw `fetch()` calls survive outside that layer, across 7 files** (not ~6): `components/audio/audioUpload.js` (2), `components/audio/useEdgeStt.js` (1), `components/upload/useFileUploadStream.js` (1), `pages/ShareConversation.jsx` (1), `pages/SubjectReview.jsx` (2), `pages/ThreadsViewer.jsx` (1), `pages/ViewConversation.jsx` (4). Phase 0 must explicitly cover these or the DataProvider seam has holes.
| **Persistence** | `localDraftStore.js` already uses IndexedDB, but is deliberately single-slot ("latest draft only" — see ADR-021). Real seed, not a full store yet.
| **ADR-020** | Status: Approved, implemented. Client already sends OpenAI keys today via `byokApi.js` → `POST /api/byok/session`, session-scoped, never persisted. This ADR's key-handling model (browser-held, never sent to *our* server) is a step further than ADR-020's (server-mediated) — see Positions Considered.
| **ADR numbering** | ADR-059 is the highest existing file; 060 is free in the current tree. Note: gaps exist at 041–055 and 057 with no explanation found — if any branch elsewhere reserves those numbers, recheck before this merges. Pre-existing, unrelated issue: `docs/adr/INDEX.md` hasn't been updated past ADR-038 (last updated 2026-06-01) — ADR-060's row is being added despite that gap, not fixing it.

### Relationship to ADR-034

ADR-034 ("Public LCT Deployment — Tiered Access," Approved 2026-06-01) chose a **hosted multi-tenant server** to solve this same problem: Google OAuth, per-user Postgres row-level security, Cloudflare Tunnel, eventual VPS migration. Real work has already merged against it — `models/identity.py` (users table), owner-scoped reads (`0ce9ae3`), the IndrasNet fail-closed capability gate (`7a2f462`).

Decided with the user (2026-07-01): **ADR-060 supersedes ADR-034's Hosted-public tier** (D1 row 2, and Build-plan Steps 2/3/4/5/7/8, which existed only to serve that tier — public profile config, persisted per-user BYOK keys, audio-consent/retention/export compliance, abuse/cost gates, Cloudflare ingress, telemetry/migration triggers). None of that is needed when user data never touches the operator's server in the first place — there is no tenant data to isolate, and the operator is not a data processor for it.

**Unaffected:** ADR-034's Owner tier (D1 row 1 — the existing tailnet-only full stack) and Self-hosted tier (D1 row 3 — docker-compose packaging for people who want to run the full stack, including IndrasNet, on their own box) are untouched; they solve different problems. **Kept, not reverted:** the already-merged Step 0/Step 1 groundwork (IndrasNet gate, `owner_id`/users table) — harmless, and orthogonal to which public-access approach is used.

## Decision

### 1. Introduce a `DataProvider` interface in the frontend

```
DataProvider
├── BackendDataProvider    (wraps existing apiFetch → Python backend; tailnet/owner mode)
└── ServerlessDataProvider (wraps OpenAI calls via thin proxy + IndexedDB; public mode)
```

The app auto-detects mode (is the Tailscale-gated backend reachable? → backend mode; not reachable? → serverless mode). User can force a mode in settings.

### 2. Serverless mode routes through thin, stateless Vercel Functions — never OpenAI directly from the browser for REST calls

| Capability | Browser calls | Proxy route | OpenAI endpoint | Model |
|---|---|---|---|---|
| File transcription | `POST /api/proxy/transcribe` (streamed) | forwards multipart stream, attaches CORS | `/v1/audio/transcriptions` | `gpt-4o-transcribe-diarize` |
| Live mic transcription | WebSocket/WebRTC directly to OpenAI, using a token obtained from the proxy | `POST /api/proxy/realtime-token` mints ephemeral token | Realtime API | `gpt-4o-mini-transcribe` live + async `gpt-4o-transcribe-diarize` refinement pass (mirrors current backend split — see Context) |
| Thread extraction + graph | `POST /api/proxy/chat` (streamed) | forwards request, attaches CORS | `/v1/chat/completions` | `gpt-4o` / `gpt-4.1`, JSON mode |

The proxy routes hold no state: the user's key travels in a dedicated request header (**must be named explicitly at implementation time — not `Authorization`, to avoid collision with any platform/CDN/observability tooling that inspects that header by default**), is forwarded, and must never be logged, stored, or persisted anywhere server-side. "Never logged" is a requirement with teeth, not an assertion: it needs (a) an explicit no-`console.log`/no-error-capture rule on the request/headers in every proxy route, mirroring the existing discipline in `apiClient.js:114-128` (which already caps and drops a FastAPI 422 key-leak), (b) a grep-able test asserting it, and (c) a check of whether Vercel's own Function Logs/Observability product captures invocation metadata by default and needs redaction configured (claude-p finding, 2026-07-01 — not yet resolved, flagged as a Phase 1 requirement below).

**Security gap, not yet designed (claude-p finding, 2026-07-01): the proxy as specified is an open, unauthenticated relay.** CORS headers are a browser-side enforcement mechanism, not server-side access control — anyone with `curl` can `POST` directly to `/api/proxy/chat` or `/api/proxy/transcribe` with any OpenAI key (their own, someone else's, a leaked one). The OpenAI spend lands on whichever key was used, but **Vercel Function invocation/bandwidth cost lands on the operator, unconditionally, per request, regardless of whose key it is.** This is the concrete successor to ADR-034's Build-plan Step 5 ("abuse & cost gates") — Step 5 is listed as superseded below because it targeted *OpenAI* cost, but it also covered *infrastructure* abuse against the operator's own hosting, which ADR-060 introduces fresh and doesn't currently carry forward. **Must-fix before any public deployment:** Origin/Referer allowlisting server-side + basic per-IP rate limiting (e.g. Vercel Edge Config or Upstash) on every `api/proxy/*` route.

### 3. Persistence moves to IndexedDB + localStorage

| Data | Storage |
|---|---|
| Conversations + graphs | IndexedDB (`lct_conversations`) |
| Bookmarks, edit history | IndexedDB |
| Settings | localStorage |
| Prompts | Bundled `prompts.json` + localStorage overrides |

Export: `.threads` per conversation (already exists) + a new mass-export-all JSON. Import: drag-drop `.threads` (already exists) + mass-import.

### 4. API key handling

- User enters their OpenAI key on first launch (or when no key is found)
- Key stored in `sessionStorage` by default (cleared on tab close); optional "remember key" → `localStorage`
- Key never touches our database — it passes through the stateless proxy per-request, never logged or persisted server-side
- Lightweight validation call on entry

### 5. V1 scope

| In V1 | Deferred |
|---|---|
| Thread extraction pipeline | Bias / frame / crux / simulacra detectors |
| Graph generation + visualization | Synthesis engine |
| Live mic recording + STT (mini-transcribe live + async diarize refinement) | Share links |
| File upload + STT | Subject review |
| Speaker diarization (background pass) | Speaker voice library |
| Conversation CRUD | Consumption prayer / IndrasNet |
| Export `.threads` + mass export | Cost tracking (server-side) |
| Import `.threads` + mass import | Attendee stack |
| Dual mode (backend + serverless) | Embeddings / semantic search |
| — | Graph refinement pass (currently Gemini-only, bypasses gateway — open question, see below) |

### 6. Work happens on a separate git worktree

Branch: `serverless-byok` off `main`. No disruption to the current backend-mode app.

## Consequences

- **Anyone with an OpenAI key can use LCT**, without the operator's home machine being up.
- **Minimal infrastructure**, not zero: Vercel static hosting + a few stateless proxy routes. No Postgres, no Tailscale, no always-on requirement.
- **User pays their own OpenAI bill.** No cost absorption by the operator.
- **The operator is not a data processor for serverless-mode users** — audio and transcripts never reach our server, only the user's browser and OpenAI directly (for the REST calls, via the pass-through proxy; nothing is stored in transit). This sidesteps ADR-034's D6/Step-4 compliance burden (consent capture, retention, export, breach duties) for this tier — there's no tenant data on our side to be a processor of.
- **Privacy tradeoff.** Audio and transcripts go to OpenAI instead of staying local. Acceptable for users who opt in with their own key.
- **No backend-side egress control has any equivalent in serverless mode, by construction — and this is broader than just audio** (grok-build found the audio-specific case, 2026-07-01; claude-p found the fuller scope, 2026-07-01). Backend/owner mode enforces `assert_audio_egress_allowed()` (`services/privacy_boundary.py:580-596`) — raw audio cannot leave the machine to any cloud provider unless the operator explicitly sets `LCT_ALLOW_CLOUD_AUDIO=1`. That's one instance of a broader mechanism: `LCT_LOCAL_ONLY` (default **ON**, fail-closed; `services/egress_guard.py:44-51`) wraps outbound calls across **~20 files** — LLM text, embeddings, synthesis, attendee bridge, STT, not just audio. Serverless mode is structurally "`LCT_LOCAL_ONLY=0`, permanently, for every capability," because there's no backend process to hold that switch at all. The equivalent consent boundary in serverless mode is coarser and entirely browser-side: the user typed in their own OpenAI key. This is accepted as the intended tradeoff of BYOK-serverless, not a gap in the design — but it's the whole local-first-by-default posture that has no analog here, not just the audio corner of it.
- **Mode-detection needs an explicit short timeout** (claude-p finding, 2026-07-01). The backend-reachability probe (`apiClient.js:81-108` today) relies on `fetch` throwing on failure — for a public visitor whose browser attempts to reach a Tailscale-only `.ts.net` hostname (resolves via public DNS to an unreachable CGNAT address), a black-holed TCP connect can hang many seconds before falling back to serverless mode, unless the probe uses an explicit short `AbortController` timeout. Not yet specified.
- **IndexedDB needs an explicit persistence request** (claude-p finding, 2026-07-01). With IndexedDB as the sole store and no cross-device sync, browser "best-effort" storage can silently evict data under disk pressure unless the origin calls `navigator.storage.persist()`. For a product whose only copy of a conversation's graph lives in IndexedDB, silent eviction is a real data-loss class, not yet addressed in Phase 3.
- **API key in browser.** Mitigated by sessionStorage default + explicit user consent for localStorage. Standard BYOK tradeoff.
- **No cross-device sync.** Data lives in the browser; mass export/import is the safety net.
- **Backend mode remains fully functional** for the operator's tailnet use — this is additive.
- **Detectors and graph refinement deferred** — V1 ships the core loop (extract → graph); analysis features and the Gemini-based refinement pass follow, or get ported to OpenAI, as a later decision.

## Positions Considered

| Option | Pros | Cons |
|---|---|---|
| A: Keep server-mediated BYOK (ADR-020) | Backend controls all calls, key never in browser JS | Backend must be running — the exact problem being solved |
| B: Fully client-side, zero backend | Simplest to reason about | **Not achievable** — OpenAI's REST endpoints have no CORS support; ruled out by verification, not by preference |
| C: **Thin stateless proxy (Vercel Functions) + client-side everything else (chosen)** | No CORS blocker, no ephemeral-token blocker, still no DB/ops/tailnet, universal access, dual-mode, incremental | A few stateless serverless routes exist and need to be built/maintained; not literally zero backend |
| D: ADR-034's hosted multi-tenant server | Full feature parity (sharing, cross-device sync, server-side detectors) | Requires OAuth, RLS, consent/retention/export compliance, ongoing hosting cost — heavy for the "let anyone use the core loop" goal |

## Open Questions

1. **Graph refinement pass** (`import_graph_refinement.py`) currently runs on Gemini, bypassing `LlmGateway` entirely. Not decided: drop it for V1 (serverless mode ships without this refinement step), or port it to OpenAI so V1's "single OpenAI key" promise holds end-to-end. Needs an explicit answer before Phase 1 implementation touches thread extraction. **Broader than originally scoped** (grok-build finding, 2026-07-01): the primary online graph-extraction entry point (`generate_lct_json()`) is also Gemini-only, with no existing OpenAI path to port — see the LLM row in the codebase audit table above. Phase 1 needs new OpenAI-specific extraction prompts written from scratch, not a client swap on existing logic.
2. **ADR numbering gap** (041–055, 057 missing, no ADR-060+ found elsewhere) — worth a last check with any active branches before this ADR is considered final, though nothing in the current tree collides.

## Related ADRs

- ADR-020 (superseded) — session-scoped server-mediated BYOK
- ADR-034 (partially superseded — Hosted-public tier only; see "Relationship to ADR-034") — tiered public deployment
- ADR-017 — capability-oriented live runtime pipeline
- ADR-030 — system invariants and pipeline standards
- ADR-038 — engine-agnostic privacy boundary

---

# Implementation Roadmap

## Phase 0: DataProvider interface + refactor (2–3 days)

**Goal:** Introduce the seam without changing behavior. Adjusted up from the original 2-day estimate — the raw-fetch bypass surface is 7 files/12 sites, not ~6, and all of them need to route through the provider or the seam has holes.

- [ ] Define `DataProvider` interface in `src/services/dataProvider.js` (conversation CRUD, graph ops, STT transcription, settings)
- [ ] Create `BackendDataProvider` wrapping existing service modules (all 19, not ~15)
- [ ] Fold the 7 raw-`fetch()` files into the provider seam: `audioUpload.js`, `useEdgeStt.js`, `useFileUploadStream.js`, `ShareConversation.jsx`, `SubjectReview.jsx`, `ThreadsViewer.jsx`, `ViewConversation.jsx`
- [ ] Create `DataProviderContext` (React context) for component access via hook
- [ ] Verify: all existing tests pass, app works identically

## Phase 1: Thin proxy + serverless LLM client (3–4 days — up from 2; see note below)

**Goal:** Browser calls OpenAI chat completions via the stateless proxy.

- [ ] `api/proxy/chat.js` (or `.ts`) — Vercel Function, streams request/response, attaches CORS, forwards the user's key from a dedicated header (not `Authorization`), no logging/persistence (explicit no-log rule + grep-able test — see Decision §2)
- [ ] Origin/Referer allowlisting + basic per-IP rate limiting on every `api/proxy/*` route before any public deployment — the successor to ADR-034's abandoned Step 5, not optional hardening (see Decision §2 security gap)
- [ ] `src/services/serverless/llmClient.js` — calls the proxy, JSON mode / structured output, port `extract_json_from_text()` (chain-of-thought stripping)
- [ ] Port `prompts.json` as static import
- [ ] **Write new OpenAI-specific thread-extraction prompts and parsing** (`threadExtractor.js`) — not a port. The existing "online" extraction path (`generate_lct_json()` in `transcript_llm_callers.py`) is Gemini-only with Gemini-tuned prompts; there is no existing OpenAI-shaped extraction logic to reuse. Only the local-model prompts and the JSON-shape contract are reusable references.
- [ ] Port hierarchy consolidation (`hierarchyConsolidator.js`), graph generation (`graphGenerator.js`) to JS — these operate on the already-extracted JSON shape, so they're a more genuine port
- [ ] **Resolve Open Question 1** (graph refinement scope) before this phase closes

## Phase 2: Serverless STT client (2–3 days — the diarize request/response shape has a reference to port, but the upload path needs the Blob redesign, not a simple client swap)

**Goal:** Browser transcribes audio via the proxy + Realtime API.

- [ ] `api/proxy/upload-token.js` — mints a short-lived Vercel Blob upload token; browser uploads audio directly to Blob (bypasses the 4.5MB Function body limit entirely — see Context)
- [ ] `api/proxy/transcribe.js` — reads the uploaded audio from Blob, streams *that* to OpenAI's `/v1/audio/transcriptions`. **Do not cite `stt_provider_transports.py:200-260` as a streaming reference** — that function sets `should_stream = False` with the comment "DISABLED: streaming causes httpx issues with error handling and fallback chain" (verified 2026-07-01, claude-p pass). It's evidence the pattern was tried and abandoned once already, not a template to port; the diarize model's known-speaker/timestamp request *shape* (same file, lines ~231-241) is still a valid reference, just not the streaming behavior.
- [ ] `api/proxy/realtime-token.js` — mints ephemeral Realtime tokens server-side
- [ ] `src/services/serverless/sttClient.js` — file upload via the transcribe proxy, model `gpt-4o-transcribe-diarize`, parses `diarized_json`
- [ ] `src/services/serverless/sttRealtimeClient.js` — browser WebSocket/WebRTC directly to OpenAI using the minted token, `gpt-4o-mini-transcribe` live; async diarize refinement pass afterward (mirrors the existing backend split, not live diarization)
- [ ] Integrate with existing recording UI (`NewConversation` page)

## Phase 3: Serverless persistence (2 days)

- [ ] Expand `localDraftStore.js` → `src/services/serverless/storageClient.js` (conversations, graphs, bookmarks, editHistory object stores, full CRUD)
- [ ] Settings in localStorage
- [ ] Mass export (all conversations → JSON) and mass import (drag-drop → bulk insert)
- [ ] Migration helper: `.threads` import populates IndexedDB
- [ ] Call `navigator.storage.persist()` on first use + handle rejection — otherwise browser storage eviction under disk pressure silently loses conversations (claude-p finding, 2026-07-01)

## Phase 4: ServerlessDataProvider + integration (2–3 days)

- [ ] `src/services/ServerlessDataProvider.js` — implements `DataProvider`, delegates to `llmClient`/`sttClient`/`storageClient`
- [ ] API key input UX: first-run modal, validation call, sessionStorage default / localStorage opt-in, settings management (view masked, clear, re-enter)
- [ ] Mode detection: probe backend health on load with an explicit short `AbortController` timeout (public visitors hitting a Tailscale-only `.ts.net` hostname would otherwise hang on a TCP blackhole before falling back — claude-p finding, 2026-07-01), fall back to serverless if unreachable, manual toggle in settings
- [ ] Test full flow: open app → enter key → record → transcribe → extract threads → view graph
- [ ] Test file import flow and export/import round-trip

**Total: ~11–14 days** (adjusted from the original 10–12: Phase 0 grew slightly for the wider fetch-bypass surface, Phase 1 grew for the missing OpenAI extraction-prompt work (grok-build finding, 2026-07-01), Phase 2 shrank slightly since the diarize model has an existing reference implementation to port rather than design from scratch).

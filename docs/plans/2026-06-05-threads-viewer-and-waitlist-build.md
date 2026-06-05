# Build Plan: `.threads` viewer + export button + waitlist (ADR-036 slices 2–3)

**Date:** 2026-06-05
**Status:** Proposed (for codex review before implementation)
**Depends on:** ADR-036 (shareable artifact wedge); `.threads` export endpoint landed (commit 39e8b76).

## Architecture recap (decided)

Static, server-free artifact. Owner exports a `.threads` file → hands it to the
participant → recipient opens the **Vercel-hosted viewer** which renders it fully
client-side. No backend at view time, no share token, no permissioning
(possession of the file = capability; participant/T0/full per ADR-036 D3).
Waitlist is decoupled onto a Vercel serverless function + store.

Verified preconditions:
- `MinimalGraph` is prop-driven (`graphData`/`chunkDict`), no fetches.
- The only view-path server call is `NodeDetail` fact-check (`NodeDetail.jsx:285`),
  gated on `conversationId` and graceful on failure → pass **no `conversationId`**
  in the viewer to skip it.
- `.threads` bundle (from the export endpoint) = `{format:"lct.threads",
  format_version:1, conversation_title, executive_summary, graph_data (5 tiers,
  flags, edges_out), chunk_dict}`. No audio. ~671 KB for a 41-min convo.

---

## Slice 2a — Export button (frontend)

- **Where:** `ViewConversation.jsx` (owner's view) and/or `ShareManagerModal.jsx`.
- **Action:** "Export .threads" → `apiFetch("/api/conversations/${id}/threads-export")`
  → `await resp.blob()` → trigger a client download named from the title (or the
  `Content-Disposition` filename). Uses `apiFetch` so it carries `AUTH_TOKEN`.
- **Files:** modify `ViewConversation.jsx` (button + handler); reuse `apiClient.js`.
- **Risk:** low. **Test:** click → file downloads → opens in the viewer (2b).

## Slice 2b — The viewer (`/view`)

- **New page:** `lct_app/src/pages/ThreadsViewer.jsx`.
  - Load a `.threads` via: (i) `<input type="file">`, (ii) drag-drop, (iii) optional
    `?src=<url>` to `fetch` a hosted file (e.g. Vercel Blob) — later.
  - Parse + **validate**: JSON.parse in try/catch; assert `format==="lct.threads"`
    and a supported `format_version`; show a friendly error on malformed/legacy.
  - Render the existing view in **static mode**: `MinimalGraph` + `MinimalLegend`
    + `NodeDetail` + `TimelineRibbon`, passing `graphData`/`chunkDict` from the
    file, **no `conversationId`** (skips fact-check), `readOnly`, no audio.
- **Route:** add `/view` (and `/view?src=`) in `AppRoutes.jsx`. Public route — must
  NOT require backend/auth (it's the whole point).
- **Component reuse:** Phase 1 = standalone `ThreadsViewer` importing the same child
  components as `ShareConversation` (some JSX overlap). Phase 2 (optional) = extract
  a shared `<ConversationGraphView graphData chunkDict readOnly/>` used by both.
- **Files:** create `ThreadsViewer.jsx`; modify `AppRoutes.jsx`. Possibly extract a
  shared view component (decide after first cut).
- **Risk:** medium (UI, can't fully verify without a browser). **Test:** eslint +
  `vite build`; load a real `.threads` exported from conv 45ef78b5; visual pass.

## Slice 3 — Waitlist (decoupled)

- **Serverless fn:** `lct_app/api/waitlist.js` (Vercel function) → store in Vercel
  Postgres (or KV). POST only; owner reads via a separate authed view/export.
- **Schema** `waitlist_submissions`: `email` (required), `features text[]`,
  `wtp_band text`, `note text`, `source` (which `.threads` / referrer), `consent_ts`,
  `ua_hash`, `created_at`. Abuse controls: honeypot field + simple rate-limit.
- **Frontend:** `WaitlistModal.jsx` (email + feature multi-select + WTP band +
  free-text), opened from a "Join the beta" CTA in the viewer. Feature list + price
  bands are the owner's product call (default set proposed separately).
- **Files:** create `lct_app/api/waitlist.js`, `WaitlistModal.jsx`; wire CTA into
  `ThreadsViewer.jsx`; Vercel store provisioning.
- **Risk:** medium (new infra). **Test:** submit → row lands; honeypot/rate-limit
  reject bots; no PII beyond what's submitted.

---

## Cross-cutting / invariants

- Viewer makes **zero** backend calls (verify in build: no `apiFetch`/`/api/` in
  the viewer path except the optional `?src=` file fetch).
- No audio in `.threads`; fact-check absent in static mode.
- No revocation (possession = capability) — accepted for T0/participant sharing.
- The viewer parses a user-supplied file — it's the user's own data, but parse
  defensively (size guard, schema guard) and never `eval`.

## Open decisions (for the user / codex)

1. Standalone `ThreadsViewer` vs shared `<ConversationGraphView>` refactor now.
2. Viewer entry: drag-drop + picker only, or also `?src=` hosted fetch.
3. Waitlist store: Vercel Postgres vs KV.
4. Waitlist feature list + price bands content (product call).

## Codex review (2026-06-05) — corrections folded in

- **BLOCKER (new step 0):** `App.jsx` probes `apiFetch("/api/import/health")` on load
  and renders `BetaGate` when the backend is unreachable, *before* routes mount
  (`App.jsx:23,46`). A server-free `/view` is impossible until `App.jsx` lets public
  routes render without the probe (bypass the gate for `/view`, or move the gate into
  backend-dependent route shells). **This is first.**
- **`ShareConversation` is NOT a reusable base** — it is token/OAuth/audio/server-bound
  (`ShareConversation.jsx:90,299`). Treat it as visual reference; build `ThreadsViewer`
  against the *actual* component prop contracts and (optionally) extract a shared
  graph-shell. Do NOT copy its props — it passes stale ones the components ignore
  (`visibleGraphLevel`, `allFlatNodes`, `onTraceFrom`, `readOnly`).
- **Server-free is achieved by omitting `conversationId`** — that gates off ALL the
  backend calls, not just fact-check: `MinimalGraph` prefs (`:100`), `MinimalLegend`
  speakers (`:52`), `NodeDetail` utterances/mutations (`:274,312`). `TimelineRibbon`
  is client-only. So the viewer passes no `conversationId`, no `audioUrl`,
  `speakerColorMap` to `MinimalLegend`, `onTraceAncestors` if trace is wanted.
- **`.threads` validation hardening:** pre-parse file-size cap + node/count/string-length
  caps + strict shape checks before handing graph/timeline to ReactFlow (main-thread
  freeze / memory DoS, not XSS — React escapes text).
- **Vercel functions unproven in-repo:** no `lct_app/api/` dir, no store deps,
  `vercel.json` is a SPA catch-all. `/api/waitlist` should survive the rewrite
  (filesystem checked first) if project root is `lct_app` — verify on a Vercel preview
  before building the waitlist.

## Build order (codex-revised)

0. **`App.jsx` public-route gating** — let `/view` render with the backend down. Verify off-network.
1. **`ThreadsViewer.jsx`** — standalone static page, correct prop contracts, no `conversationId`/`audioUrl`.
2. **Robust `.threads` validation** + a test fixture exported from conv 45ef78b5.
3. **Playwright network test** — load `/view`, import a `.threads`, assert **zero `/api/` requests** (objective proof of server-free).
4. **Export button** in `ViewConversation.jsx`.
5. **Waitlist** — only after confirming Vercel function routing + choosing Postgres/KV.

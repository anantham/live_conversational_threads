# ADR-034 Step 1 — Tenant Data Inventory & Per-User Isolation Plan

**Date:** 2026-06-01
**Status:** Inventory complete; implementation not started (pending owner decisions below)
**Gates:** This is the acceptance artifact ADR-034 §D6 / Build-Step-1 require before per-user isolation lands. Public ingress stays disabled until every item here is green.
**Method:** Read-only multi-agent sweep (5 inventories + completeness critic). Findings cite `file:line` against `lct_python_backend/` as of this date.

---

## TL;DR

- **Schema is in good shape.** All 27 tables either carry `owner_id` directly or reach it via a clean FK path to `conversations.owner_id`. No orphaned user-content tables.
- **The app is wide-open by access control.** ~50 read endpoints fetch tenant data by `conversation_id`/`node_id` UUID with **no owner check** — IDOR today, and still IDOR after adding columns unless the WHERE clause changes. This is fine for single-user-you; it is the core blocker for public.
- **Enforce in two layers (ADR-034 §D6):** Postgres **RLS** (DB backstop, `SET LOCAL` + `FORCE ROW LEVEL SECURITY`) **plus** an app-level owner guard at the shared fetch chokepoints.
- **Four must-fix-first hazards** (below) will turn RLS into either a data-loss event or a silent breach if not handled before enabling it.

---

## A. Tenant ownership model

- **Root:** `conversations.owner_id` (TEXT, NOT NULL, indexed) — `models/core.py:50`, initial migration `732e0cd9a870:52`. This is the RLS partition key.
- **Leaf tables inherit** via `conversation_id -> conversations.owner_id`: utterances, transcript_events, speaker_audio_references, speaker_segments, speaker_correction_events, nodes, relationships, clusters, claims, argument_trees, is_ought_conflations, simulacra_analysis, bias_analysis, frame_analysis, intent_signal_sightings, bookmarks, edits_log, thread_session_events, (nullable) api_calls_log, pipeline_artifacts.
- **Direct `owner_id`:** conversations, usage_quotas (`system.py:126`), thread_sessions (`observability.py:23`).
- **Global / not tenant-scoped (RLS-exempt):** app_settings, service_status, prompts, LLM/STT settings + providers, artifact-export settings. (Note: making *settings* per-user is a separate future concern; today they are global config.)

### Two tables that need special handling (no simple FK path)
1. **`shared_conversation_links`** — `conversation_id` is `sa.Text` with **no FK** to `conversations` (UUID), no `owner_id` (migration `share_conversation_links.py:55-68`; design comment "referential integrity at SQL level isn't load-bearing"). A plain FK-based RLS policy is impossible → needs a casted subquery policy or a `created_by_email`/owner column added.
2. **`intent_signals`** — cross-tenant *by design* (`last_sighted_conversation_id` can point across conversations; `analysis.py:261-331`). Primary owner is via `conversation_id`, but the cross-sighting field needs a deliberate policy decision.

---

## B. Read surface (IDOR inventory)

~50 GET endpoints return tenant data by UUID with **no owner filter**. Highest-leverage chokepoint: **`fetch_conversation_bundle`** (`conversations_api.py:80`, also used by `share_api.py:455`) — guard there covers `get_conversation` and the recipient path in one place. Representative offenders (all `scoped=no` today):

- `conversations_api.py`: `list_saved_conversations:38` (returns **ALL** conversations), `get_conversation:74`, `get_conversation_utterances:398`, `export_conversation_json:423` (full durable-state dump), `get_conversation_participants:618`
- `graph_api.py`: `get_graph:174`, `get_nodes:204`, `get_edges:216`
- `analysis_api.py`: simulacra/bias/frames by conversation_id **and by node_id** (`/api/nodes/{node_id}/...` — node-keyed IDOR)
- `analytics_api.py`, `thematic_api.py`, `factcheck_api.py`, `edit_history_api.py` (incl. `export_training_data:134`), `speaker_naming_api.py`, `bookmarks_api.py` (incl. `get_bookmarks:114` returns ALL bookmarks), `import_api.py` diarization-job status by job_id, `stt_api.py` session-observability by conversation_id
- **Missed by the read sweep, but live:** `canvas_api.py` graph exports by conversation_id.

### By-design cross-owner channels (must stay reachable, but gated — NOT plain RLS-blocked)
- `share_api.py:381` `fetch_share` + `:522` `fetch_share_audio` — PUBLIC (AUTH_TOKEN-exempt), opaque 32-byte token = access. `allowed_emails` is **optional** (null ⇒ public-by-link). Google-email gate exists (`_verify_google_id_token` share_api.py:156-195).
- `factcheck_api.py:160` `download_audio` — guarded by `AUDIO_DOWNLOAD_TOKEN` query param, not owner.

### Correction (shrinks scope)
- **`cost_api.py` is NOT mounted** (`backend.py` include_router list never adds it; only referenced in INSTRUMENTATION.md). Its ~12 "system-wide cost leakage" endpoints are **not live attack surface** today. Lower priority; verify before relying on this.

---

## C. Write / WS / jobs surface

- **Owner stamped at create**, but with unsafe defaults (see hazard #1): `import_api.py:203/290/329` (`owner_id` or `'anonymous'`), `stt_session.py:21` / `stt_ws_session.py:2867` (`'default_user'`/`'anonymous'`), `graph_persistence.py:294/332` (`'default_user'`).
- **Mutations by UUID with no owner check** (need RLS UPDATE/DELETE `USING`+`WITH CHECK`, not just SELECT): `DELETE /conversations/{id}` (`:182`), `PATCH .../graph` (`:243`), `speaker_naming_api.py:85` speaker-correction, `edit_history_api.py:34` node edit, `bookmarks_api.py:164/188`.
- **Missed by the write sweep, but live:** `generation_api.py:61` `POST /save_json/` writes a Conversation with **no owner stamp**.
- **Live WS:** `/ws/transcripts` (`stt_api.py:441`) — `owner_id` comes from client `payload.get('metadata')` (`stt_ws_session.py:2742`). See hazard #2.

---

## D. RLS feasibility (this codebase)

- **Engine:** `create_async_engine` (asyncpg) in `db_session.py:16-25`, default `AsyncAdaptedQueuePool` (connections reused across requests).
- **Injection point:** `get_async_session()` FastAPI dependency (`db_session.py:35-52`) — the single best place to emit `SET LOCAL app.current_owner = :owner` at the start of each request txn. Must read owner from `request.state.owner_id` (set by the auth seam).
- **Pool ⇒ must use `SET LOCAL`, never `SET`** — a non-LOCAL set persists across requests on a reused connection (cross-tenant leak). `SET LOCAL` binds to the implicit per-request txn.
- **Table-ownership trap (verify in the live DB):** if the app role `lct_user` owns the tables, RLS is silently bypassed for it unless **`FORCE ROW LEVEL SECURITY`** is set. Must check `pg_class.relrowsecurity`/`relforcerowsecurity` against the real DB before trusting any policy.
- **App role:** `lct_user` (non-superuser) per `.env`. Migrations should run as a separate role; app role must NOT have `BYPASSRLS`.
- **Background tasks gap:** `get_async_session_context()` (`db_session.py:55-64`) has no txn boundary and no `SET LOCAL`. Used by the diarization worker, analysis jobs, graph-persist loop, contacts cache, startup audit. See hazard #3.

---

## E. Auth seam (Google OAuth → owner_id)

- **Today:** `middleware.py` `AuthMiddleware` (`:189-225`) validates a single shared bearer token; sets **no identity**. Frontend bakes `VITE_AUTH_TOKEN` (`apiClient.js:20`).
- **Reusable:** `_verify_google_id_token` (`share_api.py:156-195`) — correct `google.oauth2.id_token.verify_oauth2_token` usage with `GOOGLE_OAUTH_CLIENT_ID` aud check; returns verified email. 100% reusable for main auth; refactor into a shared helper.
- **Seam:** after token/OAuth validation in `AuthMiddleware.dispatch`, set `request.state.owner_id`; `get_async_session()` consumes it for `SET LOCAL`. WS: same owner must come from the *authenticated session*, not client metadata (hazard #2).
- **Not the same thing:** `user_identity_service.py` `self_contact_id` is an app-wide IndrasNet identity, orthogonal to `owner_id`. Don't conflate.

---

## F. Must-fix-BEFORE-enabling-RLS (the hazards)

1. **Default-tenant collision (data-loss risk).** Existing conversations carry `owner_id='default_user'`/`'anonymous'`. Enabling RLS keyed to a real owner makes them invisible/orphaned. **→ Decision: assign all existing rows to the owner's canonical id, migrate, THEN enforce.**
2. **Client-controlled owner on WS (privilege escalation).** `stt_ws_session.py:2742/2867` trusts client-supplied `owner_id`. **→ Derive owner from the authenticated session, ignore client metadata for owner.**
3. **Background jobs run with no owner context.** `get_async_session_context()` paths would hit unset `app.current_owner`. **→ Either an RLS-exempt service role for trusted background writers, or thread explicit owner into each job.**
4. **By-design cross-owner channels.** Share + audio-download endpoints must be explicitly exempt from owner RLS yet keep their token/email gate. **→ Token-validated service path, not `app.current_owner`.**

Plus: **verify table ownership / `FORCE RLS`** in the live DB; **cover the missed live endpoints** (`generation_api.py`, `canvas_api.py`).

---

## G. Proposed rollout order (fail-closed)

0. **Decisions** (below) + verify live-DB table ownership.
1. **Auth seam:** shared Google-token verify helper; `AuthMiddleware` sets `request.state.owner_id`; remove `VITE_AUTH_TOKEN` atomically with this.
2. **App-guard the chokepoints:** `fetch_conversation_bundle` + `list_saved_conversations` + node-keyed endpoints filter by owner. (Immediate IDOR closure even before RLS.)
3. **Owner-path migrations:** add `owner_id`/owner policy to the 2 special tables; backfill default-tenant rows (hazard #1).
4. **RLS plumbing:** `SET LOCAL app.current_owner` in `get_async_session()`; service-role/owner-threading for background jobs (hazard #3); WS owner from session (hazard #2).
5. **RLS policies in shadow → enforce:** leaf tables first, root last; `FORCE ROW LEVEL SECURITY`; SELECT + UPDATE/DELETE (`USING`+`WITH CHECK`); explicit exemptions for share/audio (hazard #4).
6. **Policy tests** (ADR-034 §D6 acceptance): owner-set, owner-unset ⇒ zero rows, wrong-owner, raw SQL, export, WS, graph, share, background jobs.

---

## H. Open decisions for the owner

1. **Owner identity value.** Is `owner_id` the user's Google email (from the ID token), or an opaque user id we mint and map to email? (Affects schema + the existing-data backfill.)
2. **Existing-data backfill.** What `owner_id` do today's `default_user`/`anonymous` conversations become — your Google email, or a fixed `owner:aditya`?
3. **Background-job model.** RLS-exempt **service role** for trusted internal writers (simpler) vs thread explicit owner through every job (stricter, more churn)?
4. **Single-user-now vs build-for-public-now.** Do we implement the full public-grade isolation in one pass, or land the IDOR app-guards + owner backfill now (immediately safer) and stage RLS + OAuth as the public-launch push?

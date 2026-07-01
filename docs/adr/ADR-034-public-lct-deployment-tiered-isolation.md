# ADR-034: Public LCT deployment — tiered access with an isolated public instance

**Date:** 2026-05-31
**Status:** Approved (2026-06-01, Aditya — drafted by Claude, adversarially reviewed by Codex/gpt-5.5 across two rounds: NEEDS-REWORK → APPROVE-WITH-CHANGES, all findings closed before approval). **Partially superseded (2026-07-01) by [ADR-060](ADR-060-serverless-byok-thin-proxy.md):** the "Hosted public" tier (D1 row 2) and Build-plan Steps 2/3/4/5/7/8 (public profile config, persisted BYOK keys, audio-compliance flow, abuse/cost gates, Cloudflare ingress, telemetry) are replaced by ADR-060's thin-proxy/client-side approach — no tenant data reaches the server, so the tenancy/compliance machinery those steps exist for is unnecessary. **Owner tier (D1 row 1) and Self-hosted tier (D1 row 3) are unaffected** and remain as designed. Already-merged Step 0/Step 1 groundwork (IndrasNet gate, `owner_id`/users table) is kept, not reverted — harmless and orthogonal to which public-access approach is used.
**Group:** architecture / deployment (cross-cutting)

> **Revision note (2026-05-31, post-Codex review):** Codex returned NEEDS-REWORK on the first draft. This revision keeps all five owner decisions but: (D2) adds a fail-to-boot startup assertion + egress block instead of relying on an unset env var; (D3/Consequences) splits isolation guarantees by phase — Phase-1-on-asus is container/config isolation, NOT physical, with a residual co-residency risk and home-host availability stated honestly; (D4) requires a separate Postgres *cluster* + isolated encrypted backups; (D6) specifies RLS correctly (`SET LOCAL`, `FORCE ROW LEVEL SECURITY`, no `BYPASSRLS`, policy tests) + a tenant data inventory + OAuth/CSRF/WS-ticket hardening; (Build plan) makes `VITE_AUTH_TOKEN` removal atomic with OAuth, adds a Step-0 threat model + abuse/cost gates, and makes co-residency a security gate, not a telemetry decision.

**Supersedes:** nothing. Constrains all future public-facing / multi-user work.

**Related:**
- Builds on ADR-030 (P1 event-sourced persistence, P6 provider gateway, P7 backend-owned semantic state) — the public instance runs the *same* pipeline, just with enrichment disabled.
- Excludes the IndrasNet-coupled surfaces: ADR-013 (intent_signals / prayer), ADR-033 (consumption prayer matching), and all retrieval/contacts enrichment, from the public tier.
- Honors the IndrasNet `external_llm_ok` privacy gate by simply not shipping any contact data to the public tier at all.

---

## Issue

We want other people to use LCT, but the stack is a **single-owner personal system**: LCT is co-located on the asus box (`asus-strix-scar`) with IndrasNet (:7777), Postgres (:5432), the GPU + local model servers, and the owner's private exocortex data. Conversations carry **biometric voice + transcripts**. Three hard problems:

1. **IndrasNet and the owner's data must never be exposed.** (Owner's explicit, non-negotiable requirement.)
2. **There is no public access today.** Verified: Vercel hosts only the static SPA (`lct_app/vercel.json` is a bare SPA fallback); the SPA bakes `VITE_BACKEND_API_URL` at build time pointing at the **Tailscale Serve** URL; the backend is reachable **only via the tailnet**. A non-tailnet visitor loads `threads.adityaarpitha.com` but every API/WS call fails. No public ingress (Funnel/Cloudflare/reverse-proxy) exists in the repo.
3. **There is no per-user isolation.** Auth is a single shared static bearer token (`middleware.py`); `conversations.owner_id` exists (`models/core.py:50`, NOT NULL, indexed) but is **never enforced on reads** — `list_saved_conversations()` returns *all* conversations.

---

## Context / constraints

- Privacy posture: voice is biometric/sensitive; the architecture assumes one trusted owner.
- One GPU, shared with IndrasNet's own scheduler — strangers' real-time STT load must not contend with it.
- Live feature is WebSocket (`/ws/transcripts`); Vercel cannot proxy WS, so the SPA must reach the backend host directly.
- The full stack is naturally **self-hostable** — anyone wanting IndrasNet runs their own (own box, own tailnet). Nobody joins the owner's tailnet.

---

## Decisions

### D1. Three access tiers

| Tier | What they get | Who operates it | Tenancy work |
|---|---|---|---|
| **Owner** | Full stack + IndrasNet | Owner, asus box, tailnet-only (unchanged) | none (already single-owner) |
| **Hosted public** | LCT graph only, **no IndrasNet** | Owner operates one instance | login + `owner_id` + RLS (so public users don't see each other) |
| **Self-hosted** | Full stack + IndrasNet | Each user, their own box + their own tailnet | none — single-owner design, packaged |

### D2. The public tier gets ZERO IndrasNet — fail-closed in four independent layers
The public profile disables every IndrasNet-coupled feature (enrichment/retrieval, intent_signals/prayer per ADR-013, consumption per ADR-033, contacts/`external_llm_ok`). Enforced by **four layers** so no single bug re-exposes it. *(Codex review: an unset env var alone is weak — code may default to localhost, read a different var, or call a client directly. Hence the startup assertion + egress block below, not just absence.)*
1. **Capability flag** `ENABLE_INDRASNET=false`, consulted by a single `indrasnet_enabled()` gate that every call site must pass through.
2. **Startup assertion (fail-to-boot):** in the public profile, the app **refuses to start** if any IndrasNet URL/secret/provider is configured — absence is asserted, not assumed.
3. **Network egress block:** the public container denies egress by default and allow-lists only the public DB endpoint + chosen cloud LLM/STT providers — the owner's services (IndrasNet `:7777`, the owner's Postgres, LM Studio `:1234`), the host gateway, localhost, and RFC1918 are unreachable even if code tries. (The public `lct_public` DB is reached on the compose network, not via the host's 5432 — see D3.)
4. **Phase-2 (VPS):** IndrasNet is **not present and has no route** — nothing to call. *(In Phase-1 on the asus box this layer does NOT hold; layers 1–3 are load-bearing there — see D3.)*

### D3. The public instance is host-swappable; guarantees differ by phase (revised 2026-05-31 per Codex review)
The public LCT is containerized so the host is interchangeable. **The isolation guarantee is NOT the same in both phases** — this is the most important correction from review, because earlier wording wrote Phase-2 guarantees over a Phase-1 deployment.

- **Phase 1 (asus box, now):** runs on the asus box behind Cloudflare Tunnel with its own `lct_public` DB. Isolation here is **by container + config, NOT physical** — IndrasNet and the owner's private data are on the *same machine*. A public-LCT compromise could in principle pivot to them. This residual co-residency risk is **consciously accepted for an invite-only / small beta** and is bounded by hard controls (below), not by the absence of a target.
  - **Phase-1 hard controls (required before any public ingress):** rootless container; no `--network host`; **no Docker socket mount**; no host bind-mounts except explicit named volumes; **egress deny-by-default**, allow-listing *only* the public DB endpoint + chosen cloud providers. The block targets the **owner's** services — IndrasNet `:7777`, the owner's Postgres, LM Studio `:1234`, host-gateway/localhost, and RFC1918 — i.e. anything on the asus host or LAN. *(Note: the public `lct_public` Postgres also speaks 5432; "block 5432" means the owner's DB endpoint, not the public one. Cleanest is to run `lct_public` as its own container on the public compose network so the allow-list is "this network's db service" and the host's 5432 is simply unreachable.)* Put `lct_public` in a **separate Postgres cluster/instance** (not a second DB in the owner's cluster), own role; run under a **separate OS user**; compose file audited + checked in.
- **Phase 2 (VPS, later):** lift the *same container* to a small cloud VPS. *Now* the strong claim holds: nothing of the owner's is even present, so it cannot leak from there. This is **physical** isolation.

**Co-residency is a security gate, not only a telemetry decision.** Phase 1 is permitted only for a bounded beta (invite-only or capped user count, time-boxed); growth past that bound triggers migration to Phase 2 regardless of uptime numbers (see "Telemetry & migration trigger").

### D4. The public instance has its own database + isolated backups
A separate `lct_public` Postgres instance, distinct from the owner's `lct_dev`. The public instance has no credentials for, and no route to, the owner's database.
- **Phase-1 caveat:** "separate" means a **separate cluster/instance**, not merely a second database in the owner's existing Postgres — a shared cluster shares a superuser and a network endpoint.
- **Backups (added per review):** public backups are **separate, encrypted, and use distinct credentials/buckets** — never a shared backup path with owner data. Define a retention period and run a restore drill. Note the deletion caveat: backups can reintroduce data a user asked to delete, so user-deletion policy must state backup-deletion handling (purge or documented backup-retention window).

### D5. Public compute stays off the owner's GPU
Public transcription + LLM use **cloud providers or BYOK**, never the local parakeet/LM Studio/GPU. (A VPS has no GPU, which enforces this by construction.)

### D6. Within the public instance — per-user tenancy (the load-bearing security work)
Per-user identity (direct Google OAuth, see resolved decisions) replacing the single shared token, with `owner_id` enforced on every tenant-owned row. The review hardened this from a sketch into specific requirements:

- **Tenant data inventory (do this first).** `owner_id` on `conversations` is not enough — the public DB also holds transcripts, audio blobs, graph nodes/edges, semantic events, shares, exports, quota rows, BYOK keys, background jobs, and logs. **Every tenant-owned table must have `owner_id` or a mandatory FK path to a tenant-owned row.** The inventory is the acceptance artifact for Step 1; "owner unset ⇒ zero rows" is a test.
- **RLS done correctly (not just "we have RLS").**
  - Scope per-transaction with **`SET LOCAL app.current_owner = ...`** inside each request/transaction — *not* a connection-level `SET`, which leaks across a pooled connection to the next user.
  - The app's DB role **must not own the tenant tables** and **must not have `BYPASSRLS`**; enable **`FORCE ROW LEVEL SECURITY`** so even the table owner is bound.
  - No service/admin "god" session for normal request paths.
  - **Policy tests** are mandatory: owner-set, owner-unset, wrong-owner, raw SQL, export, WS, graph, share, and background jobs each prove isolation.
- **Scoped data-access layer** on top of RLS (defense in depth): all tenant access goes through one module that injects `owner_id`; unscoped raw queries banned by lint/tests. RLS is the DB backstop; the layer makes the app-level correct path the easy one.
- **Auth/session hardening.** Kill the build-time `VITE_AUTH_TOKEN`. OAuth: verify `iss`/`aud`/`exp`/nonce/`email_verified`, use `state` + PKCE, rotate session on login (anti-fixation), server-side session revocation. Session cookie: httponly + secure + SameSite; CSRF token for mutating cookie-auth endpoints.
- **WebSocket auth.** A **one-time-use, short-TTL ticket bound to user+session+origin**, minted over authenticated HTTPS, **never logged or placed in a URL**. Enforce `Origin` checks, per-message owner context, close-on-revocation/expiry, WS rate limits, max session duration, and reconnect re-auth.

### D7. Two frontend builds from one repo
`VITE_BACKEND_API_URL` is baked at build time, so: the **public Vercel build → the public backend hostname** (Phase 1: the Cloudflare Tunnel hostname fronting the asus container; Phase 2: the same hostname re-pointed at the VPS — the build doesn't change, only what the hostname resolves to); the **owner build → Tailscale Serve**. Same codebase, two env targets.

### D8. Self-hosted tier is a packaging effort, not an auth effort
docker-compose + docs so others run the full single-owner stack themselves. Reuses the existing design; no multi-tenancy. Each self-hoster runs their own IndrasNet + tailnet.

---

## Decisions (resolved 2026-05-31)

Decided with the user; file references from the build-surface map (full sweep archived in session task `wjm55duzf`).

1. **Public identity → direct Google OAuth ("Sign in with Google").** Google is the IdP directly (no third-party broker). Reuses the Google ID-token verification already in `share_api.py` (+ `google-auth` in the venv) — lowest new code, no password surface. Add a `users` table keyed by Google `sub` + a session, replacing the single shared bearer (`middleware.py`) and the build-time `VITE_AUTH_TOKEN` (`apiClient.js:20`). *Accepted trade:* forces a Google account at first; add email/magic-link later for Google-avoiders.
2. **Public compute → quota'd free tier, then BYOK to unlock.** Reuses `QuotaService` (`services/quota_service.py`, `UsageQuota` at `models/system.py:121`) for free-tier metering and ADR-020 BYOK (`services/byok_session_store.py`) for unlock. *New work:* per-user **persistent encrypted** key storage — today keys are session-scoped/in-memory only (`byok_session_store.py:43`, ~30-min TTL). Needs a Fernet-encrypted `UserBYOKKey` table + load→ephemeral-session flow. **Ordering constraint: must come AFTER owner_id enforcement, or public users could read each other's keys.** Also surfaced: LLM free-tier metering isn't wired (`llm_gateway.py` doesn't call QuotaService); import path has no BYOK overlay.
3. **Public audio retention → DEFAULT-ON** (owner's explicit choice). Now first-class, **mandatory** work items (not optional): explicit **consent capture** at signup/record, a **user-facing delete**, **retention/cleanup automation**, and **data export** — biometric voice triggers GDPR erasure/portability and possibly BIPA. `store_audio` default + persistence live in `audio_storage.py` / ADR-030 §D1; delete-with-conversation exists, but consent / retention / export are NEW.
4. **Edge → Cloudflare Tunnel.** Outbound-only (no open inbound ports), origin hidden, WAF/DDoS, forwards only LCT. Design for **WS keepalive** (CF ~100s idle timeout vs long live sessions).
5. **Hosting → asus now, VPS-ready, migrate on telemetry** (see D3 + "Telemetry & migration trigger"). Phase-1 on the asus box behind CF Tunnel with its own `lct_public` DB and no route to `:7777`/`:5432`; the compose file doubles as the self-host artifact (D8).

---

## Consequences

Stated per-phase, because the guarantees genuinely differ (correction from review — the earlier wording claimed Phase-2 properties unconditionally).

**Positive — Phase 2 (VPS)**
- The owner's data, IndrasNet, and GPU are **not present** on the public host — isolation by construction.
- Public breach blast radius = public users' data only.
- Public availability is independent of the owner's home box/ISP.

**Positive — Phase 1 (asus box)**
- $0 hosting; validates the product fast; the *same* container migrates to Phase 2 unchanged.
- Isolation is by container + egress-block + separate DB cluster — strong if the Phase-1 hard controls (D3) all hold, but **not physical**.

**Negative / cost / honest risks**
- **Phase 1 has residual co-residency risk:** a public-LCT compromise shares a machine with IndrasNet + the owner's private data; mitigated, not eliminated. Acceptable only for a bounded invite-only beta.
- **Phase 1 availability is tied to the home box/ISP** (Windows reboots, power, residential uplink) — *not* independent until Phase 2.
- A VPS to run + pay for (Phase 2); two frontend builds; public-tier ops.
- **The owner becomes a data processor** for public users — heavier with audio default-on: consent, deletion (incl. backups), retention, export, breach duties, possibly BIPA/GDPR biometric obligations.
- BYOK adds signup friction (free tier softens it); cloud free-tier compute costs money + invites abuse.

**Open / deferred**
- Federation between self-hosted instances; account portability — out of scope here.
- A full **threat-model artifact** (assets, actors, trust boundaries, ingress, OAuth/session, WS, DB/RLS, IndrasNet gate, secrets, backups, abuse/cost, incident response) is required as Step 0 of implementation, before public ingress — captured as a gate here, authored at build time, not inline in this decision doc.

---

## Build plan (gated; no implementation before this ADR is Approved)

Concrete, file-referenced. **Critical ordering: Step 1 (owner_id enforcement) precedes Step 3 (persisted BYOK keys)** — otherwise public users could read each other's stored keys.

- **Step 0 — no-regret prereqs (safe during review):**
  - **Author the threat model** (the Step-0 gate from Consequences) — public ingress is blocked until it passes.
  - Centralize every IndrasNet call behind one `indrasnet_enabled()` gate that fails closed, **plus the public-profile startup assertion** (refuse to boot if any IndrasNet URL/secret/provider is set) and the **egress allow-list** (D2 layers 2–3). Known sites: `INDRASNET_BASE_URL` usage, `services/indrasnet_client.py`, `services/consumption_trigger.py`, retrieval/search, contacts/`external_llm_ok`. *Exhaustive call-site list in the surface-map (task `wjm55duzf`); add tests that monkeypatch every IndrasNet client and prove public routes cannot reach it.*
  - *(Note: removing `VITE_AUTH_TOKEN` is NOT here — it moves into Step 1, see below, so auth is never left broken/open.)*
- **Step 1 — identity + tenancy (load-bearing security; one atomic step):** add Google-OAuth identity + `users`/session **and** remove the build-time `VITE_AUTH_TOKEN` (`apiClient.js:20`; WS auth `:231`) **together** — never delete the old token before the new auth lands, or there's an open window. Build the **tenant data inventory** (D6), then enforce `owner_id` on **every** tenant-owned read + mutation. `owner_id` exists (`models/core.py:50`) but `conversations_api.py` and the graph / share / WS / export paths return it **unscoped**. Enforce via **Postgres RLS done correctly** — `SET LOCAL app.current_owner` per-transaction, app role without table ownership or `BYPASSRLS`, `FORCE ROW LEVEL SECURITY` (D6) — **plus** a scoped data-access layer. *Acceptance criteria = the surface-map's exhaustive path checklist + the D6 policy tests (owner-set/unset/wrong/raw-SQL/export/WS/graph/share/jobs). Public ingress stays disabled until this step is fully green.*
- **Step 2 — public profile config:** `ENABLE_INDRASNET=false`, `INDRASNET_BASE_URL` unset, DB → `lct_public`, providers → BYOK/cloud only.
- **Step 3 — compute & billing (after Step 1):** `UserBYOKKey` table — **envelope encryption (external KMS preferred over a same-host `ENCRYPTION_KEY`), per-user rows under RLS, no key material in logs, rotation/delete flow, provider validation**; load→ephemeral-session. Free-tier metering via `QuotaService` (extend to LLM in `llm_gateway.py`; wire import-path BYOK overlay). *(Prefer session-only BYOK unless persistence is essential — persisted keys + a host-resident encryption key give limited protection under host compromise, which is exactly the Phase-1 threat.)*
- **Step 4 — audio compliance (because default-on):** consent capture (separate explicit opt-in before recording, with audit trail) + age gate + jurisdiction-aware notice + user-facing delete (incl. backups) + retention/cleanup job + data export + processor/vendor list + privacy policy **before launch**. (`audio_storage.py` / ADR-030 §D1 today.)
- **Step 5 — abuse & cost gates:** per-user/IP/concurrent-WS quotas, max audio duration/file-size, signup throttle/CAPTCHA or **invite-only for the Phase-1 beta**, provider spend caps + circuit breakers, BYOK-validation rate limit.
- **Step 6 — containerize (Phase-1 hard controls, D3):** Dockerfile (one exists — add `.dockerignore` for `.env*`) + audited docker-compose (LCT + `lct_public` Postgres as a service on the compose network), rootless, no `--network host`, no Docker socket, no host mounts beyond named volumes, **egress deny-by-default** blocking the owner's host/LAN services (IndrasNet `:7777`, owner Postgres, LM Studio `:1234`, host-gateway/localhost/RFC1918) while allowing only the compose-network DB + cloud providers, separate OS user.
- **Step 7 — ingress + frontend:** Cloudflare Tunnel with **exact hostname/path ingress rules (no catch-all to the host)**, tunnel token isolated from the app, WAF rules for upload/WS limits, WS keepalive; public Vercel build → CF hostname; owner build → Tailscale Serve.
- **Step 8 — telemetry + backups:** wire the migration-trigger metrics (below) + isolated encrypted public backups with a tested restore drill (D4).
- **Step 9 — self-host packaging:** compose + docs (separate track).

## Telemetry & migration trigger (asus → VPS)

Two independent triggers — **security gate** and **operational signal** — and the security gate dominates.

- **Security gate (primary; not telemetry-based).** Phase-1 co-residency is permitted only for a **bounded beta**: invite-only or a capped user count, time-boxed. Crossing that bound — more/less-trusted users, more sensitive data, or the time box — **forces migration to Phase 2 regardless of uptime**, because no uptime metric detects a pivot into IndrasNet or owner data.
- **Operational signal (secondary).** Migrate sooner if the box can't carry it. **Reuse:** `/api/import/health`, the IndrasNet supervisor's health-probe history (`start_all.py`), ADR-029 usage telemetry, ADR-003 observability. **Track:** availability % (uptime), restart/crash counts, request latency, concurrent WS sessions, CPU/RAM pressure. **Triggers:** availability < ~99% over a rolling week · repeated wedge/crash restarts · sustained resource contention with the owner's GPU / IndrasNet workload.

---

## Notes

Verified current state (2026-05-31): Vercel = static SPA only; backend exposed via Tailscale Serve (tailnet-private) only; **public visitors cannot use it today**; no public ingress in the repo. `conversations.owner_id` exists but is unenforced. CORS already allows `threads.adityaarpitha.com` + `*.vercel.app`.

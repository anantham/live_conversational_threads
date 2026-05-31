# ADR-034: Public LCT deployment — tiered access with an isolated public instance

**Date:** 2026-05-31
**Status:** Proposed (2026-05-31, drafted by Claude for Aditya — pending redline; not yet approved)
**Group:** architecture / deployment (cross-cutting)

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

### D2. The public tier gets ZERO IndrasNet — fail-closed in three independent layers
The public profile disables every IndrasNet-coupled feature (enrichment/retrieval, intent_signals/prayer per ADR-013, consumption per ADR-033, contacts/`external_llm_ok`). Enforced by **three layers** so no single bug re-exposes it:
1. Capability flag `ENABLE_INDRASNET=false`.
2. `INDRASNET_BASE_URL` unset (any call fails closed).
3. On the VPS (D3), IndrasNet is **not present and has no network route** — there is literally nothing to call.

### D3. The public instance runs on a separate cloud VPS — NOT the asus box
The asus box stays **100% private** (owner + IndrasNet + private data, tailnet-only, unchanged). The public LCT runs on a small cloud VPS. This is physical separation, not config separation: *nothing of the owner's is even present on the public server*, so it cannot leak from there.

### D4. The public instance has its own database
A separate `lct_public` Postgres (on/with the VPS), physically distinct from the owner's `lct_dev`. The public instance has no credentials for, and no route to, the owner's database. A public breach is bounded to public users' data.

### D5. Public compute stays off the owner's GPU
Public transcription + LLM use **cloud providers or BYOK**, never the local parakeet/LM Studio/GPU. (A VPS has no GPU, which enforces this by construction.)

### D6. Within the public instance — per-user tenancy (the load-bearing security work)
- Real per-user identity (mechanism = **open**, see below) replacing the single shared token.
- `owner_id` (column already exists) stamped on create and **enforced on every read**, via **Postgres Row-Level Security** (DB-enforced default-deny) **plus** a scoped data-access layer (all conversation access injects `owner_id`; raw queries banned). Defense in depth — RLS is the backstop so one forgotten filter isn't a breach.
- Kill the build-time `VITE_AUTH_TOKEN` (readable by anyone who opens the bundle). Sessions via httponly cookie or short-lived JWT; **WebSocket auth via a short-lived ticket**, not a static query-string token.

### D7. Two frontend builds from one repo
`VITE_BACKEND_API_URL` is baked at build time, so: the **public Vercel build → VPS backend**; the **owner build → Tailscale Serve**. Same codebase, two env targets.

### D8. Self-hosted tier is a packaging effort, not an auth effort
docker-compose + docs so others run the full single-owner stack themselves. Reuses the existing design; no multi-tenancy. Each self-hoster runs their own IndrasNet + tailnet.

---

## Decisions still open — your redline

1. **Public identity mechanism.** External IdP (Clerk / Supabase Auth — fastest, offloads password/MFA/breach risk, but ships user PII to a third party) vs self-hosted OIDC (Authentik/Keycloak — private, more ops) vs roll-your-own sessions (not recommended for public strangers). *Lean: external IdP, unless PII-to-third-party is unacceptable.*
2. **Public compute.** BYOK (users bring their own keys — $0 to you, their data via their own account, some signup friction) vs cloud-on-your-dime (zero friction, you pay + you become processor of their data). *Lean: BYOK.*
3. **Public audio retention.** Default-OFF + consent-gated + retention/deletion for the public tier (strangers' biometric voice)? *Lean: yes, default-off.*
4. **Edge.** Cloudflare in front of the VPS (custom domain + WAF + rate-limit + DDoS, no open inbound ports) vs bare VPS + Caddy. *Lean: Cloudflare in front.*
5. **VPS + DB specifics.** Provider, managed Postgres vs container Postgres, sizing. (Implementation detail; needs a pick.)

---

## Consequences

**Positive**
- The owner's data, IndrasNet, and GPU are never on the public surface — isolation by construction, not by careful coding.
- Public breach blast radius = public users' data only.
- Public availability is independent of the owner's home box/ISP.

**Negative / cost**
- A VPS to run + pay for; two frontend builds; public-tier ops.
- The owner becomes a data processor for public users (consent, deletion, privacy law) — smaller surface than a shared DB, but real.
- BYOK adds signup friction (or cloud compute costs money).

**Open / deferred**
- Federation between self-hosted instances; account portability — out of scope here.

---

## Build plan (gated; no implementation before this ADR is Approved)

- **Step 0 — no-regret prereqs (safe during review):** verify every IndrasNet call in LCT sits behind one capability gate that fails closed; remove the static `VITE_AUTH_TOKEN` from the frontend.
- **Step 1 — tenancy:** per-user identity + `owner_id` enforcement (Postgres RLS + scoped data layer). The load-bearing security work.
- **Step 2 — public profile:** config that disables IndrasNet, points at `lct_public`, and uses BYOK/cloud providers.
- **Step 3 — containerize:** LCT backend + Postgres via docker-compose.
- **Step 4 — public ingress:** VPS provision + edge (Cloudflare → VPS → container, WS-capable) + public Vercel build.
- **Step 5 — self-host packaging:** compose + docs (separate track).
- **Privacy:** public audio default-off + consent + deletion.

---

## Notes

Verified current state (2026-05-31): Vercel = static SPA only; backend exposed via Tailscale Serve (tailnet-private) only; **public visitors cannot use it today**; no public ingress in the repo. `conversations.owner_id` exists but is unenforced. CORS already allows `threads.adityaarpitha.com` + `*.vercel.app`.

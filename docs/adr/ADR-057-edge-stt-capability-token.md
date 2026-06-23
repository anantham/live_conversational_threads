---
Date: 2026-06-23
Status: **Proposed — design for review.** Prerequisite for ADR-056 Phase 1 (resolves its BLOCKING items #1 egress-gate preservation and #2 ingestion trust model). Nothing built. (ADR number provisional — renumber on merge.)
Group: Infra / Security / Live STT
Related: ADR-056 (M5 edge STT — the topology this secures); ADR-034 (audio egress chokepoint — the policy this must keep Asus-owned); ADR-050 (fleet heartbeat/lease — the Asus↔M5 trust channel reused for key/credential provisioning); share-link auth (`attendee_api._verify_signature` — the existing HMAC pattern reused here); `middleware` AUTH_TOKEN (the bearer the client already holds).
---

# ADR-057: Edge-STT Capability Token & Trusted Result Delivery

> ADR-056 moves live audio from **client → Asus → M5 → Asus** to **client → M5 direct**. That bypasses the ADR-034 server-side egress gate and would make the Asus ingest client-supplied transcripts + ECAPA **biometric** embeddings with no audio grounding. This ADR keeps the egress decision Asus-owned and prevents client injection, **reusing existing primitives** (AUTH_TOKEN bearer, the share-link HMAC signer, the fleet trust channel) rather than a new auth stack.

## Issue
With client→M5-direct STT, two server-side guarantees disappear:
1. **Egress (ADR-034):** today the Asus decides, per its policy, whether audio may leave for STT. A direct browser→M5 stream never passes that gate.
2. **Trust:** today transcripts/embeddings are produced inside the trusted backend. If the client posts them, an authenticated-but-untrusted browser can inject arbitrary transcripts and **biometric speaker vectors** into the system of record (ADR-022 ECAPA space).

## Context — primitives already present
- **AUTH_TOKEN** bearer enforced by `middleware` on all non-health endpoints; WS handshake auth via `check_ws_auth_message`. The client already holds it.
- **HMAC signing pattern** already in use for share-links (`attendee_api._verify_signature` over a raw body). No new crypto stack needed.
- **Server-side egress gate** `privacy_boundary.assert_audio_egress_allowed` (the ADR-034 chokepoint).
- **M5 is a trusted fleet node** — it already authenticates to the Asus for `fleet-heartbeat` (capability reporting) and `fleet-lease`; that channel can carry the signing key + the M5's delivery credential.

## Decision
A short-lived **capability token** minted by the Asus authorizes a single edge-STT session; the **M5 validates it before accepting audio**; the **M5 delivers results to the Asus server-to-server** (not via the client). Chosen variants (from ADR-056's open decisions): **(A) server-to-server result delivery, (B) shared-secret HMAC, (C) key/credential provisioned over the fleet channel** — each the lightest option reusing an existing primitive.

### Flow
1. **Authorize — the egress gate becomes token issuance.** The `AUTH_TOKEN`-authenticated client requests an edge session (e.g. `POST /api/stt/edge-session {conversation_id}`). The Asus evaluates its **ADR-034 egress policy there**; if on-device M5 STT is permitted, it mints a token:
   `{ v, conversation_id, session_id, stt_node:"m5", scope:"audio-stt", iat, exp (≈2–5 min), nonce }`,
   **HMAC-signed** with `STT_EDGE_SIGNING_KEY` (same signer as share-links). The token **is** the egress authorization — the policy decision stays Asus-side. No token ⇒ no edge STT.
2. **Gated audio → M5.** The client streams audio to the M5 (`:5443` Serve HTTPS) presenting the token (first WS message / header). The **M5 validates before accepting any audio byte**: signature (shared key), `exp`, `scope=="audio-stt"`, `stt_node=="m5"`, and a one-use **nonce** check (replay). Invalid/expired/absent ⇒ refuse. This re-instates the ADR-034 chokepoint at the M5 under Asus control.
3. **Trusted result delivery.** The M5 transcribes, then **(a)** returns the transcript to the client for **immediate display** (the ADR-056 latency win), and **(b)** posts the authoritative transcript + segments + ECAPA embeddings to the Asus **server-to-server** (M5 → `asus-strix-scar.tail4741ad.ts.net`), authenticated as the **M5 fleet node** and echoing the session token. The Asus **accepts live results for a `session_id` only from the authorized M5**, keyed to the token's `conversation_id` — **never from the client**.
4. **Persist/graph** Asus-side from the M5-delivered result (authority unchanged).

### What it prevents
- **Egress bypass** — M5 won't accept un-tokened audio; only the Asus mints tokens, per ADR-034 policy.
- **Client transcript/biometric injection** — the authoritative store ingests only M5-delivered, session-keyed results over an authenticated server-to-server channel; the client gets a display copy.
- **Replay** — `nonce` (one-use) + short `exp`.
- **Token theft blast radius** — short TTL + tight scope (`audio-stt`, single `conversation_id`/`session_id`, single node).
- **M5 impersonation on delivery** — the M5 authenticates to the Asus with its fleet credential, not just the (client-visible) session token.

### Kill switch & no laptop coupling (also satisfies ADR-056 #7, helps #4)
The Asus chooses **per session** whether to mint an edge token: a policy/flag flip stops issuance and **transparently reverts all clients to the backend-orchestrated path** (no redeploy). **Rotating `STT_EDGE_SIGNING_KEY`** instantly invalidates outstanding tokens. Short TTL bounds a sleeping-laptop mid-session to a quick fallback.

## Consequences
- Egress policy stays Asus-owned; the client stays untrusted; biometric vectors enter only via the trusted M5.
- New surface: one token-issuance endpoint (Asus), token validation + nonce store (M5), and an authenticated M5→Asus result-ingest endpoint that rejects non-M5/unauthorized-session posts.
- The M5 must hold `STT_EDGE_SIGNING_KEY` (validation) + a fleet delivery credential — provisioned over the fleet channel (C); both rotatable.
- Latency: the client still gets its display transcript directly from the M5 (fast); the M5→Asus authoritative post is off the user's critical path.

## Alternatives considered
- **Client relays an M5-signed result envelope** (instead of server-to-server). Rejected (A): puts the authoritative result in the untrusted client's hands and needs a signing key on the M5 anyway; server-to-server is simpler trust since the M5↔Asus path already exists.
- **Asymmetric signing** (Asus private-key signs, M5 verifies public). Rejected (B) for now: more key management for no benefit over a shared secret on a 2-party trusted-fleet link; revisit if more nodes mint/verify.
- **No token — rely on Tailnet ACLs.** Rejected: a tailnet ACL is per-device, not per-conversation/per-policy; it can't express "this user may use edge STT for this conversation right now," which is the ADR-034 decision.
- **Keep audio server-relayed (ADR-056 status quo).** The safe default if this token design isn't worth the surface — see ADR-056 measurement gate (#5).

## Open questions
- **Clock skew** vs short `exp` — tolerance / use the token's `iat` + a window.
- **Nonce store** on the M5 — in-memory (fine; tokens are short-lived) vs shared; behavior across M5 restart.
- **Exact M5→Asus delivery auth** — reuse the fleet credential, or a dedicated mTLS/bearer for the ingest endpoint; and the ingest endpoint's authorization rule (`node==m5` AND `session_id` was Asus-issued AND not already finalized).
- **Biometric retention/consent (PII):** ECAPA embeddings are biometric — does moving their production to the edge change any ADR-022/consent posture? (Likely no — they still land only in the Asus store via the M5 — but confirm.)
- **Key provisioning mechanics** over the fleet channel (rotation cadence, where stored on the M5 — not under `~/Documents`, per the fleet TCC note).
- **Multi-session / concurrency** — one token per (conversation, session); the Asus tracks issued sessions for the ingest authorization check.

## Status for ADR-056
This design, once accepted, closes ADR-056's BLOCKING #1 (egress) and #2 (trust), and provides the runtime kill-switch for #7. ADR-056 Phase 1 remains gated additionally on #3 (continuity state machine), #4 (path-aware fallback), #5 (application-level measurement), and #6 (diarization parity).

---
Date: 2026-06-23
Status: **Proposed — design for review. REVISED after a codex + grok dual-family SECURITY review (both REVISE; convergent).** Honest correction: this design **reduces blast radius but does NOT fully close** ADR-056 #2 (trust) — a fully-compromised M5 (a laptop) can still fabricate results for an authorized session. It does close #1 (egress) and shrink #2 to a documented residual. **An architectural fork (below) needs a human decision before build.** (ADR number provisional.)
Group: Infra / Security / Live STT
Related: ADR-056 (M5 edge STT topology); ADR-034 (audio egress chokepoint — kept Asus-owned); ADR-050 (fleet trust channel for key/credential provisioning); ADR-022 (ECAPA biometric embedding space — PII sign-off needed); share-link `_verify_signature` (existing HMAC, but see B below); `middleware` AUTH_TOKEN.
---

# ADR-057: Edge-STT Capability Token & Trusted Result Delivery

> ADR-056 moves live audio to **client → M5 direct**, bypassing the ADR-034 egress gate and making the Asus ingest client-produced transcripts + ECAPA **biometric** embeddings. This ADR keeps the egress decision Asus-owned and shrinks the injection surface — but a dual-family security review established a hard truth: **the edge node is a laptop and therefore a weaker trust tier; no token scheme makes a compromised M5's fabricated biometrics impossible.** The design below reduces the blast radius; the residual risk is documented and gates a topology decision.

## Issue
Client→M5-direct STT removes two server-side guarantees: (1) the Asus's per-policy **egress** decision (ADR-034), and (2) production of transcripts/biometrics **inside the trusted backend**. Naively letting the client post results lets an untrusted browser inject. But pushing production to the M5 **moves**, not eliminates, the trust problem — the M5 is now the injector of concern.

## Context — primitives present
AUTH_TOKEN bearer (`middleware` + `check_ws_auth_message`); an HMAC signer (`_verify_signature`, share-links); the server-side egress gate (`privacy_boundary.assert_audio_egress_allowed`); the M5 as a fleet node (heartbeat/lease) — a channel for key/credential provisioning, but **a laptop**: lose/steal/compromise are in-scope threats.

## Decision
A short-lived, **single-M5-bound, asymmetrically-signed** capability token authorizes one edge session; the M5 validates it before accepting audio; the M5 delivers results to the Asus **server-to-server** under a **per-session-scoped** credential; the Asus **re-verifies the full token and bounds/validates the payload** on ingest. Revised variants vs the first draft: **(A) server-to-server delivery — kept**; **(B) asymmetric signatures — CHANGED from shared-HMAC** (the review showed a shared secret on a laptop is indefensible: one exfil lets an attacker mint universally-accepted tokens — so the Asus signs with a private key and M5s hold only a **public verify key**); **(C) provision the public key + a per-session delivery credential over the fleet channel — kept**, with key-IDs and rotation.

### Flow (hardened)
1. **Authorize (= the ADR-034 egress decision).** The AUTH_TOKEN-authenticated client requests an edge session. The Asus applies its egress policy and, **under per-user + per-conversation rate limits (one active session per conversation)**, mints a token signed with its **private key**:
   `{ v, kid, iss, aud, sub(user), conversation_id, session_id, assigned_m5_node_id, scope:"audio-stt", iat, exp(≈2–5m), nonce }`.
   The Asus **records the issued (session_id, assigned_m5_node_id, nonce)** for ingest-time matching and DoS bounding.
2. **Gated audio → M5.** Client streams to the assigned M5 (`:5443` Serve HTTPS) presenting the token (header/first-message only, never URL/log). The M5 verifies with the **public key**: signature, `kid`, `iss/aud`, `exp`, **bounded clock skew** (reject future `iat`, cap `exp−iat`, monotonic deadline after accept), `scope`, and **`assigned_m5_node_id == self`** (reject tokens addressed to another node), plus WS **Origin** check. No/invalid ⇒ refuse. This is the relocated, Asus-owned egress chokepoint.
3. **Trusted-ish result delivery.** The M5 transcribes, returns the transcript to the client for **display** (the latency win), and posts the authoritative transcript + segments + ECAPA embeddings to the Asus **server-to-server**, authenticated with a **per-session delivery credential** (not the general fleet cred). The Asus ingest **re-verifies the full signed token**, enforces `delivering_node == assigned_m5_node_id`, `session_id` issued & **not finalized**, redeems the **nonce atomically (Asus-side)**, and **strictly bounds the payload** (transcript size, segment count, embedding dim/value ranges, Unicode, no decompression bombs).
4. **Persist/graph** Asus-side from the validated result.

## Threat model & residual risk (the crux — be honest)
- **Honest M5 + honest client:** egress stays Asus-owned; client cannot inject (results are M5→Asus, session-keyed). ✅
- **Stolen token / hostile client:** bound to one node + one session, short TTL, Asus-redeemed nonce, rate-limited, Origin-checked, header-only ⇒ small, brief blast radius. ✅ (Residual: a token holder can still feed *real audio* and get a *grounded* transcript — acceptable; the guarantee is "no result independent of supplied audio," not "no result at all.")
- **Stolen M5 *credential* (not the node):** asymmetric signing means a leaked verify-key forges nothing; a leaked *delivery* credential is per-session-scoped + node-bound ⇒ limited. ✅
- **Fully-compromised M5 (lost/rooted laptop):** ❌ **NOT closed.** Such an M5 holds a valid delivery path and can fabricate arbitrary transcripts + **biometric embeddings** for any session it's assigned, ignoring the audio. Mitigations *reduce* this (asymmetric keys, per-node binding, per-session scope, short TTL, payload bounds, instant node revocation via key-version + Asus deny-list, device security, in-memory-only biometrics) but do not eliminate it. **This is the trust downgrade inherent in producing biometrics on a laptop.**

## Architectural fork — needs a human decision (gates ADR-056)
Given the residual above, choose the trust posture:
- **(I) Accept the edge as a lower trust tier** — ship the hardened token design; document that a compromised M5 can forge results for authorized sessions; rely on device security + revocation + short scope. Simplest; accepts a real (if bounded) biometric-integrity risk.
- **(II) Don't produce *authoritative biometrics* at the edge** — use the M5 only for the **fast display transcript** (best-effort, untrusted), and keep authoritative transcript+embeddings on the trusted Asus path (today's relay, or a later trusted-node design). Preserves trust; **gives up most of the latency win for the authoritative/diarized path** (the relay returns for it).
- **(III) Defer edge STT** until a trusted-execution / signed-attestation story exists for the node. Safest; no win now.

This fork may change ADR-056's Decision. Recommend **(II) for any conversation requiring diarization/biometrics, (I) only for plain low-stakes transcription** — i.e. let the egress policy pick per-conversation.

## Consequences
- Egress stays Asus-owned; client injection closed; **edge-node injection bounded, not eliminated**.
- New surface: token issuance + rate limits + issued-session store (Asus); asymmetric key distribution + per-session delivery creds + rotation/revocation; M5 validation + Origin/skew checks; a payload-bounding, nonce-redeeming, full-token-re-verifying ingest endpoint; audit chain (authorize → redeem → stream → ingest) without logging tokens/audio/transcripts.
- ECAPA embeddings become a **PII flow produced on a user laptop** — requires in-memory-only handling on the M5 and explicit **ADR-022 consent/retention sign-off**.

## Alternatives considered
- **Shared-HMAC signing.** Rejected (review): a secret on a laptop is a universal-forgery key on compromise. Asymmetric instead.
- **Client-relayed signed envelope.** Rejected (A): authoritative result in untrusted hands.
- **Tailnet ACL only.** Rejected: per-device, not per-conversation/per-policy — can't express the ADR-034 decision.
- **Reuse the share-link key/signer literally.** Rejected: use a **dedicated** key + a mature signed-token format (fixed alg, strict parse, domain-separated keys, kid, constant-time verify, bounded size) — not the share-link key.

## Open questions
Exact skew leeway; Asus nonce-redemption service shape; per-session delivery-credential mechanism + rotation/lost-device procedure; key-version (kid) rollout with overlap + stale-version deny; payload bound limits; audit-event schema; the fork decision (I/II/III) and whether it's per-conversation via egress policy; ADR-022 sign-off for edge-produced biometrics.

## Status for ADR-056
Closes #1 (egress). **Partially** closes #2 (trust) — reduces to a documented compromised-M5 residual; full closure depends on the fork decision. Provides the #7 kill switch (stop issuance / rotate key + Asus node deny-list). #3/#4/#5/#6 remain.

## Validation
Reviewed by codex (`codex-cli`) + grok (`grok-build`), 2026-06-23 — both REVISE, convergent: shared-HMAC-on-laptop, token-not-node-bound, compromised-M5 fabrication, in-memory nonce replay, no rate limits, clock-skew-is-security, biometric-PII-flow-change. All folded above.

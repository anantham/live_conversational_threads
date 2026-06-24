---
Date: 2026-06-23
Status: **Proposed — design for review. REVISED after a codex + grok dual-family review (both returned REVISE; convergent findings folded in below). RECALIBRATED 2026-06-23** to the personal/owned-device threat model — security gates collapsed to `AUTH_TOKEN` + Serve HTTPS (ADR-057 shelved, PR #87 closed); **#5 measured → direct ~0.43 s vs relay ~1.7–2.4 s (~4–6× win) → build justified.** Remaining gates are engineering (#3 continuity, #4 fallback, #6 diarization). Nothing built. (ADR number provisional.)
Group: Infra / Fleet topology / Live STT latency
Related: ADR-050 (fleet capability heartbeat + lease — the M5 as an AI-services node); ADR-040 (backend port ownership & restart authority — why we DON'T make the M5 a second :43181 manager); ADR-034 (egress chokepoint — the audio egress gate this design must NOT bypass); PR #83 (diarization shape fix on the backend→M5 relay path — interacts with this).
---

# ADR-056: M5 Edge STT — cut the audio relay by moving live STT to the M5

> Live audio currently round-trips **mobile → Asus → M5 → Asus → mobile**: the phone streams audio over WSS to the Asus backend (`/ws/transcripts`), which **relays** the audio to the M5's STT and back. Since the M5 already does the heavy STT compute, the relay is overhead. This ADR proposes moving the live STT *entry point* to the M5 — an **opportunistic edge accelerator**, not a second backend — while the always-on Asus stays the single authority (DB, graph, workers). **A dual-family review (below) confirmed the topology is reasonable but raised BLOCKING security/continuity gaps that must be designed before building.**

## Issue
Audio latency is dominated by network round-trips, and one is avoidable. Per utterance the **raw audio** crosses the network ~twice before any transcript exists (phone→Asus, then Asus→M5). The M5 is *downstream* of the Asus, so the heavy payload makes an extra internal hop and waits on Asus orchestration.

## Context — grounded in the live system (2026-06-23)
**Prod frontend config** (read from inlined values in the live `threads.adityaarpitha.com` bundle; `VITE_*` env is Vercel build-time, not on disk):
- Backend base = `https://asus-strix-scar.tail4741ad.ts.net` (Asus over **Tailscale Serve HTTPS**). Live audio → `wss://asus-strix-scar.tail4741ad.ts.net/ws/transcripts`.
- Active STT provider = **`parakeet`** (not overridden). Client-side STT URLs are **dev-localhost** and the whisper one is the plain-HTTP Asus default (mixed-content-blocked) → the client-side lane is **unused in prod**. `adityas-macbook-pro` appears **0 times**.
- **⇒ prod uses the *backend-orchestrated* path**: phone → WSS `/ws/transcripts` (Asus) → Asus relays audio to M5 STT (the `backend_http` transport PR #83 touched) → transcripts/graph back.

**Fleet role (ADR-050):** M5 = AI-services node (Ollama `:11434` + mlx-STT `:5095`), autostarted, advertised to the Asus registry via `fleet-heartbeat`, with a `fleet-lease` broker. No app backend; **no prod data** (only `lct_test.db`); Asus owns Postgres (`localhost:5432`).

**Measurements (PRELIMINARY — `tailscale ping` RTT, not application timing; see Required-before-Phase-1 #5):**
- M5 already serves **HTTPS via Tailscale Serve** with valid MagicDNS certs; **verified**: a route `https://adityas-macbook-pro.tail4741ad.ts.net:5443/ → :5095` returns `/health` 200 with a valid cert and `diarization:available`.
- M5 ↔ Asus: direct ~55 ms each way (the relay leg this would remove). M5 ↔ phone (`pixel-10-pro`): direct ~139 ms / DERP(blr) ~433 ms.
- **NOT measured:** phone ↔ Asus (so "phone→M5 ≈ phone→Asus" is an assumption, not data), and no application-level (first-partial / final / persisted / graph-ready) latency for either path.

## Decision
Make the M5 the **opportunistic entry point for the live audio/STT leg only**, via client-side STT to the M5's Tailscale-Serve HTTPS endpoint. The Asus remains the **single authority** (`/ws/transcripts`, Postgres, graph, workers). Flow: mic → **M5 (Serve HTTPS → local STT)** → transcript → `/ws/transcripts` (Asus). **M5-first with path-quality-aware fallback** to today's backend-orchestrated path.

This is deliberately **not** "run LCT on the M5": no M5 app backend, no shared DB, no workers on the M5 — avoiding the double-singleton / port-ownership (ADR-040) / laptop-as-primary hazards. The M5 is **durably stateless** (it owns transient per-utterance session state — buffers, warm-up, in-flight chunks — but nothing persistent).

## Required before Phase 1 (BLOCKING — raised by the dual-family review)
These must be designed/answered before any change to the live capture path:

> **Recalibrated 2026-06-23 to the real threat model** (personal, single-user, owned devices, trusted tailnet, owner-secured laptop). The security items are RIGHT-SIZED: **#1/#2/#7 collapse to "the M5 STT endpoint requires the existing `AUTH_TOKEN` over Tailscale-Serve HTTPS — no capability-token machinery"** (the M5 is a local owned node, not external egress; the client is the same single user; ADR-057's asymmetric-key/per-session-credential design is shelved as over-scoped — PR #87 closed, branch kept). The real remaining gates are **engineering, not security**: #3 continuity, #4 fallback, #6 diarization parity. **#5 is now MEASURED (see Consequences) — the win is SUBSTANTIAL (~4–6×), so the topology is worth building.**

1. **Egress-gate preservation (ADR-034).** Today audio passes the Asus server-side egress chokepoint. Client→M5-direct *bypasses* it. Decide the enforcement: an **Asus-issued short-lived token the M5 validates before accepting audio** (preferred), a relocated gate on the M5, or a justified exemption. Do not build until chosen.
2. **Ingestion trust model.** Moving STT client-side means the Asus would accept client-supplied transcripts, speaker tags, and **ECAPA biometric embeddings** with no audio grounding → an authenticated client could inject arbitrary content. Require **authenticated M5→Asus delivery and/or signed result envelopes** with strict server-side validation; document the new trust boundary explicitly.
3. **Capture session state machine & continuity.** Specify utterance IDs, client-side buffering, ack/idempotent ingestion at `/ws/transcripts`, failover **fencing**, dedup, and behavior on M5 recovery after sleep/network-move — so a laptop state change can't drop or duplicate audio or split-brain.
4. **Truly-independent fallback.** Fallback must not depend on the M5 (a sleeping laptop must degrade to the always-on Asus path or a cloud provider). Trigger on **path quality (RTT/DERP), not just error** — a DERP-reachable M5 at ~433 ms must NOT win the health gate; add hysteresis + a circuit breaker + prefer-Asus-when-remote.
5. **Measure before approving the topology.** Replace the ping-derived savings with **application-level** timing (first-partial, final, persisted, graph-ready) for BOTH paths including **phone→Asus**; confirm the net delta is positive. Note: per-chunk **HTTP STT (option 1a) may add chunk-duration + per-call model-invocation latency that exceeds the removed relay** — benchmark it against streaming WS (option 1b) at p50/p95 before recommending either.
6. **Diarization parity is a Phase-1 release gate.** Phase 1 must not regress diarization/embeddings (PR #83 only fixed the backend-relay path); either wire client-direct diarization (frontend requests `diarize`/`include_embeddings`; `/ws/transcripts` validates+accepts the fields) or **disable edge mode when diarization is required**.
7. **No hard-coded laptop coupling.** A static `VITE_STT_EDGE_M5` + M5 MagicDNS name couples prod to one laptop's identity with no kill switch. Use **runtime config/discovery** (leverage the ADR-050 fleet heartbeat/lease) + a fast runtime disable.

## Implementation (phased; gated on the above)
- **Phase 0 — DONE:** M5 STT exposed over Tailscale-Serve HTTPS (`:5443`, verified, cert-valid, diarization available). Reversible (`tailscale serve --https=5443 off`); same unauthenticated-on-tailnet posture as `:5095`.
- **Phase 1 — frontend client-side STT to the M5, behind a runtime flag, with fallback.** Options: **(a)** HTTP-chunk against the M5's existing `/v1/audio/transcriptions` (no new server, but possibly higher latency — must benchmark, #5); **(b)** a streaming-WS shim on the M5 speaking the frontend `/stream` protocol (lower latency, new component). Choose after #5.
- **Phase 2 — diarization parity** (gate #6).
- **Phase 3 — reliability**: persist the Serve route (already durable via `--bg`), fast sub-second + path-aware fallback.

## Consequences
- **Win (MEASURED 2026-06-23, same 2 s chunk):** direct browser→M5 over Serve HTTPS **~0.43 s** vs the Asus relay **~1.7–2.4 s** — the relay adds **~1.3–2 s of orchestration/double-hop overhead per chunk** (the relay's own response shows actual M5 compute was only ~0.25 s + ~0.3 s diarize). So the direct path is **~4–6× faster server-side — SUBSTANTIAL, not modest** (the earlier ping-derived "~110 ms" was an order of magnitude low; #5 vindicated). The direct measurement used the M5's existing HTTP `/v1/audio/transcriptions` (**Phase-1 option (a) — validated as fast; the WS shim (b) is likely unnecessary**). Caveats: the direct test omitted diarization (+~0.3–0.5 s when added → still ~½ the relay); the phone↔entry leg (~139 ms direct / ~433 ms DERP) adds to BOTH paths, so this server-side saving carries through for the phone.
- **Cost:** the M5 is a **laptop** (sleeps/moves/battery) — only viable as an accelerator with truly-independent, path-aware fallback (#3, #4).
- **Security surface changes** (egress bypass + client-supplied biometric data) — net-new and BLOCKING (#1, #2); not present in the relay design.
- **No new authority:** Asus stays sole backend/DB/worker owner → no ADR-040 ownership/restart surface, no double-processing.

## Alternatives considered
- **Full LCT backend on the M5 (shared Asus Postgres), symmetric fallback.** Rejected for: shared-DB coupling (M5 not independent; +~55 ms/query), background-singleton double-processing, ADR-040 ownership, laptop-as-co-primary. *(Review note: before final rejection, briefly compare a **workers-disabled / lease-gated** M5 backend and an **authenticated M5 edge-gateway** variant — the "workers must duplicate" objection is avoidable with config, so rejection should rest on the other costs.)*
- **Raw Tailscale IP from the browser.** Rejected: mixed-content-blocked on the HTTPS frontend; WSS needs a cert. (No latency benefit either — same WireGuard tunnel — though that's an expected property, not the reason.)
- **Status quo (backend-orchestrated relay).** Acceptable if #5 shows the relay leg is negligible vs the phone↔server leg — measure before investing.

## Open questions (resolve before Phase 1 build)
Frontend/capture: HTTP-chunk vs `/stream` WS transport; does `/ws/transcripts` accept client-produced transcripts (+speaker/embedding fields); path/shape reconcile vs the M5's `/v1/audio/transcriptions`.
Cross-cutting (added by review): auth model for browser→M5 STT; CORS/Origin + Tailnet ACL posture; chunk ordering & backpressure; partial failure (M5 STT ok but Asus post fails); session resume after fallback/network-flap; battery/CPU cost on the phone and M5; observability (per-path tagging + metrics, failure classification); schema/version negotiation; M5 cold-start/model-warm-up; concurrency (multiple sessions).

## Validation done
Prod config read from the live bundle; M5↔phone and M5↔Asus links measured via `tailscale ping`; M5 Tailscale-Serve HTTPS verified (`:5443` /health 200, valid cert, diarization available); M5 STT diarization+embeddings confirmed (PR #83). Reviewed by codex (`codex-cli`) + grok (`grok-build`), 2026-06-23 — both REVISE, convergent on the BLOCKING items above.

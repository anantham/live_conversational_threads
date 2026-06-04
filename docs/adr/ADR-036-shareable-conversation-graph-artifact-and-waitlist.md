---
Date: 2026-06-05
Status: Proposed
Group: Product / Deployment
Related: ADR-021 (authored hierarchy), ADR-031 (post-streaming consolidation), ADR-032 (edge taxonomy; reserved the 036 slot for enrichment-context), ADR-033 (consumption prayer matching — bidirectional POC), ADR-034 (tiered deployment + egress isolation), ADR-035 (crux detection); docs/ADR_GRAPH_DATAMODEL_CONSISTENCY_2026-06-05.md; IndrasNet ADR-026 (continuous reprocessing — future), ADR-017 (unified retrieval — future), ADR-009 (privacy/consent — future)
Supersedes-reservation: ADR-032 reserved ADR-036 for a future "enrichment-context integration" (the live IndrasNet→LCT retrieval loop). That loop is DEFERRED (see Non-Goals); this ADR repurposes the 036 slot for the near-term shareable-artifact wedge. The deferred live-fetch + graph-handoff integration is captured separately (LCT future ADR + IndrasNet ADR-050, both mapped 2026-06-05, not yet written).
---

# ADR-036: Shareable Conversation-Graph Artifact + Waitlist Demand Capture

> The "Google Maps for a conversation" wedge.

## Issue

After a real conversation (in person / on a call — **not** in-app, **not** real-time), the owner wants to give the other participant something better than a flat Gemini-style summary: a **navigable artifact** they can explore — zoom out to arcs/themes, zoom into a tangent, read scoped summaries of each thread. The recipient can ask to join the closed beta via a **waitlist** that also captures *which features they want* and *what they'd pay*. The owner self-hosts the backend on their Tailscale.

This is the smallest end-to-end loop that (a) delivers visible value, (b) is a growth surface, and (c) turns the roadmap demand-driven.

## Context

- **Post-hoc, not live.** The conversation is captured (audio → STT → graph) and processed *after* it ends. This distinguishes the wedge from the live consumption path (ADR-033) and the deferred live-enrichment loop.
- **Builds on what exists.** Authored 5-tier hierarchy (ADR-021), post-streaming consolidation into topics/themes/arcs (ADR-031), tangent/crux flags (ADR-035 + the H2 upward-propagation fix landed 2026-06-05 — end-to-end verification on a consolidated conversation still pending, see slices), semantic edge taxonomy (ADR-032). The frontend already has a ReactFlow graph canvas with tier zoom + drilldown + markers, a full share-token system, a `BetaGate.jsx`, and a Vercel deployment (`lct_app/vercel.json`) — see Current State.
- **Reprocessability (IndrasNet ADR-026).** The graph is an *extraction view* over sacred audio, regenerable as models/prompts improve. Therefore the artifact does **not** need to be perfect — "good enough + versioned" is the bar. Local models will keep improving; we don't gate the wedge on extraction perfection.
- **Deployment tiers (ADR-034).** ADR-034 isolates the multi-user public app from the owner's box and IndrasNet (capability flag, startup assertion, egress block, eventual VPS). The wedge's share surface is a **narrower, read-only exposure** that must be reconciled with — not violate — that isolation (see D2 / Constraints).

## Decision

**D1 — The artifact is the authored hierarchy rendered as a navigable map.**
Zoom across tiers (arc → theme → topic → idea → chunk), drill into a node's children, and read the node's scoped summary at each tier. Tangent and crux nodes are visually marked **at every tier** (enabled by the H2 propagation fix; consolidation supplies tier summaries). No new extraction is required for v1 — it renders the graph we already persist.

**D2 — Reuse the existing share-token system; expose it through a PATH-ISOLATED public surface, never by Funnelling the whole backend.**
The share infrastructure already exists and is reused as-is: `share_api.py` mints opaque tokens (`POST /api/conversations/{id}/share`), serves read-only (`GET /api/share/{token}`), with email allowlist, expiry, revoke, view tracking; frontend `ShareConversation.jsx` + `ShareManagerModal.jsx` + route `/share/:token`. The wedge does **not** build a share path — it hardens and exposes this one.

**Critical constraint (Codex review):** `backend.py` mounts *every* router into one app (import, generation, analysis, graph, settings, IndrasNet-adjacent, share — `backend.py:252-279`). Tailscale Funnel in front of that process exposes the **entire** backend, not "graph + waitlist." Therefore the public surface MUST be path-restricted to exactly: `GET /api/share/{token}`, `GET /api/share/{token}/audio` (gated by D7), `POST /api/waitlist`, and the SPA. Implement via **either** a separate minimal public FastAPI app mounting only those routes, **or** an allowlist reverse-proxy — consistent with ADR-034's separate-instance isolation pattern. Read-only, token-scoped, rate-limited, no IndrasNet reachable, with an egress/path-isolation test as a precondition.

**D3 — Privacy scope v1 is participant-only, full fidelity (tier T0).**
The recipient was in the conversation, so they see everything — no redaction. The share token is single-conversation. Broader sharing (onward forwarding, redaction tiers per the IndrasNet T0–T4 model) is deferred.

**D4 — The waitlist is a demand + willingness-to-pay instrument.**
At `threads.adityaarpitha.com`, "join the beta" captures: email, **which features they want**, and **what they'd pay**. This data — not the author's guess — prioritizes everything after the wedge. The roadmap becomes demand-driven; we stop proposing slice N+1 and read it off the responses.

**D5 — First artifact scope: gmaps navigation first.**
Ship the navigable map (H2 flags + tier summaries) before the argument-structure layer (claims / Walton schemes / critical questions). Argument structure is the first *enrichment* once the wedge is live and the waitlist signals demand.

**D6 — Near-term durable record is LCT Postgres (live cache); IndrasNet archive deferred.**
Per the chosen architecture, IndrasNet's append-only reprocessing archive is the eventual record of record, but the wedge does not require it. LCT Postgres holds the graph for now. (Tension: `persist_graph` is currently destructive — see Constraints; the append-only/versioned migration is future work that the IndrasNet handoff will force.)

**D7 — Audio in shares is opt-in, default-off, participant-consented.**
The existing share path returns a signed `audio_url` and streams the recording (`share_api.py:505-518`, `:522-567`). Shared audio is **biometric voice data** of both participants — it must not be exposed by default. v1: the shared artifact is graph + transcript only; audio is an explicit per-share opt-in that requires participant consent. The path-isolated surface (D2) only mounts `/api/share/{token}/audio` when audio sharing is enabled for that token.

## Non-Goals (explicitly deferred)

- **Live IndrasNet→LCT context fetch** (worldview-drift / equivocation detection during a conversation). This was 036's original reservation; deferred to a future ADR + IndrasNet ADR-050.
- **LCT→IndrasNet graph handoff** into the ADR-026 reprocessing archive. Future.
- **Argument-structure / fallacy / fact-check layer.** Future enrichment, demand-permitting.
- **Broader-than-participant sharing + redaction tiers.** Future.

## Positions Considered

- **Share mechanism:** static self-contained export (max privacy, weak email capture) vs **Tailscale Funnel hosted link** (chosen — supports inline waitlist, matches self-host) vs public-tier VPS (cleanest isolation, most infra up front).
- **First scope:** ship current graph as-is (fast, but zoom-out flag-blind) vs **gmaps-first H2 + summaries** (chosen) vs argument-structure-first (richest, slowest).
- **Privacy:** **participant-only/T0** (chosen, simplest, matches closed beta) vs participant+invitees vs link-anyone-redacted.

## Consequences

**Positive:** shippable in a few slices; minimal IndrasNet coupling; a built-in growth + product-discovery loop; demand-driven prioritization; reuses the authored hierarchy + the H2 fix.

**Risks / costs:**
- **Funnel exposes the owner's box to the public internet.** Mitigations: read-only endpoints only, opaque per-conversation share token, rate limiting, no IndrasNet reachability from that surface, and an explicit egress-guard test that the share path honors the isolation boundary.
- **Share-token security** (guessability, revocation) must be designed (long random token; revocable; optional expiry).
- **Artifact quality depends on extraction** — acceptable because it's reprocessable (D6 / ADR-026), but the gmaps experience needs H2 verified end-to-end on a *consolidated* conversation (pending).
- **Destructive `persist_graph`** conflicts with the reprocessability principle; tolerated for the wedge, flagged for the handoff work.

## Constraints (grounded in the codebase audit)

1. The share/Funnel surface MUST NOT reach IndrasNet or any owner data beyond the single shared conversation; it is read-only and token-scoped (composes with ADR-034 D2/D6 owner RLS).
2. If any enrichment that calls IndrasNet is later added to this surface, it MUST gate on `indrasnet_enabled()` and is forbidden on the public/shared exposure.
3. The waitlist endpoint stores only what the user submits (email, feature wants, WTP); it is owner-readable for roadmap analysis; it is not an auth surface.
4. End-to-end H2 verification on a conversation long enough to consolidate (≥ topic threshold) is a precondition for "shareable" — confirm tier nodes carry `is_tangent`/`is_crux` in the DB and render at zoom-out.
5. Tailscale Funnel = public internet exposure; pair with read-only + token + rate-limit + no-write + no-IndrasNet, and an egress-chokepoint test.

## Current state (frontend recon 2026-06-05)

Most of the wedge already exists — slice 1 is hardening + verification, not greenfield:
- **gmaps view exists:** ReactFlow, 5 semantic levels, 3 zoom thresholds, drilldown stack, locked-level mode (`MinimalGraph.jsx`); tangent/crux/bookmark markers render (`ConversationNode.jsx:14-17,42-72`).
- **Share system exists:** mint/serve/revoke/list + OAuth + email allowlist + expiry + view tracking + signed audio (`share_api.py`, `ShareConversation.jsx`, `ShareManagerModal.jsx`, route `/share/:token`).
- **Net-new:** the waitlist (features + WTP). `BetaGate.jsx` is only a backend-reachability gate.
- **Open question:** zoom-out may render client-side clusters (`graphClustering.jsx`) instead of the backend authored tiers (ADR-021). If so, the H2-propagated flags + tier summaries on the authored topics/themes/arcs never surface. Slice 1 verification must confirm the zoomed-out view consumes the authored hierarchy.

## Known issues to fix (Codex review)

- `ShareManagerModal.jsx` uses raw `fetch` for create/list/revoke instead of `apiFetch`/`apiHeaders` — owner share-management breaks under an `AUTH_TOKEN` deployment.
- `ShareConversation.jsx` passes `visibleGraphLevel`/`setVisibleGraphLevel` to `MinimalGraph`, which only accepts `onVisibleLevelChange` (`:1566-1598`) — the shared timeline doesn't filter to the visible tier (owner view wires it correctly in `ViewConversation.jsx`).

## Implementation sketch (slices)

1. **H2 — persistence fix landed; end-to-end verification is a GATE.** `propagate_flags_upward` runs at persist (`graph_persistence.py:373-379`); consolidation still omits flags when building parents (`hierarchy_consolidator.py:143-167`) but persist recomputes from children. **Not yet proven on a consolidated conversation** (only sample telemetry has 1 chunk, no tiers). Gate before "shareable": run a conversation long enough to consolidate, confirm L3-5 nodes carry `is_tangent`/`is_crux` + summaries in the DB AND render at zoom-out.
2. **gmaps view** — reuse `MinimalGraph`; fix the `ShareConversation` tier-callback prop mismatch; resolve the authored-tiers-vs-client-clustering question; add an E2E screenshot test for `/share/:token`.
3. **Path-isolated public surface** — separate minimal public app (or allowlist proxy) exposing ONLY `GET /api/share/{token}`, optional `GET /api/share/{token}/audio` (D7, default-off), `POST /api/waitlist`, SPA. Default-on expiry; test no IndrasNet reachable; egress/path-isolation test.
4. **Waitlist** — `waitlist_submissions` table (email, feature choices, WTP amount/range + currency, source share token, free-text note, consent timestamp, IP/UA hash); public POST only; owner-authenticated list/export; rate-limit + honeypot/CAPTCHA before Funnel; frontend modal extending `BetaGate.jsx`.
5. **Verify** — share a real artifact with a real participant; collect first waitlist responses.

**Deployment-plan approval (per Codex):** this ADR is approvable as a *concept*; the *deployment* is gated on D2 path-isolation + D7 audio defaults + waitlist storage/abuse-controls + the H2 verification gate all being satisfied.

## Related

- docs/ADR_GRAPH_DATAMODEL_CONSISTENCY_2026-06-05.md (H2 and the follow-ups this wedge depends on)
- ADR-021, ADR-031, ADR-032, ADR-033, ADR-034, ADR-035
- IndrasNet ADR-026 / ADR-017 / ADR-009 (the deferred reprocessing + retrieval + privacy infra)

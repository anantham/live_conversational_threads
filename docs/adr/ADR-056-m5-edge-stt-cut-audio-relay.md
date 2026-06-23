---
Date: 2026-06-23
Status: **Proposed — design for review.** Nothing built yet. (ADR number provisional — 040/050/055 are taken on branches; renumber on merge.)
Group: Infra / Fleet topology / Live STT latency
Related: ADR-050 (fleet capability heartbeat + lease — the M5 as an AI-services node); ADR-040 (backend port ownership & restart authority — why we DON'T make the M5 a second :43181 manager); ADR-034 (egress chokepoint — the audio egress gate the client-direct path must still honor); PR #83 (diarization shape fix on the backend→M5 relay path — interacts with this).
---

# ADR-056: M5 Edge STT — cut the audio relay by moving live STT to the M5

> Live audio currently round-trips **mobile → Asus → M5 → Asus → mobile**: the phone streams audio over WSS to the Asus backend (`/ws/transcripts`), which **relays** the audio to the M5's STT and back. Since the M5 already does the heavy STT compute, the relay is pure overhead. This ADR moves the live STT *entry point* to the M5 — as an **opportunistic edge accelerator**, not a second backend — while the always-on Asus stays the single authority (DB, graph, workers).

## Issue
Audio latency is dominated by network round-trips, and one of them is avoidable. For each utterance the **raw audio** crosses the network ~twice before any transcript exists: phone→Asus, then Asus→M5. The M5 is *downstream* of the Asus, so the heavy payload makes an extra internal hop and waits on Asus orchestration before responding.

## Context — grounded in the live system (2026-06-23)
**Prod frontend config** (read from the inlined values in the live `threads.adityaarpitha.com` bundle, since the `VITE_*` env is Vercel build-time only — not on disk):
- Backend base = `https://asus-strix-scar.tail4741ad.ts.net` (the Asus over **Tailscale Serve HTTPS**). Live audio → `wss://asus-strix-scar.tail4741ad.ts.net/ws/transcripts`.
- Active STT provider = **`parakeet`** (`VITE_DEFAULT_STT_PROVIDER` not overridden).
- All **client-side STT URLs are dev-localhost** (`ws://localhost:43001/stream`, `http://localhost:5092/...`) and the whisper one is the plain-HTTP Asus default (`http://100.81.65.74:7777/api/transcribe`, mixed-content-blocked from the HTTPS site). So the client-side STT lane exists in code but is **unused in prod**.
- `adityas-macbook-pro` appears **0 times** — the frontend never contacts the M5.

**Therefore prod uses the *backend-orchestrated* STT path:** the phone streams audio over WSS to the Asus `/ws/transcripts`; the Asus relays the audio to the M5 STT (the `backend_http` transport — the same path PR #83 fixed diarization on) and returns transcripts/graph.

**Fleet role (ADR-050):** the M5 is an AI-services node — Ollama (`:11434`) + mlx-STT (`:5095`), autostarted, advertised to the Asus registry via `fleet-heartbeat`, with a `fleet-lease` broker. It is **not** an app backend and has **no production data** (only `lct_test.db`); the Asus owns Postgres (`localhost:5432`).

**Tailscale facts (measured):**
- The M5 already serves **HTTPS via Tailscale Serve** with valid MagicDNS certs (`adityas-macbook-pro.tail4741ad.ts.net`).
- M5 ↔ Asus: **direct, ~55 ms** each way (this is the relay leg removed by this change).
- M5 ↔ phone (`pixel-10-pro`): upgrades to **direct (LAN) ~139 ms**, falls to **DERP(blr) ~433 ms** when it can't go direct. So phone→M5 is direct when co-located, comparable to phone→Asus.

## Decision
Make the M5 the **opportunistic entry point for the live audio/STT leg only**, via **client-side STT** pointed at the M5's Tailscale-Serve HTTPS endpoint. The Asus remains the **single authority**: `/ws/transcripts`, Postgres, graph build, speaker materialization, and all background workers stay there. The flow becomes:

> mic → **M5 (Tailscale-Serve HTTPS → local STT)** → transcript → `/ws/transcripts` (Asus) → graph/DB/broadcast.

Audio never touches the Asus; only the small transcript does. **M5-first with automatic fallback** to today's backend-orchestrated path whenever the M5 is unreachable (laptop asleep, phone remote on DERP).

This is deliberately **not** "run LCT on the M5": no M5 app backend, no shared DB, no background workers on the M5 — so none of the double-singleton / port-ownership (ADR-040) / laptop-as-primary hazards apply. The M5 stays a stateless audio→transcript box.

## Implementation (phased; each phase independently shippable)

**Phase 0 — Expose M5 STT over Tailscale-Serve HTTPS (live-safe, reversible).**
Add a Serve route on the M5 mapping an HTTPS endpoint on `adityas-macbook-pro.tail4741ad.ts.net` → `http://127.0.0.1:5095`. Verify a browser-reachable HTTPS transcription call. (The existing `:8443→8001` route is dead and can be reclaimed; `:443→8765` is in use — use a distinct port/path.)

**Phase 1 — Frontend: client-side STT against the M5, behind a flag, with fallback.** Two options:
- **(a) HTTP-chunk client mode (recommended — no new M5 server).** Point the active provider's HTTP STT URL at the M5 Serve endpoint (the M5 already serves the OpenAI `/v1/audio/transcriptions` shape on `:5095`). Reconcile the path (`/api/transcribe` vs `/v1/audio/transcriptions`) in Serve or config. The browser chunks audio → M5 → transcript → `/ws/transcripts`.
- **(b) Streaming-WS shim on the M5.** Run a small WS server on the M5 speaking the frontend's `/stream` protocol (what `parakeet`/`senko` use) in front of mlx-whisper. Lower per-utterance latency than chunked HTTP, but it's a new component to build + supervise.

Gate behind a frontend flag (e.g. `VITE_STT_EDGE_M5` + the M5 URL) and **fall back to the current `/ws/transcripts` backend-orchestrated path** on any M5 timeout/error, so a sleeping laptop or remote phone degrades gracefully rather than stalling capture.

**Phase 2 — Diarization on the client-direct path.** PR #83 fixed diarization for the *backend→M5* relay. Client-direct must instead have the **frontend** request `diarize`/`include_embeddings` from the M5, and `/ws/transcripts` must accept client-provided speaker tags + ECAPA embeddings. Verify/extend that ingestion path.

**Phase 3 — Reliability.** `mlx-stt` already autostarts the STT engine at login; ensure the Serve route persists across reboot (Serve config or a tiny LaunchAgent), and that fallback is fast (sub-second health gate) given the M5 is a laptop.

## Consequences
- **Win:** removes the ~55 ms×2 internal relay + the Asus orchestration hop from every utterance, with no phone-side penalty (phone→M5 ≈ phone→Asus when co-located). Real but **modest** — the phone↔server leg (139 ms direct / 433 ms DERP) remains the latency floor, especially when the phone is remote.
- **Cost:** the M5 is a **laptop** (sleeps, moves networks, battery) — it cannot be *primary* without fast automatic fallback to the always-on Asus. Fallback UX is the main risk.
- **Mixed-content constraint:** the M5 endpoint **must** be HTTPS/WSS via Tailscale Serve (a `*.ts.net` name + cert) — a raw `http://100.x` IP is blocked by the HTTPS frontend and gives no latency benefit anyway (same WireGuard tunnel).
- **No new authority:** because the Asus stays the sole backend/DB/worker owner, this introduces none of ADR-040's ownership/restart-storm surface and no double-processing.

## Alternatives considered
- **Run the full LCT backend on the M5 (shared Asus Postgres), symmetric M5-or-Asus fallback.** Rejected: shared DB couples the M5 to the Asus anyway (not an independent fallback) and adds ~55 ms/query from the M5; both backends would run the background singletons → double side-effects (Beeper double-sends, double-embeds); reintroduces ADR-040 ownership concerns; makes a laptop a co-primary.
- **Point the client at a raw Tailscale IP.** Rejected: mixed-content-blocked on the HTTPS frontend; WSS needs a cert; no latency benefit over the MagicDNS name.
- **Leave it as-is (backend-orchestrated relay).** The status quo; acceptable if the relay leg proves negligible vs the phone↔server leg in practice — measure before investing in Phase 1(b).

## Open questions (resolve before Phase 1 build)
1. Which client-side transport the frontend supports cleanly for *live* (chunked) capture — HTTP-chunk (1a) vs a `/stream` WS the M5 must learn to speak (1b)?
2. Does `/ws/transcripts` already accept client-produced transcripts (with speaker/embedding fields), or is that new ingestion?
3. Exact path/shape reconcile between the frontend's STT call and the M5's `/v1/audio/transcriptions`.

## Validation already done
Prod config read from the live bundle; M5↔phone and M5↔Asus links measured via `tailscale ping`; M5 Tailscale-Serve HTTPS + certs confirmed; M5 STT diarization+embeddings confirmed working (PR #83). The remaining unknowns above are frontend-capture details, not topology.

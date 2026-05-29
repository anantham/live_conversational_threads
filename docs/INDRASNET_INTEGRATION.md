# LCT ↔ IndrasNet Integration

**Status:** living doc · **Last updated:** 2026-05-29
**Audience:** anyone running or reading LCT who needs to understand what IndrasNet is, why LCT talks to it, and what happens when it isn't there.

---

## TL;DR

**LCT is a public, self-contained repo. IndrasNet is a private, personal system.** LCT must build and run *without* IndrasNet. IndrasNet is an **optional external peer**, reached over Tailscale at a URL kept in local `.env` (never committed). When it's present it makes LCT richer; when it's absent LCT degrades gracefully and says so.

The relationship has **three dimensions**:

1. **Compute** — IndrasNet brokers GPU/inference across a Tailscale device fleet (M5 Pro, M2 Air, RTX box). LCT can offload STT/LLM work to it.
2. **Data in** — LCT pulls *context* from IndrasNet's knowledge fabric (retrieval results, contacts, a contact's pending discussions) to enrich the conversation graph.
3. **Prayers out** — LCT captures **prayers** (pre-formal intentions) and feeds them back toward IndrasNet's corpus, closing a learning loop.

> **Why this isn't a code dependency.** LCT never imports IndrasNet code. Every interaction is an HTTP call to a configurable endpoint. The public repo ships with the endpoint unset/local-default, so a stranger who clones LCT just runs local-only and never sees the private topology. See [Configuration](#configuration).

---

## Architectural framing: LCT is one case of a general modality problem

LCT specializes a general pattern:

```
ingest a modality → align it to a timeline → structure it into meaning
   (audio/video/text)      (segments + speakers)    (entities → relations → levels)
```

LCT's instance of that pattern is **conversation → utterances → nodes → threads/cruxes/zoom-levels**. The front half (modality → timeline-aligned segments) is generic; the back half (segments → conversation graph) is LCT's domain specialization.

IndrasNet sits *underneath and beside* LCT in the four-layer stack from [`VISION.md`](VISION.md):

```
Layer 0  CONVERSATION           ← LCT captures here; "prayers emerge here"
Layer 1  THREADS                ← LCT: prayers + context, tracked across sessions
Layer 2  JUST-IN-TIME FORMALISM ← LCT: candidate formal statements
Layer 3  FORMAL BACKBONE        ← IndrasNet + external verification
Layer 4  FEEDBACK               ← verified signals flow back into BOTH systems
```

> *"The highest-leverage intervention is not faster note-taking or better summaries. It is lowering the loss rate of pre-formal intention."* — VISION.md

So LCT is the **conversation specialization** that both *feeds* (prayers) and *reads from* (retrieval/compute) IndrasNet's shared **knowledge + compute fabric**. They learn from each other through a shared **protocol and compute fabric — not a shared codebase.**

---

## The three connections

```
                         ┌────────────────────────────────────────────┐
                         │  IndrasNet  (private; Tailscale 100.81.65.74)│
                         │  GPU broker over fleet: M5 Pro · M2 Air · RTX│
                         │  knowledge fabric: retrieval + Obsidian vault│
                         └────────────────────────────────────────────┘
   ┌───────────── COMPUTE (offload) ─────────────┐   ▲ prayers-out      │ data-in
   │  STT (whisper :7777) · LLM (LM Studio :1234) │   │ (Layer 1→3)      ▼ (enrich)
   ▼                                              │   │                  
 ┌──────────────────────────────────────── LCT (public, self-contained) ──────────┐
 │  own on-device STT/diar backends + optional "remote" backend → IndrasNet compute │
 │  prayers/intent-signals (ADR-013)  ·  semantic-edge enrichment (ADR-032 Part E)  │
 │  consumption-prayer "show agenda" (ADR-033)  ·  contacts picker + cache          │
 └──────────────────────────────────────────────────────────────────────────────┘
```

### 1. Compute — IndrasNet as GPU/inference broker

IndrasNet schedules compute across the Tailscale fleet with a **GPU priority policy** ([ADR-024](adr/ADR-024-indrasnet-gpu-priority-policy-and-live-stt-hard-preemption.md)): live STT is the only workflow allowed to *hard-preempt* lower-priority work. LCT uses this two ways:

- **STT offload** — the upload/live STT path can route to IndrasNet's WhisperX orchestrator at `…:7777/api/transcribe` (see `services/stt_config.py`, `stt_http_transcriber.py`). *Caveat:* the remote orchestrator currently runs ~4× slower than real-time (see `ISSUES.md`), which is why **LCT's own on-device backends (whisper.cpp/Metal, parakeet-mlx) are the real-time primary** and IndrasNet compute is the heavy/fallback tier.
- **LLM offload** — graph generation can point at IndrasNet-fronted LM Studio at `…:1234/v1` (`LOCAL_LLM_BASE_URL`).
- **Supervision (opt-in)** — on the GPU host, LCT's backend can run as a peer agent under IndrasNet's `start_all.py` supervisor (`ENABLE_LCT_BACKEND=1`); see [`SUPERVISION.md`](SUPERVISION.md). Off by default; LCT runs standalone elsewhere.

> The clean mental model: **LCT asks IndrasNet for compute; LCT never manages the hardware.** Local-first, fleet-optional.

### 2. Data in — enrichment, contacts, pending discussions

| What LCT pulls | Endpoint | Used for | Code |
|---|---|---|---|
| **Retrieval context** (ranked prior conversations / shared jargon / argument history with `why_relevant`) | `POST /api/retrieval/search` | injected into the semantic-edge enrichment LLM (ADR-032 Part E) | `services/indrasnet_client.py`, `services/edge_enrichment.py` |
| **Contacts** (display name, recent activity, `external_llm_ok` flag) | `GET /api/contacts` | participant picker + agenda auto-expand; cached locally (`services/contacts_cache.py`) due to IndrasNet latency | `consumption_prayer_api.py` |
| **Pending discussions** for a contact (their Obsidian `## Pending discussions` parsed to items) | `GET /api/contacts/{contact_ref}/pending-discussions` | the "Show agenda with [contact]" consumption-prayer chip/drawer (ADR-033) | `indrasnet_client.py`, `consumption_match_runner.py` |

### 3. Prayers out — LCT feeds the corpus

A **prayer** = a pre-formal intention. In the data model it's an **intent signal** ([ADR-013](adr/ADR-013-intent-signals-prayers-schema.md)): `raw_text`, `context_window`, `detection_confidence` (≥0.6 to persist), lifecycle `active → accumulating → ready → formalized | abandoned`. ("prayer" is the user-facing word; "intent signal" is the DB term.)

- **Today:** LCT detects + persists prayers locally (`intent_signals` / `intent_signal_sightings`, `services/intent_signal_persistence.py`) and reads IndrasNet's prayer corpus via consumption matching (above).
- **The loop (partly implemented, partly intended):** when a confirmed *Remind/Connect* prayer is approved, it lands as a bullet under a contact's `## Pending discussions` in IndrasNet's Obsidian vault — so a prayer captured in one conversation surfaces as agenda in the next. The **active-learning write-back** (confirmed enrichment / edge corrections → IndrasNet's `trail_index` reranker) is **aspirational/deferred** (VISION addendum; ADR-032 future work).

---

## Configuration

All IndrasNet coupling is **runtime config, kept in local `.env` (gitignored), never committed.** Public-repo-safe defaults mean LCT works with IndrasNet absent.

| Env var | Default | Purpose |
|---|---|---|
| `INDRASNET_BASE_URL` | `http://100.81.65.74:7777` | the live Tailscale instance (your fleet); set empty/localhost to disable |
| `INDRASNET_MATCH_TIMEOUT_SECONDS` | `5` | prayer/consumption match |
| `INDRASNET_CONTACTS_TIMEOUT_SECONDS` | `15` | contacts fetch (+ background refresh) |
| `INDRASNET_RETRIEVAL_TIMEOUT_SECONDS` | `10` | enrichment retrieval |
| `DEFAULT_STT_WHISPER_HTTP_URL` | `…:7777/api/transcribe` | STT offload target |
| `LOCAL_LLM_BASE_URL` | `…:1234` | LLM offload target |
| `AGENDA_QUERY_DETECTOR_ENABLED` | `false` | auto consumption-prayer detection (manual works regardless) |
| `ENABLE_LCT_BACKEND` | unset | run LCT under IndrasNet's supervisor (GPU-host only) |

---

## Privacy gate (mandatory)

IndrasNet contacts carry an `external_llm_ok` flag. **LCT MUST filter retrieval items by this flag before passing any of them to a *remote* LLM** (`edge_enrichment.py` `_extract_item_participants`). Local-LLM paths bypass the check (data never leaves owned hardware). This is the seam that lets the shared corpus be useful without leaking a private contact's material to a cloud model.

---

## Failure modes — graceful degradation

LCT must never hard-fail because IndrasNet is down, and (per AGENTS.md §Error Logging) must **never silently hide** a failure:

- **Retrieval unreachable** → proceed with enrichment minus context; surface banner *"enriching without IndrasNet context — service unreachable"*; log it.
- **Contacts unreachable** → picker shows empty/cached list; cold cache triggers a background refresh.
- **Pending-discussions 502/404** → consumption chip stays idle on the manual path; auto-detect swallows the error (logged, not propagated to the live task).
- **STT/LLM offload unreachable** → fall back to on-device backends (the whole point of LCT being self-contained).

---

## Related documents

- [`VISION.md`](VISION.md) — four-layer stack, prayers, feedback loop, the general modality framing.
- [ADR-013](adr/ADR-013-intent-signals-prayers-schema.md) — intent-signal/prayer schema & lifecycle.
- [ADR-024](adr/ADR-024-indrasnet-gpu-priority-policy-and-live-stt-hard-preemption.md) — IndrasNet GPU priority / live-STT hard-preemption (the compute *policy*).
- [ADR-032](adr/ADR-032-temporal-swim-lane-layout-and-semantic-edges.md) Part E — retrieval enrichment + privacy gate + failure modes.
- [ADR-033](adr/ADR-033-consumption-prayer-matching.md) — consumption-prayer matching (manual + auto).
- [`SUPERVISION.md`](SUPERVISION.md) — opt-in peer-agent launch under IndrasNet's supervisor.
- `services/indrasnet_client.py` — the single HTTP client for all IndrasNet calls.

---

## Status & open loops

| Connection | Status |
|---|---|
| Retrieval enrichment (`/api/retrieval/search`) | implemented |
| Contacts + cache, pending-discussions, consumption-prayer (manual) | implemented |
| Consumption-prayer (auto-detect) | implemented, feature-flagged **off** |
| STT/LLM compute offload | implemented (on-device is primary; IndrasNet is heavy/fallback) |
| Peer supervision (`start_all.py`) | implemented, opt-in |
| `POST /api/prayers/match` | built, **mothballed for MVP** (ADR-033) |
| Prayer write-back / active-learning feedback to `trail_index` | **aspirational (deferred v2)** |
| GPU workflow-class tagging from LCT's outbound calls | aspirational |

**Design rule going forward:** keep IndrasNet behind `services/indrasnet_client.py` and config — never a build-time dependency — so the public LCT repo stays self-contained and the private fabric stays optional.

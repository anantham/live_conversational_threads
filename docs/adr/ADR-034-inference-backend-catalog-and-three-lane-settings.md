# ADR-034: Inference Backend Catalog & Three-Lane Settings

- **Status:** Decided (2026-05-30) — implemented on branch `feat/e2e-audio-graph-zoom`, pending human review.
- **Group:** presentation + integration
- **Supersedes / amends:** none. Complements ADR-009 (provider-pluggable local *or* cloud), ADR-030 (LLM gateway / pipeline invariants).

## Issue

The home status chips and the Settings page reported inference state **shallowly and, in places, wrongly**:

1. Chips showed a generic provider name ("Whisper", "Local LM Studio") — never the **model**, nor **where it runs** (M5 ANE / M5 GPU-MLX / Tailscale RTX / cloud).
2. The number labelled "Latency" was the `/health` **ping round-trip** (~1 ms), not transcription/generation latency — actively misleading.
3. No **cost** and no **empirical** speed/accuracy were surfaced anywhere, despite a full on-device STT benchmark existing on disk (`.tmp/stt_bench`).
4. **Diarization had no UI at all** — it was env-gated (`STT_PARAKEET_PYANNOTE_ENABLED`) with no way to see or choose a backend.
5. The **LLM** lane had no empirical statistics of any kind (the user explicitly asked for "similar statistics for the LLM intelligence").
6. Settings was a flat stack of cards with no per-capability comparison and no way to see "which backends exist, how do they compare, are they online right now."

The product intent (ADR-009): local-first, provider-pluggable, **local *or* cloud, user's choice**, with the trade-offs visible so they can be chosen over time.

## Decision

Introduce a **backend catalog** as the single source of truth for inference backends across three capability lanes — **STT / Diarization / LLM** — and rebuild the Settings hero + home chips on top of it.

- **Seed + refine.** Static, benchmark-derived facts (model, runtime/location, empirical speed + accuracy, cost) live in a committed seed file; live per-backend telemetry (observed latency, sample count) is layered on at request time. The UI labels each number by source ("benchmark" vs "live · N samples").
- **Three independent lanes.** Each capability is chosen independently. Each backend renders as a card showing model · where-it-runs · speed (seed→observed) · accuracy · cost · live-probe dot · "make primary".
- **Server-side, SSRF-safe probing.** A single `POST /api/backend-catalog/probe {capability, id}` resolves the health URL from the seed/config server-side; the client only names an entry, never a URL.
- **Diarization becomes first-class** with its own config (`diarization_config` AppSetting), selectable primary (FluidAudio / Senko / pyannote), fallback order, and health-check. **FluidAudio is the chosen default** (ANE, ~28× realtime, emits speaker **embeddings** → enables voice enrollment / contact auto-labelling), even though its Swift sidecar is not yet bundled — the config stores the preference; availability is reported separately.
- **LLM gets symmetric statistics.** Live telemetry (tokens/sec, total ms, valid-JSON rate) is captured per provider in an append-only JSONL log and aggregated at `GET /api/settings/llm/telemetry`; a benchmark harness (`.tmp/llm_bench`) seeds baseline numbers + a graph-quality proxy.
- **Additive, not destructive.** The existing detailed cards (endpoints, fallback chains, API keys, speaker library) are preserved under an "Advanced" section; the lanes link to them. We did not rewrite the 645-line provider panels.

## Context

- 64 GB M5 Pro primary; RTX 3080 over Tailscale as a compute peer; cloud providers for users without strong local hardware. Local-first by default (ADR-009).
- A real on-device STT benchmark already existed (speed + relative WER vs `openai-whisper`) but was trapped in `.tmp` markdown/JSON, invisible in-app.
- STT telemetry is persisted in `TranscriptEvent`; LLM generation had **no** telemetry table.
- LCT is a **public** repo; private compute fabric (IndrasNet / TemporalCoordination) must stay behind config, never a build-time dependency. The seed file therefore contains **no secrets or private URLs**.

## Positions considered

1. **Patch the chips only** (show model/location, fix the latency label). Cheap, but leaves diarization invisible, no LLM stats, no comparison surface, no catalog — doesn't meet the "rethink the UI" ask.
2. **Catalog + accurate chips, defer the full UI** (staged). Lower risk, lands fast, but the user explicitly chose the full 3-lane UI in one go.
3. **Full 3-lane catalog-driven Settings + chips + diarization + LLM telemetry (chosen).** Most work, biggest review surface, but delivers the stated intent and the seed→refine telemetry loop.
4. **Backend does live health probing inside `GET /api/backend-catalog`.** Rejected — makes the catalog endpoint slow and couples display to network round-trips. Probing stays client-driven via a dedicated probe route.

## Argument

Option 3 was chosen because the catalog is the reusable substrate the user actually asked for ("see all the trade-offs, independently control each, probe if online"), and most of the cost is *surfacing data that already exists* (benchmark + telemetry) plus one new capability config (diarization). The seed-vs-live split keeps the numbers honest (we never present a ping as inference latency, or a benchmark figure as a live measurement). Additive layering over the existing cards avoids a risky rewrite of working provider panels.

## Implications

- **New backend:** `data/backend_catalog_seed.json` (committed), `services/backend_catalog.py`, `backend_catalog_api.py` (`GET /api/backend-catalog`, `POST /api/backend-catalog/probe`), `services/diarization_config.py` + `diarization_settings_service.py` + `diarization_api.py` (`/api/settings/diarization` GET/PUT/health-check), `services/llm_telemetry_service.py` (+ `GET /api/settings/llm/telemetry`), telemetry hooks in `local_llm_client.py`.
- **New frontend:** `services/backendCatalogApi.js`, `components/settings/useBackendCatalog.js`, `BackendCard.jsx`, `CapabilityLane.jsx`, `InferenceLanes.jsx`; `RuntimeSettingsPage.jsx` now leads with the lanes and groups the old cards under `#advanced-settings`; `ServiceStatus.jsx` chips enriched from the catalog + a third Diarization chip.
- **"Make primary" writes** load → merge → save the full settings object per capability, so partial updates never wipe other config.
- **Cost figures for cloud are approximate and dated** (`approximate: true`, `as_of`); local backends are `free_local`.
- **Triggers follow-up ADRs/work:** building the FluidAudio Swift diarization sidecar; wiring the chosen diarizer into the live path with contact-name mapping + voice enrollment (the embeddings story); true time-to-first-token for LLM needs token streaming.

## Consequences

- Users can now see, per backend: model, runtime location, empirical speed (benchmark seed → their observed median), accuracy (WER for STT; valid-graph-JSON for LLM), cost, and live online status — and switch the active backend per lane.
- The app keeps collecting data: every STT chunk and LLM generation refines the observed numbers shown.
- FluidAudio appears as the chosen-but-"planned" diarizer until its sidecar ships; the UI is honest about this rather than showing a false green.
- Seed cost/accuracy numbers are point-in-time; an after-action review should re-run the benchmarks and refresh the seed periodically.

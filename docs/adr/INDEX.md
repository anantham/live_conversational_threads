# Architecture Decision Records — Index

Last updated: 2026-06-01 (ADR-034 collision resolved: the inference-catalog ADR renumbered 034 → 037, leaving public-deployment as the sole ADR-034; ADR-021 collision still open — see note below)

| ADR | Title | Date | Status |
|-----|-------|------|--------|
| [ADR-001](ADR-001-google-meet-transcript-support.md) | Google Meet Transcript Support with Speaker Diarization | 2025-11-10 | Proposed |
| [ADR-002](ADR-002-hierarchical-coarse-graining.md) | Hierarchical Coarse-Graining for Multi-Scale Visualization | 2025-11-10 | Approved |
| [ADR-003](ADR-003-observability-and-storage-foundation.md) | Observability, Metrics, and Storage Baseline | 2025-11-11 | Proposed |
| [ADR-004](ADR-004-dual-view-architecture.md) | Dual-View Architecture for Conversation Visualization | 2025-11-11 | Approved |
| [ADR-005](ADR-005-prompts-configuration-system.md) | Externalized Prompts Configuration System | 2025-11-11 | Approved |
| [ADR-006](ADR-006-testing-strategy-quality-assurance.md) | Testing Strategy and Quality Assurance Framework | 2025-11-27 | Proposed |
| [ADR-007](ADR-007-system-invariants-data-integrity.md) | System Invariants and Data Integrity Rules | 2025-11-27 | Proposed |
| [ADR-008](ADR-008-local-stt-transcripts.md) | Local STT Ingestion with Append-Only Transcript Events | 2026-01-12 | Approved |
| [ADR-009](ADR-009-local-llm-defaults.md) | Local-First LLM Defaults with Optional Online Mode | 2026-01-12 | Proposed |
| [ADR-010](ADR-010-minimal-conversation-schema-and-pause-resume.md) | Minimal Conversation Schema for Pause/Resume and Thread Legibility | 2026-02-13 | Proposed |
| [ADR-011](ADR-011-minimal-live-conversation-ui.md) | Minimal Live Conversation UI Redesign | 2026-02-14 | Draft |
| [ADR-012](ADR-012-realtime-speaker-diarization-sidecar.md) | Real-Time Speaker Diarization Sidecar for Local Speech-to-Graph | 2026-02-10 | Proposed |
| [ADR-013](ADR-013-intent-signals-prayers-schema.md) | Intent Signals (Prayers) Schema and Layer 1→2 Formalization Bridge | 2026-03-05 | Approved |
| [ADR-014](ADR-014-stage-based-runtime-settings-and-explicit-live-fallback-order.md) | Stage-Based Runtime Settings and Explicit Live STT Fallback Order | 2026-03-13 | Approved |
| [ADR-015](ADR-015-settings-route-split-and-progressive-disclosure.md) | Settings Route Split and Progressive Disclosure | 2026-03-14 | Approved |
| [ADR-016](ADR-016-review-experience-mvp-thematic-zoom-series-cross-session-signals.md) | Review Experience MVP — Thematic Zoom Integration, Conversation Series, Cross-Session Intent Signal Linking | 2026-03-17 | Approved |
| [ADR-017](ADR-017-capability-oriented-live-runtime-pipeline.md) | Capability-Oriented Live Runtime Pipeline | 2026-03-19 | Approved |
| [ADR-018](ADR-018-edit-history-training-data-export.md) | Edit History Contracts and Training Data Export | 2026-03-19 | Proposed |
| [ADR-019](ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md) | Event-Sourced Transcript, Graph, and Artifact Materialization | 2026-03-20 | Approved |
| [ADR-020](ADR-020-session-scoped-openai-byok-for-stt-and-graph.md) | Session-Scoped OpenAI BYOK for Live/Import STT and Graph Generation | 2026-04-03 | Approved |
| [ADR-021](ADR-021-browser-local-draft-recovery.md) | Browser-Local Draft Recovery for Interrupted Conversation Sessions | 2026-04-03 | Approved |
| [ADR-021 ⚠](ADR-021-authored-four-level-conversation-hierarchy.md) | Authored Four-Level Conversation Hierarchy | 2026-04-13 | Approved |
| [ADR-022](ADR-022-checkpoint-aware-upload-retry-and-resume.md) | Checkpoint-Aware Upload Retry and Resume for Bulk Imports | 2026-04-03 | Approved |
| [ADR-023](ADR-023-orchestrated-live-whisper-websocket-and-async-diarization.md) | Orchestrated Live Whisper Websocket and Async Diarization | 2026-04-08 | Approved |
| [ADR-024](ADR-024-indrasnet-gpu-priority-policy-and-live-stt-hard-preemption.md) | IndrasNet GPU Priority Policy and Live-STT Hard Preemption | 2026-04-09 | Approved |
| [ADR-025](ADR-025-wsl-whisperx-launcher-ownership-and-line-ending-durability.md) | WSL WhisperX Launcher Ownership and Line-Ending Durability | 2026-04-09 | Approved |
| [ADR-026](ADR-026-two-phase-live-flush-contract.md) | Two-Phase Live Flush Contract for `/ws/transcripts` | 2026-04-09 | Approved |
| [ADR-027](ADR-027-prompt-manager-canonical-for-transcript-and-refinement-prompts.md) | PromptManager as the Canonical Runtime Source for Transcript and Refinement Prompts | 2026-04-13 | Approved |
| [ADR-028](ADR-028-session-state-model-and-ux-terminology.md) | Session State Model and UX Terminology for Live Conversations | 2026-04-14 | Approved |
| [ADR-029](ADR-029-usage-quota-and-rate-limiting.md) | Usage Quota and Rate Limiting for STT Services | 2026-04-14 | Proposed |
| [ADR-030](ADR-030-system-invariants-and-pipeline-standards.md) | System Invariants and Pipeline Standards | 2026-04-15 | Approved |
| [ADR-031](ADR-031-post-streaming-hierarchy-consolidation.md) | Post-Streaming Hierarchy Consolidation (Option A) | 2026-05-12 | Approved |
| [ADR-032](ADR-032-temporal-swim-lane-layout-and-semantic-edges.md) | Temporal Swim-Lane Layout + Semantic Edge Taxonomy + Enrichment Context | 2026-05-19 | Accepted |
| [ADR-033](ADR-033-consumption-prayer-matching.md) | Consumption Prayer Matching in the Live Conversation Path | 2026-05-24 | Accepted |
| [ADR-034](ADR-034-public-lct-deployment-tiered-isolation.md) | Public LCT Deployment — Tiered Access with an Isolated Public Instance | 2026-05-31 | Approved |
| [ADR-035](ADR-035-crux-detection.md) | Crux Detection | 2026-05-30 | Decided |
| [ADR-037](ADR-037-inference-backend-catalog-and-three-lane-settings.md) | Inference Backend Catalog & Three-Lane Settings | 2026-05-30 | Decided |
| [ADR-038](ADR-038-engine-agnostic-privacy-boundary.md) | Engine-Agnostic Privacy Boundary — shared redact/restore/leak-verify primitive enforced at the transport chokepoint | 2026-06-07 | Proposed |
| [ADR-060](ADR-060-serverless-byok-thin-proxy.md) | Serverless BYOK — Universal Access via a Thin Stateless OpenAI Proxy | 2026-07-01 | Proposed |

> **⚠ Index gap (ADR-039–059):** this index was last fully maintained 2026-06-01; ADR files 039 through 059 exist in `docs/adr/` but were never added here. ADR-060 is listed out of sequence, ahead of that gap, because it's the one being actively worked on — the gap itself is a pre-existing, separate cleanup task.
> **⚠ ADR-021 number collision:** two ADRs shipped as 021 — *Browser-Local Draft Recovery* (2026-04-03) and *Authored Four-Level Conversation Hierarchy* (2026-04-13). ADRs are immutable, so renumbering is a human decision; both are listed above until it's resolved.
> **ADR-034 number collision — RESOLVED (2026-06-01):** two ADRs had shipped as 034 — *Inference Backend Catalog & Three-Lane Settings* (2026-05-30, feat branch) and *Public LCT Deployment — Tiered Access* (2026-05-31, main). The catalog ADR was renumbered **034 → 037** (no ADR-036/037 file existed; 036 is reserved by ADR-032's future-work list); public-deployment keeps 034. Gap: there is no ADR-036 yet (reserved). Note ADR-037's "Decided (pending human review)" status still wants reconciliation with the index's standard vocabulary.

## Status Definitions

- **Proposed** — Under discussion, not yet committed to
- **Approved** — Accepted and implemented (or in implementation)
- **Accepted** — Synonym for Approved used by some later ADRs (e.g. ADR-032/033); decision is locked and built
- **Deprecated** — No longer relevant, superseded by another ADR
- **Superseded** — Replaced by a newer ADR (link to successor)

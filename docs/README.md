# docs/ — map of the documentation

41 docs accumulated here at research velocity; this index is how you find the one you
need. Newcomers: follow the reading path in [CONTRIBUTING.md](../CONTRIBUTING.md) first.

## Start here

| Doc | What it gives you |
|---|---|
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | The map: every backend router/service and frontend page, one file |
| [CONVENTIONS.md](CONVENTIONS.md) | Naming, patterns, style ground truth — read before writing code |
| [LOCAL_SETUP.md](LOCAL_SETUP.md) | Setup + daily startup runbook |
| [TESTING.md](TESTING.md) | Test suites, fixtures, DB harness, what to test vs not |
| [adr/INDEX.md](adr/INDEX.md) | Index of all Architecture Decision Records — the architecture lives here |

## Vision & product direction

- [VISION.md](VISION.md), [PRODUCT_VISION.md](PRODUCT_VISION.md) — the long-form version
  of the README's pre-formal-layer thesis (root `PRODUCT.md` is the design-register
  companion).
- [FEATURES.md](FEATURES.md) — feature inventory.
- [ROADMAP.md](ROADMAP.md), [FEATURE_ROADMAP.md](FEATURE_ROADMAP.md),
  [ROADMAP_ADVANCED_ANALYSIS.md](ROADMAP_ADVANCED_ANALYSIS.md),
  [ROADMAP_INSTRUMENTATION_METRICS.md](ROADMAP_INSTRUMENTATION_METRICS.md),
  [TIER_2_FEATURES.md](TIER_2_FEATURES.md) — priority queues from different eras;
  check dates before trusting any of them as *current* priority.

## Architecture & data

- [adr/](adr/) — Architecture Decision Records. The single most valuable directory for
  understanding *why* the system is shaped the way it is.
- [DATA_MODEL_V2.md](DATA_MODEL_V2.md) + [DATA_MODEL_V2_CORRECTIONS.md](DATA_MODEL_V2_CORRECTIONS.md) — DB schema overview.
- [API_DOCUMENTATION.md](API_DOCUMENTATION.md) — backend HTTP surface.
- [INDRASNET_INTEGRATION.md](INDRASNET_INTEGRATION.md) — the companion IndrasNet system
  (prayers/contacts/GPU coordination) and how LCT talks to it.
- [contracts/](contracts/) — cross-system data contracts.
- [design/](design/) — design docs for larger subsystems (e.g. audio storage).

## Feature deep-dives

[BIAS_DETECTION.md](BIAS_DETECTION.md) · [FRAME_DETECTION.md](FRAME_DETECTION.md) ·
[SIMULACRA_DETECTION.md](SIMULACRA_DETECTION.md) · [FEATURE_SIMULACRA_LEVELS.md](FEATURE_SIMULACRA_LEVELS.md) ·
[CLAIM_TAXONOMY_SYSTEM.md](CLAIM_TAXONOMY_SYSTEM.md) · [EDIT_HISTORY.md](EDIT_HISTORY.md) ·
[FEATURE_MULTILINGUAL_TRANSCRIPTION.md](FEATURE_MULTILINGUAL_TRANSCRIPTION.md) ·
[OBSIDIAN_CANVAS_INTEROP.md](OBSIDIAN_CANVAS_INTEROP.md) · [PERPLEXITY_INTEGRATION.md](PERPLEXITY_INTEGRATION.md) ·
[LOCAL_STT_SERVICES.md](LOCAL_STT_SERVICES.md) · [attendee-meeting-bot-setup.md](attendee-meeting-bot-setup.md) ·
[cost-dashboard-counterfactual-scoping.md](cost-dashboard-counterfactual-scoping.md) ·
[ui-state-map-live-session.md](ui-state-map-live-session.md)

## Ops & runbooks

- [SUPERVISION.md](SUPERVISION.md) — backend supervisor / process management.
- [MONITORING_SETUP.md](MONITORING_SETUP.md) — monitoring.
- [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) — deploy steps (see also the
  Deployment sections of [AGENTS.md](../AGENTS.md)).

## Working records (historical — audit before trusting)

These are **point-in-time snapshots**, not living docs. Experience in this repo says a
handover's "pending" list goes stale within a week; verify against current code and
`git log` before acting on anything here.

- [WORKLOG.md](WORKLOG.md) — the running session log (append-only, newest context at the end).
- [TECH_DEBT.md](TECH_DEBT.md) — refactor-candidate ledger.
- [handovers/](handovers/) — session handover snapshots.
- [plans/](plans/) — implementation plans, usually linked from an ADR or handover.
- [_pending_patches/](_pending_patches/) — parked patches awaiting a decision.
- [AUDIT_RATIONALITY_2026-05-30.md](AUDIT_RATIONALITY_2026-05-30.md),
  [ADR_GRAPH_DATAMODEL_CONSISTENCY_2026-06-05.md](ADR_GRAPH_DATAMODEL_CONSISTENCY_2026-06-05.md),
  [STT_ORCHESTRATION_OVERHEAD_RCA.md](STT_ORCHESTRATION_OVERHEAD_RCA.md) — dated audits/RCAs
  still referenced by live ADRs and code comments, so they stay at this level.
- [archive/](archive/) — dated docs whose useful life has ended (old milestones,
  superseded decision lists, dated benchmarks). Kept for the record, moved out of the way.

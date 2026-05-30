# ADR-035: Crux Detection

- **Status:** Decided (2026-05-30) — implemented on branch `feat/e2e-audio-graph-zoom`.
- **Group:** analysis / rationality primitives
- **Related:** ADR-013 (intent_signals / "prayers"), ADR-027 (PromptManager canonical), ADR-030 (LlmGateway / pipeline invariants), `docs/AUDIT_RATIONALITY_2026-05-30.md` (found `is_crux` was a dead flag).

## Issue

LCT's graph models a `Node.is_crux` flag, the backend serializes it (`conversation_reader.py:282`, `graph_query_service.py:65`, `conversations_api.py:505`), and the frontend has amber "crux" node styling (`MinimalGraph.jsx:218,235`, `ConversationNode.jsx:42-72`). But the 2026-05-30 audit found **no code ever sets `is_crux = True`** — there is no `crux_detector`, no crux prompt, no endpoint. The load-bearing-belief notion the product promises ("cruxes" as a first-class concept) was reduced to a dead boolean with orphaned read-plumbing and an unreachable render branch.

## Decision

Build a **crux detector** that completes this feature end-to-end:

1. **Graph-level, relational detection.** A crux is a *load-bearing* belief/claim — one where, if it changed, downstream positions would change — and often the pivot of (dis)agreement. That is inherently relational, so the detector makes **one LLM call over the whole conversation graph** (node names + summaries + the `agrees`/`disagrees`/`supports`/`contradicts` relationships), not a per-node loop like the bias/frame/simulacra detectors.
2. **Route through `LlmGateway`.** The detector calls `local_chat_json(config, …)` (which routes through `gateway().chat(capability=CHAT_JSON_OBJECT)`), respecting the user's configured LLM (e.g. local Ollama), capturing LLM telemetry (ADR-034), and applying capability-sensitive substitution policy. It does **not** call `anthropic` directly or hardcode a model — explicitly avoiding the ×5 copy-paste anti-pattern the audit flagged in the existing detectors.
3. **Persist via the existing flag + JSONB, no migration.** For each node, set `Node.is_crux` and store the rationale in `Node.display_preferences["crux"] = {reason, confidence, crux_type, analyzed_at}`. This reuses the already-serialized flag (so the amber UI lights up automatically) and persists the "why" without a schema change.
4. **On-demand endpoints**, mirroring the existing analysis surface: `POST /api/conversations/{id}/cruxes/analyze`, `GET /api/conversations/{id}/cruxes`, `GET /api/nodes/{id}/crux` (added to the already-mounted `analysis_api`).
5. **Prompt in the library** (ADR-027): a `crux_detection` entry in `prompts.json`, rendered via `PromptManager`.

`crux_type` taxonomy: `disagreement_pivot`, `load_bearing_assumption`, `value_crux`, `definitional_crux`, `empirical_crux`.

## Context

- The three existing rationality detectors (bias/frame/simulacra) are per-node, persist to dedicated tables, bypass the gateway, and hardcode `claude-3-5-sonnet-20241022`. We deliberately do **not** copy that shape; crux is relational, gateway-routed, and reuses the node flag.
- `is_crux` already flows end-to-end to the renderer, so the cheapest path to a *visible* feature is to produce the flag rather than build new UI.
- Cruxes are the foundation for the (still-absent) **double-crux** feature; this ADR is intentionally the smaller first step.

## Positions considered

1. **Per-node loop (mirror bias_detector).** Rejected — a crux is defined relative to other beliefs and the (dis)agreement structure; per-node-in-isolation misses the pivot relationships and costs N calls.
2. **New `CruxAnalysis` table (mirror BiasAnalysis).** Rejected for v1 — `is_crux` is a binary node attribute (not many-per-node like biases); a table + alembic migration is overkill. Reuse the flag + `display_preferences` JSONB for the rationale. (Revisit if cruxes need rich multi-row evidence.)
3. **Auto-run after every graph generation.** Rejected — adds latency + LLM cost to every conversation. On-demand (like the other detectors), with a possible `CRUX_DETECTION_AUTORUN` flag later.
4. **Direct provider call (match existing detectors).** Rejected — perpetuates the gateway-bypass / hardcoded-model debt. Use `local_chat_json` → gateway.

## Argument

Graph-level + gateway-routed + flag-reuse is the smallest correct slice that (a) makes a promised concept real and visible, (b) does it the *right* way the audit recommended (gateway, no hardcoded model), and (c) avoids a migration. Persisting the rationale in `display_preferences` is a pragmatic, reversible choice that can be promoted to a table if double-crux needs it.

## Implications

- **New:** `lct_python_backend/services/crux_detector.py`; `crux_detection` prompt in `prompts.json`; three routes in `analysis_api.py`; `tests/unit/test_crux_detector.py`.
- The detector's LLM calls appear in LLM telemetry (ADR-034) and the cost ledger automatically (gateway path).
- The frontend amber crux styling becomes reachable for the first time once `analyze` runs.
- **Triggers follow-ups:** a UI trigger / nav surface (the analysis pages are currently unlinked — see audit); optional auto-run flag; **double-crux** (pair cruxes across speakers) as its own ADR; possible promotion of crux rationale to a dedicated table.
- Discovered en route (logged in ISSUES): `bias_detector._analyze_node` reads `node.node_summary`/`node.keywords`, which don't exist on the `Node` model (fields are `summary`/`key_points`) — the crux detector uses the correct fields.

## Consequences

- Conversations gain real, persisted cruxes on demand; the dead `is_crux` flag and amber renderer become a working feature.
- Rationale lives in `display_preferences["crux"]`; consumers should read it there until/unless promoted to a table.
- After-action: review crux precision against human judgement on a few real conversations; tune the prompt; decide on auto-run + double-crux.

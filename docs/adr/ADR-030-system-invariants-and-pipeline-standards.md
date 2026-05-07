# ADR-030: System Invariants and Pipeline Standards

**Date:** 2026-05-06
**Status:** Approved (2026-05-06, Aditya — reviewed by Codex agent, redlined twice before approval)
**Group:** architecture (cross-cutting)
**Supersedes:**
- Implicit "browser-as-authority" persistence patterns (closed by ADR-019, codified here)
- ADR-002's frontend-inferred clustering as the primary hierarchy mechanism (superseded by ADR-021 + this ADR's emergent depth)
- The pre-existing 5-fixed-level hierarchy emitted by `services/hierarchical_themes/level_*` (superseded by emergent-depth model below)

**Related:**
- Adopts and extends ADR-007 system invariants
- Adopts ADR-019 event-sourced materialization as the canonical persistence model
- Adopts ADR-021 backend-authored four-level hierarchy (and makes it emergent rather than fixed)
- Adopts ADR-017 capability-oriented runtime stages
- Adopts ADR-013 prayer/intent_signal schema (frontend deferred — see §6)
- Adopts ADR-027 prompt-manager-canonical (extended to non-transcript prompts)
- Adopts ADR-028 reserved terminology discipline
- Sets prerequisite for ADR-031 (Prayer/IntentSignal frontend surfacing — to be drafted)

---

## Issue

This system has grown ~120 commits past its last cross-cutting principles ADR. Several patterns have drifted across components:

- **Live and import pipelines duplicate stages** with subtly different semantics (separate persistence functions, separate event protocols, partially-shared but separately-instantiated `TranscriptProcessor`s).
- **Two LLM provider configurations coexist** (`llm_config` legacy single-provider + `llm_providers` priority list); 8 detector services still route through the legacy path and cannot fail over.
- **The frontend's authored-hierarchy view is unreachable** because `graph_query_service.node_to_response_payload()` does not pass `semantic_level`/`semantic_type` to clients; `MinimalGraph.jsx` therefore always falls back to legacy clustering heuristics.
- **The hierarchy schema has 5 levels in code, 4 in ADR-021, 4 in the frontend, and inverted ordinal direction between backend and frontend** — drift from "1 generator + 4 clusterers" being interpreted as "5 semantic tiers."
- **Browser-side server-write paths still exist** (`useAutoSave.js` + `useAudioInputEffects.js` both write conversation state to the backend), conflicting with ADR-019's "backend-owned semantic persistence" principle.
- **LM Studio silently substitutes models** (requested `qwen3-32b` → response `qwen/qwen3-vl-8b`) and the actual response model is never extracted; cost tracking, telemetry, and `backend_label` propagate the *requested* model name.
- **The draft-graph protocol exists in the live backend** (`_maybe_emit_draft_graph_patch`, `__graphLayer === "draft"`) but is not visually distinguished in `MinimalGraph.jsx`, where `NODE_TYPES = {}` (no custom renderer) means draft nodes look identical to stable ones.
- **Hierarchy depth is fixed at 5** for all conversations, regardless of complexity. A 24-second clip and a 90-minute conversation both run all 5 LLM clustering passes.

This ADR consolidates the principles that should govern these surfaces and specifies concrete decisions that resolve each drift.

---

## Context

The system's vision (`docs/VISION.md`) is to preserve the pre-formal layer of human intellectual work through real-time conversation mapping. To deliver this credibly, the architecture must be:

1. **Honest about what is evidence vs. what is interpretation** — to support replay, regeneration, and human override.
2. **Provider-agnostic at internal boundaries** — to absorb future model/provider shifts without rewriting business logic.
3. **Single-pipeline-multi-transport** — so every product feature lands once and works everywhere (live, import, future API).
4. **Visually legible** — so the graph speaks through visual weight (ADR-011) rather than chrome.
5. **Emergent in complexity** — adding abstraction layers as the conversation earns them, not by fixed schedule.

Earlier ADRs each captured part of this. This ADR consolidates them into seven enforceable principles and ten concrete decisions, and establishes the migration sequence.

---

## Decisions — Seven principles

### P1. Event-sourced, immutable evidence is the source of truth

Adopted from ADR-019. Generalized:

- **Audio, raw STT events, diarization segments, and intent_signal sightings are append-only.** They are never overwritten.
- **All other state — `nodes`, `relationships`, `clusters`, `claims`, `frame_analysis`, `bias_analysis`, `simulacra_analysis`, `intent_signals` (the canonical record vs. its sightings), thematic levels — is a materialization of evidence + LLM derivation.** It can be regenerated.
- **The browser does not own semantic persistence.** Browser-side state is a presentation cache; the canonical materialization happens on the backend.

**Concrete commitment:** any code path that writes derived state directly from the browser must be removed in post-approval Step 1 (D6) before any later architecture work proceeds. Approval of this ADR does not require the cleanup to land first; it does require the cleanup to land before D3/D4/D5/etc. begin.

### P2. Two-layer separation: facts vs. interpretation

Adopted from ADR-010. Generalized:

- **Fact layer (immutable):** `utterances`, `transcript_events`, `speaker_segments`, `intent_signal_sightings`, raw audio.
- **Interpretation layer (revisable, derivable):** `nodes`, `relationships`, `clusters`, `claims`, all `*_analysis` tables.
- **Failures in the interpretation layer never block fact-layer writes.** A failed LLM graph generation does not prevent transcript persistence; a failed thematic cluster does not prevent node materialization.
- **Every interpretation-layer record carries provenance** (provider, model, prompt version, confidence). Adopted from ADR-019.

### P3. Capability-oriented multi-stage pipeline

Adopted from ADR-017. Strengthened:

- **The conversation pipeline is one canonical sequence of stages, not two.** Live and import are *transports*, not pipelines.
- **Stages have stable names and event semantics:** `ingest → transcribe → segment → accumulate → generate_graph → refine → persist → unlock_hierarchy → analyze`. Each stage emits typed events (`stage_started`, `stage_completed`, `stage_failed`, plus stage-specific events).
- **Providers integrate via capability descriptors**, not by brand. A provider declares which stages it can serve (e.g., `supports_streaming_transcribe`, `supports_chat_completions`, `supports_embeddings`, `supports_diarization`).
- **Each stage's output is addressable** — written to `pipeline_artifacts` with a `stage`, `stage_index`, and `content_hash`. Failed stages emit visible errors, never silent skip.

### P4. Lossless hierarchy with emergent depth

Adopted from ADR-002 + ADR-007 (INV-1.3, INV-6.2) + ADR-021. Strengthened with emergent unlock:

- **The canonical hierarchy is four named tiers** plus an optional fifth tier for very long conversations. The most granular tier is "chunk"; the most abstract is "theme" (or "arc" if all five tiers are unlocked).
- **Naming convention is explicit and load-bearing:**
  - **`semantic_type` (per-node API value, singular):** `chunk` | `idea` | `topic` | `theme` | `arc`. This is the canonical enum that flows through API responses, DB writes, and pipeline events.
  - **Tab labels (UI display, plural):** `Chunks`, `Ideas`, `Topics`, `Themes`, `Arcs`. Pluralization is purely a presentation concern.
  - **`semantic_level` (per-node integer):** `1` (chunk, most granular) through `5` (arc, most abstract).
  - All references in code, prompts, events, and downstream ADRs must use the singular form for the value and the plural form only for tab labels.
- **Depth is emergent, not fixed.** A conversation has only the levels it has earned. Default is `chunks` only.
- **Unlock cascade** (each level both gated by count AND validated by LLM-judge):

  ```
  chunks > 5  →  evaluate  →  unlock ideas if LLM-judge says yes_cluster
  ideas  > 5  →  evaluate  →  unlock topics if yes_cluster
  topics > 5  →  evaluate  →  unlock themes if yes_cluster
  themes > 5  →  evaluate  →  unlock arcs   if yes_cluster
  ```

- **The LLM-judge is a single classification call** ("are these N items semantically diverse enough that grouping would clarify the conversation, or are they coherent enough that grouping would just be noise?").
- **Re-evaluation cadence (avoids permanent underfit).** The judge fires on every count-bucket boundary at the level below until the level is unlocked. Buckets are: 5, 7, 10, 15, 25, 40, 60, 100 (geometric-ish growth). At each bucket the judge is asked again with a content-hash of the level-below items as a cache key — if the content hasn't changed since last `not_yet`, no LLM call is made. Once any bucket returns `yes_cluster`, the level unlocks and re-evaluation stops.
- **Worked example:** a conversation that has 6 ideas all about the same topic gets `not_yet` at the 5-bucket. Conversation continues, ideas grow to 7 → judge re-runs, `not_yet`. At 10, judge runs again with new content hash → `yes_cluster` because diversity has emerged → topics tier unlocks. The previously-coherent state cannot trap the conversation in chunks-only forever.
- **Once unlocked, a level persists** for the lifetime of the conversation. Subsequent additions at the level below trigger incremental re-clustering, not unlock re-evaluation.
- **Aggregation is lossless** (ADR-007 INV-6.2): a level-N node's `utterance_ids` is the union of its children's `utterance_ids`.
- **Frontend tabs render only what exists.** A 30-second conversation shows only "chunks". A 90-minute conversation shows up to all five tabs.

### P5. Authored over inferred

Adopted from ADR-021. Generalized:

- **The LLM authors semantic levels, semantic types, claim relations, intent signals, and rhetorical pattern detections directly.** The frontend does not infer them via heuristics.
- **Every authored field flows through the API in its authored form.** `semantic_level`, `semantic_type`, `node_type`, `is_tangent`, `is_crux`, `is_bookmark`, `is_contextual_progress`, `dialogue_type`, `confidence`, `evidence_spans` — all surface in the response payload from `graph_query_service`.
- **Legacy frontend clustering heuristics (`buildTemporalChains`, `buildTopicCommunities`) are removed after a 60-day grace period.** During grace, they remain as fallback for conversations without authored hierarchy. After grace, conversations without authored hierarchy show only `chunks` (level 1).

### P6. Provider-agnostic routing at internal boundaries

Strengthened from implicit current state:

- **All LLM and embedding calls go through one provider gateway** with priority + fallback semantics.
- **No service knows the name of a provider** ("Modal", "LM Studio", "OpenAI") — only its capability descriptor.
- **The provider gateway is responsible for:** priority order, fallback on failure, response validation (including model-name fidelity), telemetry tagging.
- **Model substitution is recorded faithfully** — the actual model returned by the provider is what gets logged, regardless of what was requested. (Closes the LM Studio `qwen3-32b → qwen/qwen3-vl-8b` silent rewrite.)
- **Legacy single-provider services** (ClaimDetector, BiasDetector, ThematicAnalyzer, hierarchical clusterers) are migrated to the gateway via an adapter shim.

### P7. Backend-owned semantic persistence; browser is a view

Adopted from ADR-019. Codified explicitly:

- **The backend is the only writer of semantic state.** The frontend can request, edit, and display, but never directly persist canonical interpretation.
- **There is one explicit save path** from browser to backend per conversation lifecycle. Duplicate paths are removed.
- **Audio is part of the conversation lifecycle** — saved with the conversation, deleted with the conversation. Default `store_audio = true`. User can opt out via Settings ("Save audio recordings" toggle); per-session override possible for advanced users.

---

## Decisions — Specific architectural commitments

### D1. Audio retention

- **Default: `store_audio = true`.** Audio retained for the lifetime of the conversation and deleted with it.
- **Opt-out: Settings → "Save audio recordings" toggle** (off persists per user). Affects new conversations going forward.
- **Cloud upload of audio remains opt-in.** Local-first by default. Privacy posture preserved.
- **Retention storage warning** surfaces when total audio storage exceeds 5 GB, suggesting cleanup of old conversations.

### D2. Hierarchy: emergent depth with LLM-judged unlock

- **Names by role, not by number.** The bottom-most level is always `chunks`; the top-most level is `themes` (or `arcs` if the conversation is rich enough to unlock five tiers). Names compress upward as more levels exist.
- **Stop-condition cascade** as defined in P4.
- **Unlock event** flows over the live transport (WS) and import transport (SSE) as a typed event: `{type: "level_unlocked", level: N, semantic_type: "idea", node_count_at_unlock: 6}` (note `semantic_type` uses the singular value per the canonical enum above). Frontend renders the new tab with a subtle "new level" affordance.
- **User-initiated dismissal**: the user can dismiss/postpone unlocks without losing them. Tabs remain reachable from a "more views" affordance even if dismissed inline. (Preserves ambient UX per ADR-011.)
- **Implementation note**: the existing `services/hierarchical_themes/level_*_clusterer.py` modules become the *implementations* of the unlock evaluator, no longer auto-running for every conversation.

### D3. Pipeline unification: one pipeline package, two transports

- **`services/conversation_pipeline/`** (new package, NOT a single file) is the canonical orchestrator. Per the project modularity norm (300-LOC heuristic from `AGENTS.md`), the pipeline lands as a directory of small modules:

  ```
  services/conversation_pipeline/
  ├── __init__.py            # public exports
  ├── orchestrator.py        # ~150-200 LOC — wires stages in order
  ├── protocol.py            # ~50-80 LOC — Stage protocol/interface; PipelineEvent base
  ├── events.py              # ~100-150 LOC — typed event dataclasses (StageStarted, StageCompleted, StageFailed, TranscriptPartial, TranscriptFinal, NodeAdded, LevelUnlocked, etc.)
  ├── state.py               # ~80-150 LOC — PipelineState container (carries derived state across stages)
  └── stages/
      ├── ingest.py          # ~100-150 LOC
      ├── transcribe.py      # ~150-250 LOC
      ├── segment.py         # ~80-150 LOC
      ├── accumulate.py      # ~100-150 LOC
      ├── generate_graph.py  # ~150-250 LOC
      ├── refine.py          # ~100-200 LOC
      ├── persist.py         # ~150-200 LOC
      └── unlock_hierarchy.py # ~150-200 LOC
  ```

  No file in this package exceeds 300 LOC. If a stage grows beyond that, split it (e.g., `transcribe.py` could split into `transcribe_partial.py` + `transcribe_final.py`).

- **Stage protocol (sketch):**

  ```python
  # protocol.py
  class Stage(Protocol):
      name: str
      async def run(
          self,
          state: PipelineState,
          emit: Callable[[PipelineEvent], Awaitable[None]],
      ) -> None: ...
  ```

  Each stage reads from `state`, writes to `state`, and emits typed events via `emit`. No stage knows about transports.

- **Transport adapters:**
  - `LiveTransport` (was `stt_ws_session.py`, 2508 LOC) → ~250-400 LOC. Owns WebSocket connection, send queue, session lifecycle. Bridges WS messages ↔ `PipelineEvent`s.
  - `ImportTransport` (was `import_bulk_pipeline.py`, 1416 LOC) → ~250-400 LOC. Owns HTTP+SSE, checkpoint/resume, file decode. Bridges SSE messages ↔ `PipelineEvent`s.

- **Persistence:** `services/live_graph_persistence.py` + `services/import_persistence.py` → `services/graph_persistence.py` (one module, mode-agnostic, ≤300 LOC).

- **Why a package, not a 600-900 LOC orchestrator file:** the project's modularity norm (`AGENTS.md:13` "Files approaching ~300 LOC should be evaluated for decomposition") and the existing TECH_DEBT.md backlog of monolith regressions both make a new monolith unacceptable. Defining the stage interface up front means new stages (lull-detection, prayer-surfacing, fact-check) slot in without restructuring.

### D4. Node visual taxonomy (custom node renderer)

The frontend gains a custom `<ConversationNode>` React component (replacing the empty `NODE_TYPES = {}` in `MinimalGraph.jsx`). Visual variants encode the authored attributes from the backend payload:

| Attribute | Visual encoding |
|---|---|
| `semantic_type` (chunk/idea/topic/theme/arc) | Tier color (existing palette: teal/blue/indigo/purple/+ new) |
| Speaker (from `speaker_info.primary_speaker`) | Fill color tint (per `buildSpeakerColorMap`) |
| Temporal sequence | Border-color gradient ("rainbow as nodes arrive") |
| `__graphLayer === "draft"` | Dashed border + pulsing opacity (subtle pulse, not flash) |
| Stable (post-final) | Solid border, full opacity, settled position |
| `is_tangent === true` | Distinct shape — slanted/skewed rectangle, off-axis |
| `is_crux === true` | Heavier border + central glow accent |
| `is_bookmark === true` | Corner-fold marker (top-right) |
| `is_contextual_progress === true` | Forward-pointing arrow accent |

**Principle:** every visual variant corresponds to an authored attribute. No frontend heuristic creates visual distinction.

**Explicitly deferred:** lull-resume visual treatment (ADR-011's "unresolved threads pulse gently" promise) is not in this taxonomy. The future lull-detection ADR will add a backend-authored field (e.g., `is_lull_resume_candidate`) and the corresponding visual encoding once the detection stage exists. We do not paint a visual state without a canonical backend contract.

### D5. Provider gateway and model fidelity

- **One gateway:** `services/llm_gateway.py` (new), exposing `chat(messages, capability)`, `embed(text, capability)`, with priority+fallback over the `llm_providers` list.
- **Model fidelity:** `ProviderResult.model` is set from `response.json()["model"]`, not from the request payload. `backend_label` and cost telemetry use the response model.
- **Substitution policy is capability-sensitive**, not uniform across all calls:

  | Capability | On `requested ≠ served` | Rationale |
  |---|---|---|
  | `chat` (graph generation, claim/bias/frame/simulacra detection, judge calls) | Accept response, log one-time warning per (provider, requested, served) | Quality signal is observable downstream; substitution rarely catastrophic |
  | `embed` (vector embeddings) | **Reject and fall through to next provider** | Embedding spaces are model-specific; mixing vectors from different models silently corrupts retrieval |
  | `chat_with_json_schema` (structured output where schema is contract) | Validate response against schema; if model differs AND schema validation fails, fall through to next provider | Substitution may break the response_format contract; validation is the canonical signal |
  | `chat_with_response_format=json_object` (existing soft contract) | Accept; if JSON parse fails, fall through (existing behavior) | Backward compatible with current sites |

- **Implementation:** `chat()` and `embed()` on the gateway take a `capability` discriminator. The gateway routes substitution policy from the discriminator, not from the call site.
- **Legacy detectors migrated** via `local_chat_json` adapter shim that internally routes through the gateway. No call-site changes required for ClaimDetector / BiasDetector / ThematicAnalyzer / hierarchical clusterers.
- **Embedding `embedding_provider_id`** field is removed from the schema (dead). Embeddings use the same gateway with `capability=embed`.

### D6. Browser-as-authority closure

- **`useAutoSave.js` and `useAudioInputEffects.js` server-write paths are consolidated** into one explicit `saveConversationDraft(conversationId, payload)` function in `services/apiClient.js`.
- **`saveConversationDraft` carries presentation/recovery state ONLY**, not canonical semantic state. This is the load-bearing constraint per P1/P7.
  - **Allowed `payload` keys** (presentation/recovery layer, browser-authoritative):
    - `conversation_name` (user-edited title — name is user-authored metadata, not LLM-authored interpretation)
    - `viewport` (zoom/pan position on the graph canvas)
    - `canvas_overrides` (per-node `canvas_x`/`canvas_y` user-positioned coordinates)
    - `dismissed_unlock_affordances` (which level-unlock CTAs the user has dismissed inline)
    - `active_tab` (currently selected zoom-tier tab)
    - `active_color_mode` (graph color scheme — `"tier"` | `"speaker"` | `"temporal"` per §D4)
    - `local_draft_text` (in-progress notes the user typed but hasn't committed — explicitly draft, not authored)
    - `pinned_node_ids` (UI focus state)
  - **Forbidden `payload` keys** (semantic layer, backend-authoritative — must NOT pass through this function):
    - `nodes`, `node_name`, `summary`, `node_type`, `level`, `semantic_level`, `semantic_type`
    - `relationships`, `edges`, any edge metadata
    - `clusters`, `claims`, `intent_signals`, `frame_analysis`, `bias_analysis`, `simulacra_analysis`
    - `utterances`, `transcript_events`, `speaker_segments`
    - `is_tangent`, `is_crux`, `is_bookmark`, `is_contextual_progress` (these are LLM-authored)
- **Server-side enforcement.** The corresponding backend endpoint validates against this whitelist; unknown keys are rejected with `400 invalid_payload_key`. Authored semantic state is never accepted from the browser via this path.
- **No direct `fetch`/`apiFetch` calls to write conversation state from anywhere else in the frontend.** Edits to authored fields (e.g., user manually corrects a node title) go through dedicated authoring endpoints — `PATCH /api/nodes/{id}` — that route through the edit-history audit log per ADR-018, not through `saveConversationDraft`.
- **This narrowing honors P7** (backend is the only writer of semantic state) and P1 (immutable evidence + materialized read models). A consolidation that simply moved all browser writes into one function — without limiting scope — would still violate P7. The whitelist is the actual closure.

### D7. Prompt artifacts

Adopted from ADR-027 and extended:

- **Every LLM prompt — graph generation, hierarchy clusterers, hierarchy-unlock judge, claim detection, bias detection, frame detection, simulacra detection, intent_signal detection, formalization candidate generation — is registered with `prompt_manager` and version-tracked.**
- **No prompts inline in service code.** Prompts that currently live as Python string literals (e.g., in detector services) are migrated.
- **Prompt changes are reviewed.** Regression-testable when prompt versioning lands.

### D8. Failure visibility and instrumentation

- **No silent failures.** Every stage emits a `stage_failed` event with `error_code`, `error_message`, `recoverable: bool`, and `next_action: 'retry' | 'continue' | 'stop'`.
- **Frontend renders failed stages explicitly** (red pill in status bar, drilldown via tooltip).
- **`pipeline_artifacts` retains failure rows** with the same shape, so post-hoc analysis can identify chronic stage failures.
- **`except: pass` is forbidden in pipeline stages.** Existing instances must be reviewed and either replaced with explicit stage-failure emission or justified with a `# Deferred:` comment pointing at a tracking issue.

### D9. Hierarchical depth observability

- **The number of unlocked levels per conversation is recorded in `conversations.unlocked_levels`** (new column, default `[1]` for `chunks` only).
- **Each unlock event writes to `pipeline_artifacts`** with `stage='hierarchy_unlock'`, `artifact_type='nodes'`, `artifact_metadata={'level': N, 'judge_decision': 'yes_cluster|not_yet|forced', 'node_count_below': M}`.
- **Telemetry exposes histogram of unlocked-depth across conversations** for product analytics.

### D10. Reserved terminology discipline

Adopted from ADR-028 verbatim. Adds:

- **"Hierarchy"** is reserved for the four/five-tier semantic structure (chunks/ideas/topics/themes/arcs). Do not use for other node groupings.
- **"Tier"** and **"level"** are interchangeable in API/UI text but `level` is canonical in code (matches DB column).
- **"Cluster"** refers to the `clusters` table only (which is now a denormalized cache, see ADR-019). Do not use "cluster" colloquially for nodes.

---

## Consequences

### Positive

- **Live and import become one conceptual pipeline.** Every product feature lands once.
- **Provider routing is unambiguous.** No more dual-config drift; no more silent model substitution.
- **Hierarchy is conversation-aware.** Short clips are cheap; long conversations are rich. No empty tabs, no over-clustering.
- **The graph speaks through visual weight.** Tangents, cruxes, drafts, and bookmarks are visible without text labels (ADR-011 honored in code).
- **Failures are observable.** No more "why didn't this work" debugging from logs alone.
- **Browser is honestly a view layer.** ADR-019 fully realized.
- **Cost goes down for short conversations** (fewer LLM calls due to emergent depth) and stays roughly flat for long ones.
- **The codebase is testable in pieces** because the pipeline has stable stage boundaries.

### Negative / cost

- **Migration: ~14-15 days of engineering work** across ~12-15 PRs (see migration plan).
- **Risk during pipeline extraction** — the two largest backend files are touched. Mitigated by stage-by-stage extraction (no big-bang refactor).
- **Old conversations without authored hierarchy lose deeper-tab views** after the 60-day grace period. Acceptable: those views were heuristic and arguably wrong. The 60-day window assumes few old conversations are actively reviewed; if usage shows otherwise, this can be extended at the post-step-5 review.
- **The LLM-judge call adds a small per-conversation cost** (one classification call per unlock evaluation). Net is still cheaper than current behavior.
- **Settings page gains a new toggle** (audio retention) — small UI cost.
- **Documentation churn** — many ADRs reference older patterns; their relationships need updating.

### Open / explicitly deferred

- **Prayer/IntentSignal frontend surfacing** — schema (ADR-013) and detection are landed. UI is pending. **ADR-031 to be drafted within 30 days of ADR-030 approval, scoping the prayer surfacing UX (panel design, "ready for formalization" workflow, cross-session sighting view).** Until ADR-031, intent signals continue to materialize on the backend but are not exposed to users.
- **Formalization bridge (Layer 1→2)** — depends on ADR-031.
- **Cross-session thread tracking UI** — depends on ADR-031.
- **Lull detection as a stage** — the unlock cascade is a step toward this; explicit lull-detection-and-resume-nudge as a pipeline stage is deferred to a future ADR.

---

## Migration Plan

### Approval semantics (read first)

This ADR distinguishes two classes of pre-approval activity:

1. **No-regret bug fixes** — corrections that are obviously correct independent of any architectural choice in this ADR. They have no design surface area; they merely close existing inconsistencies. Allowed during review. The set is exhaustively listed below as Step 0.
2. **Implementation begins after approval.** Anything that touches the architecture this ADR governs — D3 pipeline extract, D4 node renderer, D5 gateway, D6 browser-as-authority closure, D7 prompt migration, D8/D9 stage observability, D2 emergent hierarchy — waits for `Status: Approved`.

This separation prevents the failure mode where architecture lands in code while the ADR is still under review. The reviewer's redline must be able to alter the architecture without retroactively un-shipping work.

### Step 0 — No-regret bug fixes (allowed during review)

Already implemented in the current branch (uncommitted at time of ADR drafting; see git status):

- `local_llm_client.py`: `_resolve_served_model()` extracts the response's `model` field and propagates it into `ProviderResult.model` (closes silent substitution).
- `graph_query_service.node_to_response_payload()`: includes `semantic_level`, `semantic_type`, `is_tangent`, `is_crux` in the API response.
- `graph_api.py NodeResponse`: schema accepts the new fields.

These three are the *only* pre-approval changes. They will be committed alongside ADR-030 itself once review concludes. Nothing else in this migration plan begins until ADR-030 reaches `Status: Approved`.

### Post-approval execution

Each step is independently reviewable.

1. **D6 — browser-as-authority closure** (0.5-1 day)
   - Consolidate `useAutoSave.js` + `useAudioInputEffects.js` server writes into one `saveConversationDraft` function in `apiClient.js`, narrowed per §D6 below.
   - Remove direct backend writes from anywhere else in the frontend.

2. **D4 — draft graph custom renderer** (~2 days)
   - Implement `<ConversationNode>` per §D4.
   - Wire `NODE_TYPES = {conversational: ConversationNode}` in `MinimalGraph.jsx`.
   - Apply `buildSpeakerColorMap` + `buildTemporalColorMap` for "rainbow as nodes arrive" on draft nodes.
   - Verify visually with a Matt Farr conversation file (multi-speaker, multiple tangents).

3. **D3 — pipeline persistence merge** (1 day)
   - Combine `live_graph_persistence.py` + `import_persistence.py` into `services/graph_persistence.py`.

4. **State-vs-transport audit** (0.5 day)
   - Classify state in `WsSessionContext` and `import_bulk_pipeline` worker.
   - Write findings to `docs/plans/pipeline-extract-state-audit.md`.

5. **D3 — pipeline extract** (3-5 days, 5 PRs)
   - **Per §D3, the pipeline lands as a directory of stage modules, not a single file.** PR-A creates `services/conversation_pipeline/` with `protocol.py`, `events.py`, `state.py`, and the orchestrator skeleton. PR-B-E each move one or two stages from `stt_ws_session` / `import_bulk_pipeline` into stage modules under `stages/`. No file in the new directory exceeds 300 LOC.
   - PR-A: package skeleton + `ingest` stage.
   - PR-B: `transcribe` + `segment` stages.
   - PR-C: `accumulate` + `generate_graph` stages.
   - PR-D: `refine` + `persist` stages.
   - PR-E: `unlock_hierarchy` stage; dead-code removal in transport adapters; event taxonomy harmonization.

   **Status (2026-05-07):** PRs A-E shipped the *package scaffold and stage definitions* with 79 unit tests, but the transport rewiring described above (cutting `stt_ws_session.py` and `import_bulk_pipeline.py` over to call `ConversationPipeline.run()` instead of mutating their inline state) is **not yet done**. Production live + import flows still execute through the old monolith paths. The "transport surgery" sub-step is a separate sprint deliverable; track it as **Step 5b**:
   - 5b: rewire LiveTransport (stt_ws_session.py) and ImportTransport (import_bulk_pipeline.py) to invoke ConversationPipeline. Migrates ~33 + 19 pipeline_state items per the audit. **Pending.**

6. **D2 — emergent hierarchy depth** (~2 days)
   - Implement unlock evaluator with bucketed re-evaluation (5, 7, 10, 15, 25, 40, 60, 100) gated by content-hash dedup of items at the level below.
   - Refactor `level_*_clusterer.py` to be invoked by the evaluator, not unconditionally.
   - Add `conversations.unlocked_levels` column + migration.
   - Frontend: render only unlocked tabs.

7. **D5 — provider gateway + adapter shim** (1 day)
   - Implement `services/llm_gateway.py` with capability-sensitive substitution policy per §D5.
   - Wrap `local_chat_json` to route through gateway.
   - Migrate `embedding_service.py` to gateway; remove `embedding_provider_id` field.

8. **D7 — prompt manager extension** (0.5 day)
   - Migrate inline prompts from detector services into `prompt_manager`.
   - Add prompt-version field to `ProviderResult`.

9. **D8/D9 — failure visibility + hierarchy observability** (0.5 day)
   - `stage_failed` event emission across pipeline stages.
   - Frontend status bar surfaces failed stages.
   - `pipeline_artifacts` writes for unlock events.

10. **A2 grace period closure** (60 days after step 5 lands)
    - Remove `buildTemporalChains` + `buildTopicCommunities` from `MinimalGraph.jsx`.
    - Conversations without authored hierarchy show only `chunks`.

### After this ADR

- **ADR-031 (prayer/IntentSignal frontend)** — drafted within 30 days of ADR-030 approval.
- **Future ADR (lull detection as stage)** — depends on D9 telemetry.

---

## Notes

This ADR was drafted against a comprehensive investigation of:
- All 30 prior ADRs (with explicit principle extraction from ADR-002, 007, 010, 011, 013, 017, 019, 021, 026, 027, 028)
- The full live pipeline (`stt_ws_session.py`, 2508 LOC)
- The full import pipeline (`import_bulk_pipeline.py`, 1416 LOC)
- LLM provider routing across both legacy and new paths
- The data model (`models/graph.py`, `models/core.py`, hierarchical_themes module)
- The frontend graph rendering (`MinimalGraph.jsx`, 1551 LOC)
- An e2e validation run on a 24-second WAV that exercised the full pipeline and surfaced the contracts in question

The investigation findings are summarized in the conversation that produced this ADR; the principles and decisions here reflect direct user input on every architectural tradeoff in §Decisions.

---

**Approval required from:** Product + Research (Aditya).
**Approval gate:** Step 0 (no-regret bug fixes) is the only pre-approval activity. All numbered post-approval steps wait for `Status: Approved`.
**Review cadence:** Re-review one month after step 5 (pipeline extract) lands to assess whether the unification held under feature pressure.

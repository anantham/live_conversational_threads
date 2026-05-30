# LCT Rationality & Stub Audit — 2026-05-30

**Provenance:** 8 parallel specialist agents + 1 synthesis pass (Workflow `wf_9b7f6ad5`, run on branch `feat/e2e-audio-graph-zoom`). Read-only audit — no code changed. Raw per-area findings (with full file:line evidence per agent) are in the workflow transcript under `subagents/workflows/wf_9b7f6ad5-dfa`. This document is the synthesized digest.

**Question audited:** which "rationality" features (crux, double-crux, ideological Turing test, agree/disagree mapping, fact-checking) are actually implemented-and-wired vs orphaned vs stub vs absent; which secondary/parallel LLM analysis calls actually fire; and what redundant/dead code exists.

> Classification: `implemented_wired` (real logic + invoked in a live path) → `partial` → `implemented_orphaned` (real logic, nothing calls it) → `stub` (placeholder) → `absent`.

---

## 1. Status table

| Feature | Status | Wired? | Evidence (file:line) | Recommendation |
|---|---|---|---|---|
| Simulacra-level detection (Baudrillard 4 levels) | implemented_wired* | Backend yes / UI orphan | `services/simulacra_detector.py:32`; `analysis_api.py:15`; `backend.py:239`; `pages/SimulacraAnalysis.jsx`; route `AppRoutes.jsx:33` | Add a nav link — page reachable only by typing URL. |
| Cognitive bias / logical-fallacy detection (25+ taxonomy) | implemented_wired* | Backend yes / UI orphan | `services/bias_detector.py:101,34`; `analysis_api.py:91`; `pages/BiasAnalysis.jsx`; route `AppRoutes.jsx:34` | This is where fallacy detection actually runs. Add nav link. |
| Implicit frame / worldview-assumption detection (6 categories) | implemented_wired* | Backend yes / UI orphan | `services/frame_detector.py:111`; `analysis_api.py:159`; `pages/FrameAnalysis.jsx`; route `AppRoutes.jsx:35` | De-facto "assumptions" primitive. Add nav link. |
| Semantic edge enrichment (`enrich_semantic_edges`) | implemented_wired | Yes (live WS) | `services/edge_enrichment.py:394`; `stt_ws_session.py:763,2479`; `prompts.json` | Live. Only real agreement/disagreement signal that ships (node↔node). |
| Node-to-node agrees/disagrees edges + rendering | implemented_wired | Yes | `prompts.json:175`; `graphConstants.js:45`; `MinimalGraph.jsx:1530` | Works, but NO speaker attribution — not "who agrees with whom". |
| Hierarchical theme generation (L5→L1 clusterers) | implemented_wired | Yes (on-demand) | `thematic_api.py:215`; `services/hierarchical_themes/level_*`; `backend.py:243` | Live zoom path. Overlaps consolidator + ThematicAnalyzer (dedupe). |
| Cross-batch consolidation (ideas→…→arcs) + summarization (title/exec summary) | implemented_wired | Yes (live + import) | `hierarchy_consolidator.py:183,196,209,170`; `stt_ws_session.py:699-733`; `import_bulk_pipeline.py:1172-1289` | The wired summarization primitive. Keep. |
| Core graph generation (`generate_lct_json`) | implemented_wired | Yes (live + import) | `transcript_llm_callers.py:493`; `transcript_processing.py:530` | Real production path. `is_tangent` is labeled here via thread_state. |
| Import graph refinement (`refine_import_graph_nodes`) | implemented_wired | Yes (import only) | `import_graph_refinement.py:316`; `import_api.py:574`; `import_bulk_pipeline.py:1073` | Keep. |
| Lightweight fact-check window scan (`openai_factcheck`) — GET `/fact_check` | implemented_wired | Yes | `services/openai_factcheck.py:57,132`; `factcheck_api.py:232`; `NodeDetail.jsx:285` | The ONLY fact-check users see. NOT verification — classifies type/flags/urgency, no citations, not persisted. |
| Perplexity claim verification (verdict + citations) — POST `/fact_check_claims/` | implemented_orphaned | Endpoint yes / UI dead | `services/perplexity_factcheck.py:111`; `factcheck_api.py:53`; caller only `archive/TranscriptApp.jsx` | Wire into NodeDetail OR delete archive path. Real verification exists but unreachable. |
| Agenda-query "prayer" detector + consumption match | implemented_wired | Yes (live WS, flag-gated) | `agenda_query_detector.py:256`; `consumption_match_runner.py:117`; `stt_ws_session.py:1482` | Substring match, NOT an LLM call; off by default. Read/query side only. |
| Speaker-turn node synthesis | implemented_wired | Yes (2 copies) | `turn_synthesizer.py:63`; `graph_generation_service.py:42` | Consolidate duplicate helpers. |
| Diarization speaker attribution | implemented_wired | Yes | `conversations_api.py:680-749`; `speaker_analytics.py` | Infra exists; never joined to agree/disagree signal. |
| Prompt management layer (PromptManager facade) | implemented_wired | Yes | `prompt_manager.py:24`; `transcript_prompts.py:245` | NOT redundant — thin facade. Leave as-is. |
| LlmGateway (embeddings + boot audit) | implemented_wired | Yes | `llm_gateway.py:85,201,352` | Note: analysis/chat calls bypass it (see redundancies). |
| Tangent detection | partial | Yes (side-effect) | `graph_persistence.py:773`; `transcript_normalizer.py:179`; `graph_query_service.py:64` | No standalone detector — `is_tangent` is a label from graph-gen thread_state. |
| Claim embeddings + similarity index (ADR-030) | partial | No | `embedding_service.py:189,211,261`; `add_claims_table_with_vectors.py:105-109` | embed logic real but only reachable via orphaned ClaimDetector; ivfflat index never created; `find_similar_claims` has 0 callers. |
| `intent_signal` analysis_events recording | partial | No | `intent_signal_persistence.py:12,101,235` | TODO inside an already-orphaned module. |
| Detector LLM-routing block (copy-paste ×5, bypasses gateway) | partial | Mixed | `bias_detector.py:266-312`; `frame_detector.py:278-319`; `claim/is_ought/simulacra_detector.py` | Extract BaseNodeDetector → `llm_gateway.chat_json_object`. Hardcodes `claude-3-5-sonnet-20241022` ×5. |
| Three-layer claim detection (ClaimDetector) | implemented_orphaned | No | `claim_detector.py:31`; `claim_api.py:17` (no APIRouter); not in `backend.py` | Wire `claim_api` as router + connect to verifier, OR delete. Broken root-relative imports. |
| Argument-tree mapping (ArgumentMapper) | implemented_orphaned | No | `argument_mapper.py:32`; `argument_api.py:18` (no APIRouter) | Dead. premise→conclusion trees, not stance. Wire vs delete. |
| Is-ought / naturalistic-fallacy detection | implemented_orphaned | No | `is_ought_detector.py:36`; `argument_api.py:121` | Doubly dead: no router + depends on dead ClaimDetector. |
| Intent-signal ("prayer") extraction/persistence (ADR-013 Contract C) | implemented_orphaned | No | `intent_signal_persistence.py:85,118,164`; `models/analysis.py:261` | Persistence complete + tested, but NO detection prompt exists and zero callers. Half-built. |
| ThematicAnalyzer self-contained L2 generation | implemented_orphaned | Partial | `thematic_analyzer.py:36,100,262,382`; only `_serialize_existing_structure` used | Superseded by clusterers. Keep serializer, delete generation half. |
| Orphaned GraphGenerator prompts (`graph_generation.py`, 6 prompts) | implemented_orphaned | No | `services/graph_generation.py:26`; imported only by its test | Delete module + test. Stale schema + latent `self.prompt_loader` AttributeError. |
| `conversation_pipeline/` orchestrator + stages (ADR-030 §D3) | implemented_orphaned | No | `services/conversation_pipeline/orchestrator.py:53`; only tests import | Highest-value redundancy. Finish cutover (retire 3308-LOC `stt_ws_session` + 1523-LOC `import_bulk_pipeline`) OR delete. |
| `is_crux` read/serialization (backend → API) | implemented_orphaned | Yes (reads) | `conversation_reader.py:282`; `graph_query_service.py:65`; `conversations_api.py:505` | Plumbing wired end-to-end but always serializes False. |
| Crux visual rendering (frontend node styling) | implemented_orphaned | Yes (dead branch) | `MinimalGraph.jsx:218,235`; `ConversationNode.jsx:42-72` | Amber crux styling unreachable — no producer ever sets True. |
| Orphaned frontend components | implemented_orphaned | No | `archive/TranscriptApp.jsx`; `StructuralGraph.jsx`, `ContextualGraph.jsx`, `ExportCanvas.jsx`, `ThematicView.jsx`, `HorizontalTimeline.jsx`, `SttSettingsPanel.jsx`, `UploadTranscriptPreview.jsx` | Delete unless retained for reference; only `MinimalGraph.jsx` renders. |
| `is_crux` node flag (schema/data model) | stub | Persisted, never written | `models/graph.py:43`; migration `732e0cd9a870:124` | Never set True by any code. |
| Crux detection (LLM detector / analysis pass) | absent | No | No `crux_detector.py`; no crux route; 0 hits in `prompts.json` | Pure roadmap (FEATURE_ROADMAP §3.3 Week 14). |
| Double-crux analysis | absent | No | `CLAIM_TAXONOMY_SYSTEM.md:132-165` (doc-only table); `FEATURE_ROADMAP.md:212` | Wholly aspirational. |
| Ideological Turing Test | absent | No | No prompt/endpoint/component; grep zero hits | Not built, not even named in docs. |
| Steelmanning + score | absent | No | `FEATURE_ROADMAP.md:247-265`; `FEATURE_SIMULACRA_LEVELS.md:762` ("7/10" mockup) | Hardcoded mockup prose. |
| Devil's advocate (auto counter-position) | absent | No | Only `BIAS_DETECTION.md:387` prose | Not a planned feature. |
| Perspective-taking / alternative-frame generation | absent | No | `FEATURE_SIMULACRA_LEVELS.md:787`; `frame_detector.py` is detection-only | Closest cousin detects, doesn't generate opposing view. |
| Charitable-interpretation scoring | absent | No | `FEATURE_SIMULACRA_LEVELS.md:763` caption only | Mockup caption only. |
| Cross-speaker agreement/disagreement map per speaker | absent | No | No detector/prompt/model; `speaker_analytics.py:24-329` does time/turns/roles only | The named "where do people agree/disagree" feature does not exist. NEW build. |
| Fact-check result persistence (save/get) | absent | No | `schemas.py:66,71` (vestigial); `db_helpers.py:31` save fn commented out | Fact-check output is ephemeral. |
| Calibration / open-questions / decisions / action-items detection | absent | No | No prompt in `prompts.json`; no service | Genuinely absent. |

\* **Audit disagreement (simulacra/bias/frame):** one agent labels these `implemented_wired` (mounted router + real logic); another labels them `implemented_orphaned` because **no UI navigation links to the pages**. Both agree on the facts — "backend wired, frontend unlinked." Counted as wired-with-orphan-UI.

---

## 2. What's real and working

The production conversation engine is solid and genuinely wired: live STT and bulk import both run `generate_lct_json` (graph generation), then `hierarchy_consolidator` (ideas→topics→themes→arcs, which also produces the conversation title + executive summary), with `edge_enrichment` adding cross-node semantic edges in the live WS path and `refine_import_graph_nodes` doing dedup on import. On-demand, the L5→L1 theme clusterers power zoom levels, and three real rationality detectors — **Simulacra, Bias (incl. logical fallacies), and Frame (incl. per-node assumptions)** — have complete per-node LLM logic and mounted endpoints. The only fact-check a user actually sees is the `openai_factcheck` window-scan banner in NodeDetail (classification + flags, not verification). The agenda-query "prayer" consumption path is wired into the live session (deterministic substring matching, flag-gated off by default).

## 3. Verdicts on the named features

- **Crux detection:** ABSENT as logic. `is_crux` is a never-written boolean with live read-plumbing and a dead amber-styling UI branch. No detector, no prompt.
- **Double-crux:** ABSENT entirely. Only a `double_crux_analysis` table sketched in a doc (no migration).
- **Ideological Turing Test / steelmanning / devil's advocate / charitable-interpretation:** ABSENT. No code anywhere — only roadmap docs and a hardcoded "Steelmanning Score: 7/10" mockup. "ITT" never appears.
- **Agree/disagree:** PARTIAL/weak. Node-to-node `agrees`/`disagrees` edges exist and render, but carry **no speaker attribution**. No "where does speaker A agree with speaker B." That feature is absent — a new build.
- **Fact-checking:** SPLIT. Live = classification only (no verification, not persisted). Real verification (Perplexity, verdict + citations) exists but is orphaned behind an archived component. The claim taxonomy + claim embeddings that would bridge them are fully dead; `Claim.verification_status` is hardcoded `None`.

## 4. Redundant / dead code worth removing or consolidating

(See docs/TECH_DEBT.md "Rationality/stub audit" section for the tracked rows.)

- Three graph-generation backends — **delete `services/graph_generation.py` + its test** (orphaned, stale schema, latent `AttributeError`).
- Dead claim/argument surface — `claim_api.py` + `argument_api.py` define handlers but **no APIRouter**, never mounted; detectors have no other caller; broken root-relative imports.
- **`conversation_pipeline/` orchestrator + 8 stages** — fully built/tested, imported only by tests; the monoliths it was meant to retire still own the live flow.
- Detector LLM-routing copy-paste (×5) bypassing `llm_gateway` and re-hardcoding the model.
- Three LLM access paths (gateway vs direct Anthropic vs direct httpx→OpenRouter).
- `ThematicAnalyzer` generation half (dead; only the serializer is used).
- Orphaned frontend components (only `MinimalGraph.jsx` renders).
- Duplicate turn-synthesis; dead claim-similarity retrieval; log-only alert stubs; disabled "Formalize/Earmark/Remind" toolbar buttons.

## 5. Recommended next steps (prioritised)

**A. Quick wires (hours, low risk)**
1. Add nav links to `/simulacra`, `/biases`, `/frames` — three complete detectors reachable only by URL. Highest value-per-effort.
2. Decide the Perplexity verification surface: wire `POST /fact_check_claims/` into live NodeDetail.

**B. Real builds (need ADR + sign-off)**
3. Cross-speaker agree/disagree map (the named ask) — join `speaker_id` to a stance pass; nothing provides it today.
4. Crux / double-crux / steelmanning / ITT — roadmap-only; first reconcile competing data models (`is_crux` boolean vs `double_crux_analysis` table sketch) into one owning ADR.
5. Claim taxonomy → verification bridge — mount `claim_api`, connect to the Perplexity verifier, persist `Claim.verification_status`, build the ivfflat index via SQL.
6. `intent_signal` ("prayer") detection write path — persistence is built + tested but has no detector prompt and zero callers.

**C. Deletions (per CLAUDE.md #6/#11 — ADR/schema check before removing)**
7. Delete `services/graph_generation.py` + test; prune its 6 dead prompts from `prompts.json`.
8. Delete orphaned frontend components.
9. Decide `conversation_pipeline/` fate (finish cutover vs delete) — track in WORKLOG/ADR-030.

**Cross-cutting:** extract `BaseNodeDetector`, route all detectors + `thematic_analyzer` through `llm_gateway`, standardize on `lct_python_backend.*` imports.

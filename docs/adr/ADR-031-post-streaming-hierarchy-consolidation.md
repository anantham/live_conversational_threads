# ADR-031: Post-Streaming Hierarchy Consolidation (Option A)

**Date:** 2026-05-12
**Status:** Approved and implemented
**Group:** pipeline + data
**Refines:** [ADR-021](ADR-021-authored-four-level-conversation-hierarchy.md)
**Related:** [ADR-002](ADR-002-hierarchical-coarse-graining.md), [ADR-027](ADR-027-prompt-manager-canonical-for-transcript-and-refinement-prompts.md)

---

## Issue

ADR-021 specified backend-authored semantic levels (chunk / idea / topic / theme / arc), with the streaming LLM emitting all five tiers per batch. Empirical results on a 78-minute meeting (`Q.m4a`, 1,463 utterances) showed **tier inflation** — 429 chunks, 91 ideas, 107 topics, 100 themes, 0 arcs. Compression ratios were ~1:1 above the idea tier; the higher tiers were noise.

Root cause: the streaming prompt sees one batch at a time (≤80 nodes of prior context). Each batch independently authors topics/themes/arcs from its local view, so two batches discussing the same topic emit two near-identical topic nodes. Cross-batch consolidation is impossible from inside the streaming window.

Secondary issue: with `gpt-4o-mini`'s 128K context, very long inputs (Q.m4a hit ~470 prior nodes) overflowed the prompt and the request returned HTTP 400, dropping batches.

---

## Decision

Split hierarchy generation into two phases:

1. **Streaming phase** — emit only **chunks (L1) and ideas (L2)** per batch. Topics, themes, and arcs are no longer authored in the streaming pass.
2. **Post-streaming consolidation phase** — three focused LLM passes run sequentially after all batches finish, each seeing the entire input tier at once:
   - `consolidate_ideas_to_topics`: N ideas → M topics (target ratio 5-8×).
   - `consolidate_topics_to_themes`: M topics → K themes (target ratio 3-5×).
   - `consolidate_themes_to_arcs`: K themes → J arcs. This pass also emits a **conversation title** and a 3-sentence **executive summary**.

Each consolidation prompt receives the full child-tier list in one call. The output nodes carry `children_ids` pointing into the prior tier; persistence joins through these IDs.

---

## Implementation

- **Service:** `lct_python_backend/services/hierarchy_consolidator.py` — three async functions, each calling `chat_with_provider_fallback_sync` directly via `PromptManager`. Bypasses the per-batch path entirely.
- **Prompts:** `prompts.json` gains three new templates:
  - `consolidate_ideas_to_topics`
  - `consolidate_topics_to_themes`
  - `consolidate_themes_to_arcs`
  The streaming prompt `generate_conversation_hierarchy_local` is trimmed to emit only L1+L2 (version `a1-chunks-ideas-only-2026-05-12`).
- **Pipeline wiring:** `services/import_bulk_pipeline.py` invokes the three passes after refinement, gated by minimum input counts (ideas≥4 for topics, topics≥3 for themes, themes≥2 for arcs). Failure of any pass logs and continues — earlier tiers persist.
- **Surface:** `conversations_api.py` reads the title and summary from `conversation.source_metadata` and returns them in `ConversationResponse`. The frontend banner is wired in `lct_app/src/pages/ViewConversation.jsx`.
- **Streaming context:** `services/transcript_processing.py` now sends only the last 80 trimmed nodes (id, node_name, summary, semantic_level, semantic_type) to the streaming LLM — keeps prompt size bounded regardless of conversation length.
- **Refinement guard:** `services/import_graph_refinement.py` rejects any refinement that drops >50% of higher-tier nodes (was: chunks-only check). Prevents the refiner from collapsing the hierarchy back to noise.
- **Model:** switched `openai_chat` provider to `gpt-4.1-mini` (1M context, $0.40/M input) to remove the 128K ceiling.

---

## Validation

Q.m4a (78 min, 1,463 utterances), conversation `3ce1595a-cb06-40ec-8b0e-1c5dbd1057a6`:

| Tier | Count | Compression vs prior tier |
|---|---|---|
| chunks (L1) | 677 | – |
| ideas (L2) | 143 | 4.7× |
| topics (L3) | 22 | 6.5× |
| themes (L4) | 6 | 3.7× |
| arcs (L5) | 5 | 1.2× |

Title: *"AI Development, Platform Design, and Strategic Management"*. Executive summary populated. Auto-exported to Drive. Zero HTTP 400s.

3-min baseline (`Q_3min.m4a`): 25 chunks → 5 ideas → 3 topics → 3 themes → 3 arcs.

---

## Consequences

**Wins:**
- Real compression up the hierarchy; the top-down read (title → summary → arcs → themes → topics → ideas → chunks) becomes navigable.
- Streaming LLM no longer asked to do something it cannot do well (cross-batch consolidation from a local view).
- Title and summary are LLM-authored once, not patched in by heuristics.

**Costs:**
- Adds three LLM calls per import (~30 s on `gpt-4.1-mini` for Q.m4a). Negligible relative to STT runtime.
- Per-batch refinement no longer touches L3+; if streaming emits a bad idea, only the consolidation pass can fix it.
- Two prompt-version regimes coexist: streaming (`a1-…`) and consolidation. Edits must touch the correct one.

**Tuning constants currently inlined (track for ADR or `tuning_constants.py`):**
- 80-node sliding-window size in `transcript_processing.py`
- 50% loss threshold in `import_graph_refinement.py`
- 2.5× default-tab compression ratio in `MinimalGraph.jsx`
- Idea≥4 / topic≥3 / theme≥2 minimum-count gates in `import_bulk_pipeline.py`
- Target ratios in consolidation prompts (5-8× ideas→topics, 3-5× topics→themes)

**Open follow-ups:**
- No unit tests for `hierarchy_consolidator.py`. Mock-based tests for empty input, malformed JSON, missing `children_ids`, and title+summary extraction are listed in the tech-debt scan as H5.
- No tests for `prompt_manager.py` UTF-8 path; the recent cp1252 silent-drop bug went undetected for days (precedent for adding the test).

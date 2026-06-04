# LCT Conversation-Graph ↔ ADR Consistency Audit

**Date:** 2026-06-05
**Method:** Multi-agent audit (9 agents) mapping the ADR-specified conversation-graph
data model against the implemented Node/graph data structure across every layer
(ADR spec · backend model · prompts+consolidation · API+frontend), then
per-dimension cross-checks verified against code.
**Status:** Findings record. The `✅ FIXED` items in the flag-chain table were
addressed on branch `fix/local-mode-graph-quality` (this session); the `❌` items
are open follow-ups.

> Note: findings carry file:line references from an automated read. Re-verify the
> exact lines before acting — line numbers drift as the tree changes (this repo
> has concurrent sessions editing it).

---

## VERDICT

**The data model is partially consistent with the ADRs, with two structural problems and one half-finished migration.**

1. **`node_type` is the single biggest source of incoherence.** Three different vocabularies are crammed into one column. The normalizer writes the *semantic tier* (`chunk`/`idea`/`topic`/`theme`) into `node_type` (transcript_normalizer.py:363), persist then **overwrites** it with a *flag-derived conversational type* (`bookmark`/`contextual_progress`/`conversational_thread`, graph_persistence.py:693-697), and ADR-010 says the field should hold a *conversational pattern* (`discussion`/`question`/`claim`/`tangent`/`resolution`). The system survives only because the read path **ignores the stored `node_type`** and re-derives `semantic_type` from `level` (graph_query_service.py:25-34, 59). So `node_type` is effectively dead-but-misleading, and the LLM's semantic intent is discarded at persist.

2. **The `is_tangent` / `is_crux` flag chain is NOT complete end-to-end.** The recent fix closed the *normalizer + persist + local prompt* gap, but two upstream authors and the entire consolidation tier still drop the flags.

3. **Six columns are dead storage** (`predecessor_id`, `successor_id`, `speaker_transitions`, `dialogue_type`, `confidence_score`, and the never-written `claim_ids`). Never written by `persist_graph`; round-trips silently lose data or carry permanent NULLs.

### is_tangent / is_crux chain — verified node by node

| Stage | File:line | Status |
|---|---|---|
| Normalizer carries flags | transcript_normalizer.py | ✅ FIXED (this branch) |
| Persist writes both columns | graph_persistence.py | ✅ FIXED (this branch) |
| Local/qwen L1-L2 prompt asks | prompts.json `generate_conversation_hierarchy_local` | ✅ FIXED (this branch) |
| **gpt-4 streaming L1-L2 prompt asks** | prompts.json `generate_conversation_hierarchy` | ❌ STILL MISSING |
| **Refine prompt asks** | prompts.json `refine_conversation_subthreads` | ❌ STILL MISSING |
| **Consolidation L3-L5 emits flags** | hierarchy_consolidator.py | ❌ STILL MISSING |
| Readback surfaces flags | conversation_reader.py | ✅ |
| API serves flags in metadata | graph_query_service.py | ✅ |

**Conclusion:** the chain is end-to-end **only on the local/qwen path for L1-L2 nodes**. The gpt-4 streaming path never asks; every consolidated tier (topics/themes/arcs) never asks and never copies child flags upward. The recent fix was necessary but not sufficient.

---

## RANKED FINDINGS

### HIGH

**H1 — `node_type` conflates semantic tier, conversational pattern, and flag-derived type; LLM semantic intent discarded at persist.**
- *ADR:* ADR-010 (node_type = conversational pattern); ADR-030 §D2 (semantic tier canonical).
- *Code:* normalizer sets `node_type = semantic_type` (transcript_normalizer.py:363); persist overwrites from flags (graph_persistence.py:693-697); read path re-derives from `level`, ignoring stored value (graph_query_service.py:59); no `semantic_type` column (graph.py:34).
- *Fix:* Pick one meaning. Preferred (ADR-030): never store tier in `node_type`; keep deriving `semantic_type` from `level` at read; repurpose `node_type` for the LLM-authored conversational pattern and stop overwriting from flags; remove the `node_type = semantic_type` line.

**H2 — Consolidation drops `is_tangent`/`is_crux` for all L3-L5 (topic/theme/arc) nodes.**
- *Code:* hierarchy_consolidator.py builds parent dicts omitting both flags; the three consolidation prompts never ask for them.
- *Fix:* Propagate from children (`is_tangent = any(child.is_tangent)`, `is_crux = any(child.is_crux)`) and/or add to the consolidation prompts and extract them.

**H3 — gpt-4 streaming hierarchy prompt and refine prompt never ask for `is_tangent`/`is_crux`.**
- *Code:* only `generate_conversation_hierarchy_local` has the rules; `generate_conversation_hierarchy` and `refine_conversation_subthreads` do not.
- *Fix:* Copy the tangent/crux authoring rules (transcript_prompts.py) into both so all three L1-L2 authoring paths emit the flags identically.

**H4 — Edge round-trip is lossy when `edges_out` is absent (legacy fold path).**
- *Code:* persist faithful path keeps edges verbatim; the fold else-branch re-mints ids and discards `relationship_subtype`/`confidence`/`supporting_utterance_ids`/`is_bidirectional`/`strength`. conversation_reader only emits `edges_out` when `include_edges_out=True`.
- *Fix:* Default `include_edges_out=True` on any read feeding a re-persist; warn when `edges_out` missing on a reconstruction; reserve fold for first-pass LLM output; add a round-trip test. (Known footgun — see MEMORY build_graph_data_from_nodes.)

### MEDIUM

- **M1 — `thread_state` hardcoded to `new_thread` for every consolidated node**, contradicting inherited `thread_id` (hierarchy_consolidator.py). Derive from children; honor LLM value.
- **M2 — `level` vs `semantic_level`/`semantic_type` naming drift**; normalizer emits both; API serves divergent defaults (level 3 vs semantic_level 1). Pick canon, alias the other, reconcile defaults.
- **M3 — API NodeResponse omits `parent_id`/`children_ids`/`successor`** — hierarchy un-navigable for API-only clients. Add opt-in `include_hierarchy=true`.
- **M4 — LLM `claims` (strings) never persisted; API returns `claim_ids` (UUIDs) to a Claim table persist never populates.** Round-trip turns claim text into refs to non-existent rows. **This is the atomic unit `ROADMAP_ADVANCED_ANALYSIS.md` Phase 1 is built on — it is not wired up.** Add a `claims TEXT[]` column (simple) or implement Claim-table writes.
- **M5 — `source_excerpt=''` on all consolidated tiers** — ADR-032 "every node carries evidence" broken for L3-L5. Document as valid for synthetic tiers, or synthesize from children.
- **M(meta) — local prompt description says "four-level" but authors only two** (chunks+ideas); topics/themes/arcs come from consolidation. Fix the description.

### LOW

- **L1 — `predecessor_id` / `successor_id` columns are dead** — predecessor/successor are Relationship-derived. Drop or deprecate.
- **L2 — `node_type` has no CHECK constraint** while every other typed column does. Add one after resolving H1.
- **L3 — `speaker_transitions`, `dialogue_type`, `confidence_score`** defined but never populated (permanent NULLs). Drop or populate.

---

## Cross-cutting implication for the vision

`ROADMAP_ADVANCED_ANALYSIS.md` makes the **`claims` table the atomic search/analysis unit** (factual/normative/worldview taxonomy, argument trees, fact-check). Finding **M4** shows claims are extracted but never persisted — so the data structure does not yet support that roadmap's Phase 1. Foundation work (claim persistence + the flag-chain completion H2/H3 + edge round-trip H4) is a prerequisite before the argument-DAG / fallacy-analysis layer can be built on top.

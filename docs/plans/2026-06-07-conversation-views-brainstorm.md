# Views Over Conversation History — Call-Ready Brainstorm

**Date:** 2026-06-07
**Status:** Seed for a divergent design call. NOT a spec. The job here is to surface the contested choices, not resolve them.
**Substrate that makes this urgent:** the imminent 30+ meeting Aditya ↔ Vatsal corpus, with per-meeting `.threads` graphs and a "Two Minds" relationship report. This is the first time LCT has a real *multi-meeting, two-minds* artifact to look at — most views below only become interesting at corpus scale.

---

## 1. Framing — why views, tied to the vision

LCT's bet is that the valuable intellectual work happens *before* anything is formalized — the half-said intuition, the prayer gestured at and dropped, the argument whose scaffolding nobody wrote down. Views exist to **make that pre-formal layer legible and let intuitions accumulate across sessions** rather than evaporate at the end of each call. The product framing from the vision addendum is the north star: *"LCT helps you see your own reasoning clearly enough to improve it — not to replace your judgment."* That single line constrains the entire design space. Every view must **offer, never direct**: it surfaces structure ("here is where you two never closed this loop"), it does not render verdicts ("you were wrong"). It preserves specificity (every node traces back to an utterance via `source_excerpt` + `timestamp_start`), respects privacy (`external_llm_ok` / `Participant` gating before any cross-conversation aggregation leaves the box — ADR-038), and stays calm (one-Amber accent, drill-don't-dump, soft fades per DESIGN.md). Views are lenses over a corpus that is *the* data; they are not the data.

---

## 2. The View-System Spine — four lenses

Every proposed view across the four lens reports sorts cleanly into four families. The pattern is stark: **the Time/Flow lens is shallow-built (most infra shipped), the other three are deep-unbuilt** (rich proposals sitting on schema-only or vision-only foundations).

### Lens A — TIME / FLOW *(shallow-built — infra mostly shipped, multi-meeting unwired)*
The within-conversation flow surface mostly exists; the multi-meeting extension does not.
- **MinimalGraph (Flow canvas)** — shipped. The base substrate everything extends.
- **Argument-Scaffold Trace** (click node → walk ancestors) — shipped UI, but rests on edges that are barely enriched (see Lens D gap).
- **Differential / "What's New?" Canvas** (meeting 23 → 30 diff) — deterministic, unbuilt, *cheapest net-new view*.
- **Series Progression Map** (how a series evolved, theme dormancy) — partial: Browse exists, progression rendering unbuilt (ADR-016 Move 2).
- **Date color mode** (one hue per meeting) — shipped, *undocumented* — the only tangible multi-meeting primitive in code today.
- **Swim-lane temporal layout** (ADR-032 Part A) — `layoutByThread` exists, `timeBased:true` never wired into render. **0% surfaced.**

### Lens B — PEOPLE / SPEAKER *(deep-unbuilt — needs aggregation + cross-conv flags)*
Speaker attribution is persisted; no speaker-centric multi-meeting view exists.
- **Speaker Evolution & Influence Arcs** (dual swim-lane, who drives direction over time).
- **"Two Minds" Comparative Argument Map** (merged graph, edges colored by who proposed; where do they *actually* bifurcate).
- **Mentorship Inversion / Relationship Arc** (domain authority swaps over 15 months) — needs human-authored domain taxonomy.
- **Relationship Affinity Heat Map** (trust/tension over time) — net-new, needs affinity scoring (manual or LLM).

### Lens C — STRUCTURE / ARGUMENT *(deep-unbuilt — gated on edge trustworthiness)*
The reasoning-backbone views. All depend on semantic edges that are *not yet enriched* (ADR-032 Part D unshipped) — the load-bearing risk for this whole lens.
- **Scaffold-Trace View** (anchor → foundations, recursive drill).
- **Argument Fault Lines & Agreement Surfaces** (recurring tensions vs durable agreements, cross-meeting).
- **Crux Ladder** (recurring unresolved disagreements, ranked by recurrence + span).
- **Consensus & Crux Dashboard** (what's settled / contested / blocking).

### Lens D — ACCUMULATION / EVALUATION *(deep-unbuilt — schema shipped, detection + UI not)*
The mission-core views. ADR-013 schema exists; Contract C detection and the Prayers tab UI have never shipped (ADR-016 Move 3).
- **Prayer Trajectory Map** (one intuition's evolution across 30 meetings, semantic clustering).
- **Prayer Lineage Tree** (how a prayer spawns sub-prayers; needs `parent_signal_id`).
- **Prayer Accumulation / Signal Velocity** (which intuitions are gaining specificity).
- **Cross-Meeting Prayer Trail** (sightings threaded vertically; *most ready* in this lens — manual linking = no hallucination risk).
- **Structural Integrity Report** (where are the holes in *my* reasoning — unsupported claims, unanswered asks, unstated assumptions). Deterministic aggregation; this is the "see your reasoning to improve it" view made concrete (future ADR-036 scoring layer).
- **Conversation Cross-Reference Index** (in-situ: what past/future moments relate to what's on screen now).
- **Consumption Prayer Echo** (how one person's idea mutates when the other adopts it — needs ADR-033).

**Spine summary:** Lens A is a paving job (wire what exists). Lenses B, C, D are the real frontier — and B/C/D are exactly where the multi-meeting corpus pays off. C is **blocked on edge trust**; D is **blocked on detection running**.

---

## 3. The GAP Table — vision-promised vs shipped

From the gap-audit lens. The headline: the *review experience* (ADR-016, the keystone) has shipped none of its three moves, so the core promise — pre-formal intuitions accumulating across sessions — is **invisible to users today**.

| Promise | Shipped | Blocker |
|---|---|---|
| Conversation map (MinimalGraph) | ~90% | Hierarchical / tab-bar navigation missing |
| Thematic zoom (multi-scale) | 0% | ADR-016 Move 1 not implemented (ThematicView orphaned, no route) |
| Prayer detection & surfacing | 0% | ADR-016 Move 3 blocked; Contract C detection never ran; Prayer chip/drawer components built but rendered nowhere |
| Cross-session intent accumulation | 0% | Prayer UI + Series (Move 2) not shipped |
| Argument scaffolding visualization | ~50% | Semantic edges not enriched — `enrich_semantic_edges` pass (ADR-032 Part D) pending; most edges are temporal-next |
| Swim-lane temporal layout | 0% | `layoutByThread` not called with `timeBased:true` in MinimalGraph |
| Color modes (tier/speaker/temporal/argument/date) | 100% | All live; **date mode is new + undocumented** |
| Edge taxonomy & rendering | ~60% | Colors + trace work; enrichment pass pending |
| Search (Cmd+K) | 100% | Shipped |
| Static artifact viewer (`.threads`) | 100% | ThreadsViewer shipped (ADR-036); cross-conversation edges not |
| Multi-conversation / combined-graph viewer | 0% | Vision-only; date mode hints at it but no combined viewer exists |

**Two structural notes for the call:**
- **Two canvas implementations coexist** — MinimalGraph (shipped, primary) and DualView (`DualViewCanvas`/`TimelineView`/`ContextualNetworkView`, built but unrouted, per ADR-004). Decide which is the future before layering new views on either.
- **Authored hierarchy is computed but not surfaced** — backend returns `semantic_level`/`semantic_type` (ADR-021/030), MinimalGraph ignores them and falls back to legacy clustering. The LLM's tiers exist but users can't zoom by them.

---

## 4. Prioritized Shortlist — the 6 highest-leverage views to actually consider

Ordered to **lead with what's unique to a multi-meeting corpus and mission-core (accumulation + structural integrity)**, then descend toward cheaper/within-conversation wins. "Buildable now" = runs on the combined corpus with existing data; "needs new extraction" = requires a detection/enrichment pass first.

1. **Cross-Meeting Prayer Trail** *(Accumulation — mission core, multi-meeting-unique)*
   *Value:* directly delivers the vision's primary promise — watch one pre-formal intuition surface, sharpen, and either mature or die across 30 meetings. *Lift:* low (UI component over existing `intent_signal_sightings`). *Buildable now?* Yes on the core IF prayers are populated — manual linking (ADR-016 Move 3 v1) means **no hallucination risk**. Caveat: depends on signals existing, which today they don't (Contract C unshipped). This is the wedge: populate even manually and the trail lights up.

2. **Structural Integrity Report** *(Structure/Evaluation — mission core, "see your reasoning to improve it")*
   *Value:* the most on-mission view — surfaces unsupported claims, unanswered questions, unstated assumptions, as *questions not verdicts*. *Lift:* medium (deterministic aggregation; the display is the cost). *Buildable now?* Logic yes (counts edges, finds orphaned asks) — but **quality is hostage to edge enrichment** (see Q2). Honest framing: "findings are data-driven, not judgments — you decide if a gap matters."

3. **Prayer Trajectory Map** *(Accumulation — multi-meeting-unique)*
   *Value:* corpus-level view of how intuitions cluster and converge; the "memory partner for intellectual work" made visual. *Lift:* medium (~70%). *Needs new extraction:* embeddings over `intent_signals` (one-off batch) + a corpus aggregation endpoint. Multi-meeting-only by construction.

4. **"Two Minds" Comparative Argument Map** *(People + Structure — multi-meeting-unique, the corpus's signature artifact)*
   *Value:* where do Aditya and Vatsal *actually* disagree across 30 meetings? Operationalizes the Two Minds report. *Lift:* medium. *Buildable now?* Mostly — speaker attribution + argument-status coloring already shipped; can ship *without* crux detection (just show the split, human judges). Crux highlighting (ADR-035) is later polish.

5. **Differential / "What's New?" Canvas** *(Time/Flow — cheapest net-new, high recurring value)*
   *Value:* "since last meeting, what moved, what resolved, what's a new tangent?" — the single most common returning-user question. *Lift:* lowest of the shortlist (deterministic set-diff over node timestamps). *Buildable now?* Yes, fully — all metadata exists, no extraction needed. Strong candidate for first ship to prove the multi-meeting surface.

6. **Series Progression Map** *(Time/Flow — multi-meeting, partial reuse)*
   *Value:* how a named series evolved — themes strengthening, threads going dormant, "resume from here." *Lift:* medium (~75%; Browse filter is 30% there). *Needs:* Series schema activation (ADR-016 Move 2) + theme-continuity linking + progression UI.

*Deliberately below the line for v1 (still on the corpus's frontier, but higher lift or fuzzier):* Speaker Influence Arcs, Crux Ladder, Consensus & Crux Dashboard (great but gated on edge trust + crux detection), Relationship Affinity Heat Map and Mentorship Inversion (require human-authored scoring/taxonomy — high lift, possibly more "report" than "view"), Consumption Prayer Echo (needs ADR-033), Prayer Lineage Tree (needs `parent_signal_id`), Cross-Reference Index (needs similarity index + privacy gating).

---

## 5. Open Questions for the Call

The genuinely contested choices. None of these have an obvious answer; they're the reason for a call.

1. **Per-meeting subgraphs vs cross-meeting synthesis.** Is the deliverable 30 linked-but-separate `.threads` graphs you navigate between, or a single combined graph where nodes from different meetings merge by topic? The accumulation lens assumes synthesis (clustering "prayer interface" in M5 with "unified prayer UX" in M18); the gap audit notes no combined viewer exists. Synthesis is where the value is *and* where the scale/hallucination risk concentrates. Which do we build first?

2. **Do edges need to be trustworthy *before* we ship structure views — given the hallucination finding?** Lenses C and D's best views (Structural Integrity, Fault Lines, Scaffold-Trace, Consensus) all assume semantic edges mean what they say. But MEMORY records that local extraction draws few valid edges and frontier models hallucinate rebuts; ADR-032 Part D enrichment hasn't shipped. **Is it irresponsible to surface "unsupported claim / unresolved crux" findings on top of edges we don't trust?** Or do we ship with a loud "edges are being refined" disclaimer and let the human filter? This may be the single most important call decision.

3. **Combined-graph scale + usability.** 30 meetings ≈ 4000 nodes. Graph aggregation memory says hundreds of chunk-level nodes are already unusable; canvas should default to the highest tier and drill down. At corpus scale, what is even renderable? Does the combined view *have* to be tier-gated / query-time-aggregated (ADR-032 autostructures pattern), and does that kill the "see the whole shape at once" appeal?

4. **Is "Structural Integrity" safe under offer-never-direct?** A view that lists "your unsupported claims" and "holes in your reasoning" is the most on-mission *and* the most directive-feeling. Where exactly is the line between "here's a gap, you decide if it matters" and an implied verdict? Does the framing-as-questions ("why do you two cite this differently?") actually hold, or does any ranked list of "weaknesses" violate the doctrine?

5. **Is entity / domain / affinity extraction worth the lift?** Several high-appeal views (Mentorship Inversion, Affinity Heat Map, domain-authority arcs) need net-new extraction with no schema today — human-authored taxonomies (~2-6 hrs) or LLM scoring (~1 wk + hallucination exposure). Are these *views* or are they *reports/analyses* better left to IndrasNet reprocessing? What's the smallest entity layer that unlocks the most views?

6. **Prayers: detection-first or manual-first?** The single biggest gap (0% shipped). The Prayer Trail is the wedge view but needs signals. Do we unblock Contract C (LLM detection — fast population, hallucination risk, weeks of backend) or seed the corpus with *manual* prayer tagging first (slow, trustworthy, lets us design the UI against real signal shape)? Manual-first lets the trustworthy-but-empty trail ship now.

7. **MinimalGraph vs DualView — pick the canvas.** Two graph implementations coexist with no product positioning. New views should target one. Is DualView the intended future (then MinimalGraph needs a tab bar as a stepping stone) or a dead prototype to delete? Building multi-meeting views on the wrong canvas doubles the rework.

8. **What's the right *unit* for the multi-meeting corpus — series, dyad, or topic?** Do we organize cross-meeting views around a named Series (ADR-016 Move 2), around a *relationship/dyad* (the Two Minds framing — all Aditya↔Vatsal meetings), or around a topic cluster that ignores meeting boundaries entirely? This shapes routing, aggregation, and what "resume" even means.

9. **Privacy boundary for cross-conversation aggregation.** Cross-meeting views pull nodes from many conversations; ADR-038 / `external_llm_ok` says we must gate before remote LLM calls. Does *every* cross-conv view filter at query time, and does excluding one non-consenting participant's meetings silently distort the trajectory/consensus picture (a trust artifact)? How do we show "this view is incomplete due to privacy filtering" honestly?

10. **Verdict views vs lens views — is there a place for any scoring at all?** Affinity heatmaps, confidence/specificity scores, crux-impact rankings all edge toward quantified judgment. Is *any* numeric score compatible with offer-never-direct, or do we hard-rule that all scores are hidden-by-default, explained-on-hover, and never sorted-as-leaderboard?

---

*Cited surfaces/ADRs: vision.md (2026-05-19 addendum); DESIGN.md (Garden Amber / One-Amber / drill-don't-dump); ADR-013 (intent signals schema); ADR-016 (review experience — 3 moves, keystone); ADR-021/030 (authored hierarchy); ADR-032 (swim-lane Part A, edge taxonomy Part C, enrichment Part D); ADR-033 (consumption prayer matching); ADR-035 (crux detection); ADR-036 (`.threads` artifact); ADR-038 (engine-agnostic privacy boundary). MEMORY: dimension-extraction precision/recall ceiling; graph-aggregation UX direction; build_graph_data edge round-trip.*

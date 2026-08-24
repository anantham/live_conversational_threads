# ADR-062: Overlapping Semantic Memberships with Derived Zoom Projections

- **Status:** Approved
- **Date:** 2026-08-13
- **Group:** Data model / visualization
- **Decision owner:** Aditya (human approval: “the zoom should be a view filtered on top of this more general richer structure”)
- **Refines:** ADR-002, ADR-030, ADR-031, ADR-032

## Issue

The authored hierarchy historically treated every adjacent tier as a partition:
each chunk belonged to exactly one idea, each idea to exactly one topic, and so
on. That constraint made the zoom UI easy to render as a tree, but it confused a
display property with the semantic model.

Conversation meaning is frequently cross-cutting. One utterance can supply both
an implementation constraint and an emotional concern; one idea can be part of
two topics; a topic can advance more than one theme. Deleting all but one parent
loses valid meaning. Conversely, rendering every membership as a visible parent
at once can duplicate cards and make drill-down unstable.

We need both:

1. a lossless canonical structure that permits many-to-many semantic membership;
2. a deterministic, legible zoom view that selects one primary parent per node.

## Decision

The canonical conversation structure is a typed directed multigraph. Adjacent
semantic tiers are linked by explicit `member_of` relationships. Membership is a
**cover**, not a partition: every child must have at least one valid parent in an
active adjacent tier, and it may have several.

For a lens `l`, membership is the relation:

`M_l ⊆ V_k × V_(k+1)`

where a child in tier `k` may participate in more than one pair. The default lens
is `thematic`. Future lenses may include chronology, decisions, people, projects,
or argument structure without rewriting canonical evidence.

The current tree-shaped zoom is a derived projection. For each child and lens,
the projection function selects one primary membership:

`π_l(child) ∈ {parent | (child, parent) ∈ M_l}`

`Node.parent_id` and `Node.children_ids` are retained as a materialized cache of
that primary projection for backward-compatible viewers. They are not the source
of truth for all semantic membership.

## Representation

No database migration is required for the first implementation:

- canonical membership is a `Relationship` from child to parent;
- `relationship_type = "member_of"`;
- `relationship_subtype = "<lens>:primary"` or `"<lens>:secondary"`;
- `confidence` records author/model confidence;
- `supporting_utterance_ids` retains provenance;
- exported graph nodes contain an explicit `memberships` array so a lean
  `.threads` artifact preserves secondary memberships without `edges_out`.

Example:

```json
{
  "id": "chunk-1",
  "parent_id": "idea-a",
  "memberships": [
    {"parent_id": "idea-a", "lens": "thematic", "role": "primary", "confidence": 0.97},
    {"parent_id": "idea-b", "lens": "thematic", "role": "secondary", "confidence": 0.78}
  ]
}
```

## Projection rule

For the initial thematic view, choose a primary parent deterministically:

1. retain the existing `parent_id` if it is still a valid membership;
2. otherwise retain a valid membership already marked `primary`;
3. otherwise choose the first authored valid parent in stable tier order.

The projection rewrites parent `children_ids` to include only primary children.
It never deletes secondary `member_of` relationships.

## Invariants

Canonical invariants:

- node IDs and relationship IDs are unique;
- every membership endpoint exists;
- membership links connect adjacent semantic tiers;
- every child below the highest active tier has at least one membership;
- overlap is valid and must not be “repaired” away;
- every membership remains traceable to source utterances through node provenance;
- aggregation uses set union of `utterance_ids`, so overlapping membership never
  double-counts transcript coverage.

Per-view projection invariants:

- each child has exactly one primary parent for the selected lens;
- `child.parent_id` equals that primary parent;
- each parent’s `children_ids` is exactly the inverse primary projection;
- secondary memberships remain available for alternate views, badges, cross-links,
  and future lens switching.

The former global “exactly one owner” invariant is retired. Uniqueness applies
only inside a particular rendered projection.

## Pipeline consequences

- Streaming extraction and higher-order consolidation may emit sparse overlap
  when content genuinely participates in multiple meanings.
- Orphan repair ensures at least one membership; it does not collapse multiple
  memberships.
- Hierarchy synchronization materializes membership edges first, then derives the
  primary projection.
- Database read/export reconstructs `memberships` from `member_of` relationships.
- Lean `.threads` re-import materializes those explicit memberships back into
  relationships.
- Generic contextual/semantic edge views exclude `member_of`; membership has its
  own visual semantics and must not clutter argument edges.

## Positions considered

### A. Keep a strict tree

Simple rendering and counting, but destroys cross-cutting meaning and makes the
chosen parent appear more ontologically certain than it is. Rejected.

### B. Render an unrestricted DAG directly

Semantically rich, but cards can duplicate and drill-down becomes unstable or
visually overwhelming. Rejected as the default UI, retained as canonical data.

### C. Canonical membership graph plus derived tree projection

Preserves semantic overlap while maintaining a predictable zoom interaction.
Chosen.

## Consequences and risks

- Consumers must not infer “not a member” from absence in `children_ids`; they
  must inspect canonical memberships when semantics matter.
- Naive descendant counts can double-count. Coverage and rollups must deduplicate
  utterance IDs.
- Projection policy is a product decision and should eventually be versioned with
  the lens/view configuration.
- The first implementation supports one thematic lens and primary/secondary
  roles. A normalized membership table may replace relationship subtypes if lens
  configuration, weights, or user-authored projections become more complex.

## Validation

- unit tests prove overlapping memberships survive normalization;
- unit tests prove lean graph export carries memberships without treating them as
  contextual edges;
- repaired artifacts are audited for complete transcript coverage, non-dangling
  memberships, one primary parent per projected view, and preservation of
  secondary parents.

## Amendment: edge-representation boundary (2026-08-24)

Hierarchy synchronization must preserve the graph's authored edge
representation. Legacy import graphs keep canonical hierarchy in each node's
`memberships` array and keep temporal/semantic relationships in their legacy
fields. Faithful read-model graphs, where every node has `edges_out`, continue
to materialize `member_of` edges there.

This boundary is required because `persist_graph` intentionally selects one
relationship persistence lane for the whole graph. Injecting `edges_out` into
only the hierarchy-touched nodes would select the faithful lane and silently
hide legacy `predecessor`, `successor`, and `edge_relations` relationships.
Partially faithful graphs are therefore invalid: synchronization fails with a
descriptive error until the caller normalizes every node to one representation.

Upper hierarchy tiers are also conditional rather than mandatory. L1-L2 repair
is the durable minimum; topic, theme, and arc consolidation run only after their
standard input thresholds are met. An unavailable or empty optional tier leaves
the highest complete lower tier valid and persistable instead of discarding a
successful repair.


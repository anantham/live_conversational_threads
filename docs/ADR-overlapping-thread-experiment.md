# Public demonstration: overlapping hierarchy and conversational threads

Status: experimental, approved by the user on 2026-09-08; not a production pipeline change.

Hypothesis: allowing multiple parents and independent ordered thread memberships
will recover coherent interleaved discussion more faithfully than forcing one
parent and one dominant thread. Human inspection of thread coherence is the
acceptance criterion; graph validity alone is not quality validation.

Keep original transcript segments and moment boundaries for comparison. Group
moments into ideas, topics, themes, arcs using adjacent-level DAG memberships.
Every group records why each child belongs. Deduplicate source IDs when rolling
up provenance, including diamonds. parent_id is a compatibility breadcrumb only;
memberships and children_ids retain the full graph. Mobile Up follows the actual
navigation trail, not a canonical parent. Thread membership is many-to-many and
ordered in source time. Explicit returns and interpretive thematic connections
are distinct, each with evidence from both endpoints.

The thread-first viewer shows rationale, exact evidence and shared memberships.
It is an additional route, not a replacement of card/map reading. Old artifacts
remain unchanged. The new experiment currently regenerates thread-return edges,
not all argument-relation types; its argument topology is explicitly partial.

Validation: synthetic shared-child navigation and source-deduplication tests;
reject dangling/invalid-level memberships, duplicate steps, invalid source IDs,
out-of-order routes, and ungrounded return endpoints. Then inspect the generated
threads with the user. Keep weak/borderline memberships visible, do not force a
desired thread count. Rollback is opening the original artifact.

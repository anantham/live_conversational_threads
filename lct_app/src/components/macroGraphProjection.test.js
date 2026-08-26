import { describe, expect, it } from "vitest";

import {
  MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT,
  projectSemanticEdgesToLevel,
} from "./macroGraphProjection";

/*
 * Test intent:
 * - Roll explicit directed edges from descendants up to the visible macro tier.
 * - Preserve overlapping memberships without multiplying global edge weight.
 * - Keep relationships internal when endpoints share any visible ancestor.
 * - Fail visibly instead of freezing on adversarial many-to-many fan-out.
 * - Exclude temporal and membership edges from semantic macro topology.
 */

const node = (id, level, parentId = null, memberships = []) => ({
  id,
  semantic_level: level,
  level,
  parent_id: parentId,
  memberships,
});

const hierarchy = [
  node("arc-a", 5),
  node("arc-b", 5),
  node("arc-c", 5),
  node("theme-a", 4, "arc-a", [
    { parent_id: "arc-a", role: "primary", lens: "thematic" },
    { parent_id: "arc-c", role: "secondary", lens: "thematic" },
  ]),
  node("theme-b", 4, "arc-b", [
    { parent_id: "arc-b", role: "primary", lens: "thematic" },
  ]),
  node("topic-a", 3, "theme-a"),
  node("topic-b", 3, "theme-b"),
  node("idea-a", 2, "topic-a"),
  node("idea-b", 2, "topic-b"),
  node("moment-a", 1, "idea-a"),
  node("moment-b", 1, "idea-b"),
];

const edge = (id, from, to, relationType, edgeKind = "semantic") => ({
  id,
  from_node_id: from,
  to_node_id: to,
  relation_type: relationType,
  edge_kind: edgeKind,
});

describe("macro quotient projection", () => {
  it("rolls descendant relations into deterministic directed macro edges", () => {
    const result = projectSemanticEdgesToLevel(hierarchy, [
      edge("support", "moment-a", "moment-b", "supports"),
      edge("clarify", "topic-a", "topic-b", "clarifies"),
      edge("timeline", "moment-a", "moment-b", "temporal", "temporal"),
      edge("membership", "theme-a", "arc-a", "member_of"),
    ], 5);

    expect(result.edges.map((item) => [item.from_node_id, item.to_node_id])).toEqual([
      ["arc-a", "arc-b"],
      ["arc-c", "arc-b"],
    ]);
    expect(result.edges[0]).toMatchObject({
      relation_type: "supports",
      edge_kind: "semantic",
      aggregate_weight: 1,
      underlying_edge_count: 2,
      relation_counts: { clarifies: 1, supports: 1 },
    });
    expect(result.edges.reduce((sum, item) => sum + item.aggregate_weight, 0)).toBe(2);
    expect(result.stats).toMatchObject({
      inputEdgeCount: 4,
      semanticEdgeCount: 2,
      temporalSkipped: 1,
      membershipSkipped: 1,
      projectedPairCount: 2,
    });
  });

  it("does not invent cross-arc arrows when endpoints share a visible ancestor", () => {
    const result = projectSemanticEdgesToLevel(hierarchy, [
      edge("internal", "moment-a", "idea-a", "supports"),
    ], 5);

    expect(result.edges).toEqual([]);
    expect(result.stats.internalEdgeCount).toBe(1);
  });

  it("keeps a partially overlapping many-owner relationship internal", () => {
    const partialOverlap = [
      ...hierarchy,
      node("theme-overlap", 4, "arc-a", [
        { parent_id: "arc-a", role: "primary" },
        { parent_id: "arc-b", role: "secondary" },
      ]),
      node("topic-overlap", 3, "theme-overlap"),
      node("idea-overlap", 2, "topic-overlap"),
      node("moment-overlap", 1, "idea-overlap"),
    ];

    const result = projectSemanticEdgesToLevel(partialOverlap, [
      edge("partial", "moment-a", "moment-overlap", "supports"),
    ], 5);

    expect(result.edges).toEqual([]);
    expect(result.stats.internalEdgeCount).toBe(1);
  });

  it("fails closed with a visible limit instead of expanding adversarial memberships", () => {
    const arcs = Array.from(
      { length: MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT + 2 },
      (_, index) => node(`wide-arc-${index}`, 5),
    );
    const wideSource = node(
      "wide-source",
      1,
      null,
      arcs.slice(0, -1).map((arc) => ({ parent_id: arc.id })),
    );
    const target = node("target", 1, arcs.at(-1).id);

    const result = projectSemanticEdgesToLevel(
      [...arcs, wideSource, target],
      [edge("too-wide", "wide-source", "target", "supports")],
      5,
    );

    expect(result.edges).toEqual([]);
    expect(result.stats.projectionLimited).toBe(true);
    expect(result.stats.limitationReason).toContain("visible representatives");
  });
});

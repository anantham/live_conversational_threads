import { describe, expect, it } from "vitest";
import { isGraphNavigationKey, navigateGraphNode } from "./graphNavigation";

/*
 * Test intent:
 * - Up/Down follows the authored abstraction hierarchy, preferring primary membership.
 * - Left/Right follows chronological neighbors at the current visible tier.
 * - Temporal navigation respects a scoped visible tier and never wraps at boundaries.
 * - Editing and action controls retain native arrow-key behavior.
 */

const nodes = [
  { id: "arc", semantic_level: 5, children_ids: ["topic-a", "topic-b"] },
  { id: "other-arc", semantic_level: 5 },
  { id: "topic-a", semantic_level: 3, parent_id: "arc", timestamp_start: 10, children_ids: ["idea-a"] },
  { id: "topic-b", semantic_level: 3, parent_id: "arc", timestamp_start: 40 },
  { id: "topic-c", semantic_level: 3, parent_id: "other-arc", timestamp_start: 25 },
  {
    id: "idea-a",
    semantic_level: 2,
    parent_id: "topic-a",
    memberships: [{ parent_id: "topic-b", role: "secondary" }],
    timestamp_start: 12,
  },
];

describe("two-axis graph keyboard navigation", () => {
  it("moves up to the nearest primary parent", () => {
    expect(navigateGraphNode(nodes, "idea-a", "up")).toEqual({
      targetId: "topic-a",
      targetLevel: 3,
      axis: "abstraction",
    });
  });

  it("moves down to the earliest adjacent child", () => {
    expect(navigateGraphNode(nodes, "arc", "down")).toEqual({
      targetId: "topic-a",
      targetLevel: 3,
      axis: "abstraction",
    });
  });

  it("moves left and right in time at the current tier", () => {
    expect(navigateGraphNode(nodes, "topic-c", "left")?.targetId).toBe("topic-a");
    expect(navigateGraphNode(nodes, "topic-c", "right")?.targetId).toBe("topic-b");
    expect(navigateGraphNode(nodes, "topic-a", "left")).toBeNull();
    expect(navigateGraphNode(nodes, "topic-b", "right")).toBeNull();
  });

  it("stays inside a scoped temporal tier", () => {
    expect(navigateGraphNode(nodes, "topic-a", "right", {
      temporalCandidateIds: new Set(["topic-a", "topic-b"]),
    })?.targetId).toBe("topic-b");
  });

  it("does not mix legacy or missing levels into authored-tier state", () => {
    expect(navigateGraphNode([
      { id: "legacy-a", level: 1 },
      { id: "legacy-b", level: 1 },
    ], "legacy-a", "right")).toBeNull();
    expect(navigateGraphNode([{ id: "untyped" }], "untyped", "left")).toBeNull();
  });

  it("keeps source order for numeric ids without timestamps", () => {
    const numericIds = [
      { id: 9, semantic_level: 3 },
      { id: 10, semantic_level: 3 },
    ];
    expect(navigateGraphNode(numericIds, 9, "right")?.targetId).toBe("10");
  });

  it("does not steal arrow keys from form and action controls", () => {
    const input = document.createElement("input");
    const card = document.createElement("div");
    expect(isGraphNavigationKey({ key: "ArrowLeft", target: card })).toBe(true);
    expect(isGraphNavigationKey({ key: "ArrowLeft", target: input })).toBe(false);
    expect(isGraphNavigationKey({ key: "ArrowLeft", target: card, metaKey: true })).toBe(false);
  });
});

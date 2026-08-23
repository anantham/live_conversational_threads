/**
 * Test Intent
 * - Keep only semantic edges whose endpoints survive snapshot scoping.
 * - Whitelist rendered fields so supporting utterance IDs and audit metadata do not leak.
 */

import { describe, expect, it } from "vitest";

import { projectDebateSnapshotEdges } from "./debateSnapshotEdges";

describe("debate snapshot edge projection", () => {
  it("drops temporal/dangling edges and strips unused fidelity metadata", () => {
    const result = projectDebateSnapshotEdges([
      {
        id: "semantic-1",
        from_node_id: "a",
        to_node_id: "b",
        relation_type: "supports",
        edge_kind: "semantic",
        explanation: "A supports B",
        strength: 0.9,
        confidence: 0.8,
        supporting_utterance_ids: ["private-utterance"],
      },
      {
        id: "temporal-1",
        from_node_id: "a",
        to_node_id: "b",
        relation_type: "leads_to",
        edge_kind: "temporal",
      },
      {
        id: "dangling-1",
        from_node_id: "a",
        to_node_id: "outside-scope",
        relation_type: "rebuts",
      },
    ], new Set(["a", "b"]));

    expect(result).toEqual([{
      id: "semantic-1",
      from_node_id: "a",
      to_node_id: "b",
      relation_type: "supports",
      edge_kind: "semantic",
      explanation: "A supports B",
    }]);
  });
});

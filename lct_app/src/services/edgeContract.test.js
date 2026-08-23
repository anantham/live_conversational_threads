/**
 * Test Intent
 * - Reject ambiguous or dangling versioned edges with descriptive errors.
 * - Preserve explicit source/target direction in derived render-time indexes.
 * - Distinguish an explicit zero-edge graph from a legacy graph.
 */

import { describe, expect, it } from "vitest";

import {
  explicitEdgeKind,
  explicitEdgeRenderEndpoints,
  indexExplicitEdges,
  usesExplicitEdges,
  validateExplicitEdgeContract,
} from "./edgeContract";

const schema = { version: 1, directed: true, endpoint_space: "graph_data.id" };
const nodes = [{ id: "evidence" }, { id: "claim" }];
const edge = {
  id: "support-1",
  from_node_id: "evidence",
  to_node_id: "claim",
  relation_type: "supports",
};

describe("explicit edge validation", () => {
  it("accepts explicit endpoints in graph_data.id space", () => {
    expect(validateExplicitEdgeContract(schema, [edge], nodes)).toEqual([edge]);
  });

  it.each([
    [{ ...edge, to_node_id: "missing" }, "unknown to_node_id"],
    [{ ...edge, to_node_id: "evidence" }, "cannot reference itself"],
    [{ ...edge, relation_type: "" }, "missing id, endpoints, or relation_type"],
  ])("rejects malformed edge %#", (badEdge, message) => {
    expect(() => validateExplicitEdgeContract(schema, [badEdge], nodes)).toThrow(message);
  });

  it("rejects duplicate edge identifiers", () => {
    expect(() => validateExplicitEdgeContract(schema, [edge, edge], nodes)).toThrow(
      "Duplicate explicit edge id",
    );
  });
});

describe("explicit edge indexes", () => {
  it("indexes Evidence -> Claim without reversing it", () => {
    const indexed = indexExplicitEdges(nodes, [edge]);
    const evidence = indexed.find((node) => node.id === "evidence");
    const claim = indexed.find((node) => node.id === "claim");

    expect(evidence.explicit_edges_out).toEqual([edge]);
    expect(evidence.explicit_edges_in).toEqual([]);
    expect(claim.explicit_edges_in).toEqual([edge]);
    expect(claim.explicit_edges_out).toEqual([]);
  });

  it("maps canonical endpoints to the renderer without reversing them", () => {
    expect(explicitEdgeRenderEndpoints(edge)).toEqual({
      source: "evidence",
      target: "claim",
    });
  });

  it("distinguishes temporal chain edges without fuzzy causal matching", () => {
    expect(explicitEdgeKind({ relation_type: "temporal" })).toBe("temporal");
    expect(explicitEdgeKind({ relation_type: "leads_to" })).toBe("temporal");
    expect(explicitEdgeKind({ relation_type: "supports" })).toBe("semantic");
    expect(explicitEdgeKind({ relation_type: "leads_to", edge_kind: "semantic" })).toBe("semantic");
  });

  it("marks a valid zero-edge graph as explicit", () => {
    const [node] = indexExplicitEdges([{ id: "only" }], []);
    expect(usesExplicitEdges(node)).toBe(true);
    expect(node.explicit_edges_in).toEqual([]);
    expect(node.explicit_edges_out).toEqual([]);
  });

  it("leaves legacy nodes untouched when no contract was supplied", () => {
    const legacy = [{ id: "legacy", edge_relations: [] }];
    expect(indexExplicitEdges(legacy, undefined, false)).toBe(legacy);
    expect(usesExplicitEdges(legacy[0])).toBe(false);
  });
});

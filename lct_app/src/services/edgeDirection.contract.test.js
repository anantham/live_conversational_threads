/**
 * Test Intent: backend-to-frontend semantic-edge direction contract.
 *
 * - Use the version-2 top-level Evidence -> supports -> Claim edge.
 * - Debate analytics and the argument lens must attribute support to Claim.
 * - Evidence remains the actor and is not mislabeled as the supported target.
 */

import { describe, expect, it } from "vitest";

import { buildArgumentStatusMapForNodes } from "../components/graph/colorModes";
import { buildDebateData } from "./debateData";
import { indexExplicitEdges } from "./edgeContract";

const nodes = [
  {
    id: "claim-a",
    node_name: "Claim A",
    argument_role: "claim",
    semantic_level: 2,
    edge_relations: [{
      related_node: "Evidence B",
      relation_type: "supports",
      relation_text: "Legacy incoming compatibility field",
    }],
  },
  {
    id: "evidence-b",
    node_name: "Evidence B",
    argument_role: "evidence",
    semantic_level: 2,
    edge_relations: [],
  },
];

const explicitEdges = [{
  id: "support-1",
  from_node_id: "evidence-b",
  to_node_id: "claim-a",
  relation_type: "supports",
  explanation: "Evidence B supports Claim A",
}];

const indexedNodes = indexExplicitEdges(nodes, explicitEdges);

describe("version-2 explicit semantic-edge contract", () => {
  it("attributes support to the Claim in debate analytics", () => {
    const data = buildDebateData(indexedNodes, []);

    expect(data.moves).toHaveLength(1);
    expect(data.moves[0]).toMatchObject({
      actor: { id: "evidence-b" },
      target: { id: "claim-a" },
      type: "supports",
    });
    expect(data.byId.get("claim-a").supportCount).toBe(1);
    expect(data.byId.get("evidence-b").supportCount).toBe(0);
  });

  it("attributes supported status to the Claim in the argument lens", () => {
    const status = buildArgumentStatusMapForNodes(indexedNodes);

    expect(status["claim-a"]).toMatchObject({ status: "supported", sup: 1, reb: 0 });
    expect(status["evidence-b"]).toMatchObject({ status: "unconnected", sup: 0, reb: 0 });
  });

  it("keeps temporal chain edges out of debate moves", () => {
    const temporal = indexExplicitEdges(nodes, [{
      id: "time-1",
      from_node_id: "evidence-b",
      to_node_id: "claim-a",
      relation_type: "leads_to",
      edge_kind: "temporal",
    }]);

    expect(buildDebateData(temporal, []).moves).toHaveLength(0);
  });
});

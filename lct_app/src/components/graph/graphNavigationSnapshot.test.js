import { expect, it } from "vitest";
import { graphNavigationMeaning, graphNavigationSnapshot, restoreGraphNavigationState } from "./graphNavigationSnapshot";

// Test intent: history stores IDs, tiers, focus and a finite camera; titles
// are reconstructed from current nodes, and camera-only motion keeps meaning.
const nodes = [
  { id: "arc", semantic_level: 5, node_name: "Current arc title", children_ids: ["theme"] },
  { id: "theme", semantic_level: 4, node_name: "Current theme title", children_ids: ["idea"] },
  { id: "idea", semantic_level: 2, node_name: "Current idea title", children_ids: [] },
];

it("saves only navigation IDs and levels, deriving current titles on restore", () => {
  const snapshot = graphNavigationSnapshot({
    lockedLevel: 4, unlockedSemanticLevel: 3, unlockedLegacyLevel: 1,
    drilldownPath: [{ nodeId: "arc", level: 5, nodeName: "Private old title" }, { nodeId: "theme", level: 4, nodeName: "Private theme" }],
    neighborhoodFocusId: "idea", viewport: { x: -120, y: 45, zoom: 0.85 },
  });
  expect(JSON.stringify(snapshot)).not.toContain("Private");
  expect(snapshot.drilldownPath).toEqual([{ nodeId: "arc", level: 5 }, { nodeId: "theme", level: 4 }]);
  const restored = restoreGraphNavigationState(snapshot, nodes);
  expect(restored.drilldownPath.map(({ nodeName }) => nodeName)).toEqual(["Current arc title", "Current theme title"]);
  expect(restored).toMatchObject({ lockedLevel: 4, neighborhoodFocusId: "idea", viewport: { x: -120, y: 45, zoom: 0.85 } });
});

it("rejects invalid paths and cameras without altering graph meaning", () => {
  const state = { lockedLevel: 5, unlockedSemanticLevel: null, unlockedLegacyLevel: 0,
    drilldownPath: [{ nodeId: "arc", level: 5 }, { nodeId: "idea", level: 2 }],
    neighborhoodFocusId: "missing", viewport: { x: Infinity, y: 0, zoom: 1 } };
  const restored = restoreGraphNavigationState(state, nodes);
  expect(restored.drilldownPath).toHaveLength(1);
  expect(restored.neighborhoodFocusId).toBeNull();
  expect(restored.viewport).toBeNull();
  const first = graphNavigationSnapshot({ ...restored, viewport: { x: 0, y: 0, zoom: 1 } });
  const panned = graphNavigationSnapshot({ ...restored, viewport: { x: 40, y: 20, zoom: 1 } });
  expect(graphNavigationMeaning(first)).toBe(graphNavigationMeaning(panned));
});

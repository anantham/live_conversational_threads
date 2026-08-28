import { describe, expect, it } from "vitest";
import { buildFocusedNeighborhood } from "./graphNeighborhoodFocus";

/*
 * Test intent:
 * - Keep exactly the selected node and its direct neighbours.
 * - Remove neighbour-to-neighbour edge noise.
 * - Encode direction spatially: incoming above, focus centred, outgoing below.
 * - Degrade safely for isolated and missing focus nodes.
 */

const node = (id, title = id) => ({ id, position: { x: 999, y: 999 }, data: { title } });
const edge = (id, source, target) => ({ id, source, target, style: { strokeWidth: 1 } });

describe("buildFocusedNeighborhood", () => {
  it("keeps one hop and removes edges between neighbours", () => {
    const view = buildFocusedNeighborhood(
      [node("focus"), node("incoming"), node("outgoing"), node("unrelated")],
      [
        edge("in", "incoming", "focus"),
        edge("out", "focus", "outgoing"),
        edge("noise", "incoming", "outgoing"),
        edge("elsewhere", "outgoing", "unrelated"),
      ],
      "focus",
    );
    expect(view.nodes.map((item) => item.id).sort()).toEqual(["focus", "incoming", "outgoing"]);
    expect(view.edges.map((item) => item.id)).toEqual(["in", "out"]);
    expect(view.directNeighborCount).toBe(2);
    expect(view.incomingCount).toBe(1);
    expect(view.outgoingCount).toBe(1);
  });

  it("places incoming above the focus and outgoing-only nodes below it", () => {
    const view = buildFocusedNeighborhood(
      [node("focus"), node("incoming"), node("outgoing")],
      [edge("in", "incoming", "focus"), edge("out", "focus", "outgoing")],
      "focus",
    );
    const byId = new Map(view.nodes.map((item) => [item.id, item]));
    expect(byId.get("incoming").position.y).toBeLessThan(byId.get("focus").position.y);
    expect(byId.get("outgoing").position.y).toBeGreaterThan(byId.get("focus").position.y);
    expect(byId.get("focus").data.isNeighborhoodFocus).toBe(true);
    expect(view.edges.every((item) => item.style.strokeWidth >= 2)).toBe(true);
  });

  it("shows an isolated focus by itself", () => {
    const view = buildFocusedNeighborhood([node("focus"), node("other")], [], "focus");
    expect(view.nodes.map((item) => item.id)).toEqual(["focus"]);
    expect(view.edges).toEqual([]);
    expect(view.directNeighborCount).toBe(0);
  });

  it("returns null for a focus outside the current tier", () => {
    expect(buildFocusedNeighborhood([node("visible")], [], "missing")).toBeNull();
  });

  it("does not duplicate a bidirectional neighbour", () => {
    const view = buildFocusedNeighborhood(
      [node("focus"), node("mutual")],
      [edge("a", "mutual", "focus"), edge("b", "focus", "mutual")],
      "focus",
    );
    expect(view.nodes.map((item) => item.id).sort()).toEqual(["focus", "mutual"]);
    expect(view.edges).toHaveLength(2);
    expect(view.directNeighborCount).toBe(1);
  });

  it("does not treat chronological adjacency as a semantic relationship", () => {
    const temporal = {
      ...edge("time", "earlier", "focus"),
      data: { category: "temporal" },
    };
    const view = buildFocusedNeighborhood(
      [node("focus"), node("earlier")],
      [temporal],
      "focus",
    );
    expect(view.nodes.map((item) => item.id)).toEqual(["focus"]);
    expect(view.edges).toEqual([]);
  });
});

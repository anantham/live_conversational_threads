import { describe, expect, it } from "vitest";
import { buildViewerFindGroups } from "./viewerFindModel";

/* Test intent:
 * - Empty argument evidence never presents every claim as a useful status result.
 * - Authored support and rebuttal relationships make selective results navigable.
 * - Open questions remain discoverable in either case.
 */
const claim = (id, extra = {}) => ({
  id, semantic_level: 2, argument_role: "claim", node_name: id, ...extra,
});

describe("buildViewerFindGroups", () => {
  it("hides vacuous status groups for a conversation without stance links", () => {
    const groups = buildViewerFindGroups([
      claim("First claim"), claim("Second claim"),
      { id: "q", semantic_level: 2, argument_role: "question", node_name: "Open question about scope" },
    ]);
    expect(groups.map((group) => group.id)).toEqual(["questions"]);
    expect(groups[0].nodes.map((node) => node.id)).toEqual(["q"]);
  });

  it("offers only selective groups when authored links exist", () => {
    const groups = buildViewerFindGroups([
      claim("Supported", { explicit_edges_in: [{ relation_type: "supports" }], explicit_edges_out: [] }),
      claim("Rebutted", { explicit_edges_in: [{ relation_type: "disagrees" }], explicit_edges_out: [] }),
      claim("Unlinked", { explicit_edges_in: [], explicit_edges_out: [] }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["unsupported", "uncontested"]);
    expect(groups[0].nodes.map((node) => node.id)).toEqual(["Rebutted", "Unlinked"]);
    expect(groups[1].nodes.map((node) => node.id)).toEqual(["Supported", "Unlinked"]);
    expect(groups[0].description).toContain("not a fact check");
  });
});

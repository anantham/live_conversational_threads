import { describe, expect, it } from "vitest";
import {
  breadcrumbTrailFor,
  buildSpatialLandscape,
  computeNodeVisits,
  paginateNodes,
} from "./spatialLandscapeModel";

const utterances = [
  { id: "u1", speaker_id: "s1", speaker_name: "Mirela", timestamp_start: 0, text: "First visit turn one." },
  { id: "u2", speaker_id: "s2", speaker_name: "Sam", timestamp_start: 10, text: "First visit turn two." },
  { id: "u3", speaker_id: "s1", speaker_name: "Mirela", timestamp_start: 20, text: "Short 1-turn tangent." },
  { id: "u4", speaker_id: "s2", speaker_name: "Sam", timestamp_start: 30, text: "Back to topic immediately." },
  { id: "u5", speaker_id: "s1", speaker_name: "Mirela", timestamp_start: 40, text: "Another uncited turn." },
  { id: "u6", speaker_id: "s1", speaker_name: "Mirela", timestamp_start: 2400, text: "Third visit at 40:00." },
];

describe("spatialLandscapeModel", () => {
  it("keeps visit boundaries exact and never merges even a 1-turn uncited gap", () => {
    const idx = new Map(utterances.map((u, i) => [u.id, i]));
    const node = {
      id: "arc-1",
      semantic_level: 5,
      node_name: "Community garden",
      source_ref: { utterance_ids: ["u1", "u2", "u4", "u6"] },
    };
    const visits = computeNodeVisits(node, utterances, idx);
    expect(visits).toHaveLength(3);
    expect(visits.map((v) => v.label)).toEqual(["00:00", "00:30", "40:00"]);
    expect(visits.map((v) => v.turnCount)).toEqual([2, 1, 1]);
    expect(visits[2].startUtteranceId).toBe("u6");
    expect(visits[2].speaker).toBe("Mirela");
  });

  it("rolls descendant citations up into source visits without changing a node's own visits", () => {
    const nodes = [
      { id: "theme", semantic_level: 4, node_name: "Theme", timestamp_start: 0 },
      { id: "idea", semantic_level: 2, parent_id: "theme", node_name: "Idea" },
      { id: "m1", semantic_level: 1, parent_id: "idea", source_ref: { utterance_ids: ["u1", "u2"] } },
      { id: "m2", semantic_level: 1, parent_id: "idea", source_ref: { utterance_ids: ["u4"] } },
      { id: "cited", semantic_level: 4, node_name: "Cites itself", source_ref: { utterance_ids: ["u6"] } },
      { id: "cited-child", semantic_level: 1, parent_id: "cited", source_ref: { utterance_ids: ["u1"] } },
    ];
    const landscape = buildSpatialLandscape(nodes, { utterances });
    // Own visits for an uncited theme stay the timestamp-only fallback.
    expect(landscape.visitsById.get("theme").map((v) => v.startUtteranceId)).toEqual([null]);
    // Source visits come from the moments two levels down, as exact runs.
    expect(landscape.sourceVisitsById.get("theme").map((v) => [v.startUtteranceId, v.endUtteranceId])).toEqual([["u1", "u2"], ["u4", "u4"]]);
    // A node that cites turns itself keeps exactly those, not its children's.
    expect(landscape.sourceVisitsById.get("cited").map((v) => v.startUtteranceId)).toEqual(["u6"]);
  });

  it("rolls up safely through cycles and past citations that point at missing turns", () => {
    const nodes = [
      // a -> b -> a cycle via children_ids; a also has a cited child, b has a dangling-only child.
      { id: "a", semantic_level: 4, children_ids: ["b", "c"] },
      { id: "b", semantic_level: 3, children_ids: ["a", "d"] },
      { id: "c", semantic_level: 1, source_ref: { utterance_ids: ["u1"] } },
      { id: "d", semantic_level: 2, source_ref: { utterance_ids: ["gone"] }, children_ids: ["e"] },
      { id: "e", semantic_level: 1, source_ref: { utterance_ids: ["u6"] } },
    ];
    const landscape = buildSpatialLandscape(nodes, { utterances });
    const starts = (id) => landscape.sourceVisitsById.get(id).map((v) => v.startUtteranceId);
    // d's own ids all dangle, so it rolls up from e instead of blocking it.
    expect(starts("d")).toEqual(["u6"]);
    // Every node in the cycle reaches every citation below it, whatever order nodes were visited in.
    expect(starts("a")).toEqual(["u1", "u6"]);
    expect(starts("b")).toEqual(["u1", "u6"]);
  });

  it("isolates unfiled lower-level orphans from root Arcs", () => {
    const nodes = [
      { id: "arc-1", semantic_level: 5, node_name: "Arc 1", source_ref: { utterance_ids: ["u1"] } },
      { id: "arc-2", semantic_level: 5, node_name: "Arc 2", source_ref: { utterance_ids: ["u2"] } },
      { id: "idea-11", semantic_level: 2, node_name: "Meditating with people again", source_ref: { utterance_ids: ["u3"] } },
      { id: "idea-14", semantic_level: 2, node_name: "Other practices", source_ref: { utterance_ids: ["u4"] } },
    ];
    const landscape = buildSpatialLandscape(nodes, { utterances });
    expect(landscape.rootIds).toEqual(["arc-1", "arc-2"]);
    expect(landscape.unfiledIds).toEqual(["idea-11", "idea-14"]);
  });

  it("paginates tiers with >3 siblings in strict windows of 3 (1-3 of 5)", () => {
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    const p0 = paginateNodes(ids, 0, 3);
    expect(p0).toMatchObject({ visibleIds: ["t1", "t2", "t3"], start: 1, end: 3, total: 5, hasPrev: false, hasNext: true });
    const p1 = paginateNodes(ids, 1, 3);
    expect(p1).toMatchObject({ visibleIds: ["t4", "t5"], start: 4, end: 5, total: 5, hasPrev: true, hasNext: false });
  });

  it("uses evidence-supported labels for audit contradictions and distinguishes not_analyzed vs none", () => {
    const nodes = [
      { id: "arc-1", semantic_level: 5, node_name: "Retreat", source_ref: { utterance_ids: ["u1", "u6"] } },
      { id: "topic-1", semantic_level: 3, parent_id: "arc-1", node_name: "Arrival dates", source_ref: { utterance_ids: ["u6"] } },
    ];
    const bundle = {
      utterances,
      audit_signals: [
        {
          id: "sig-1",
          source: "audit",
          kind: "contradiction",
          node_id: "topic-1",
          utterance_ids: ["u6"],
          note: "Map says both arrive on the 25th; transcript gives two dates.",
          decision: "pending",
        },
      ],
      epistemic: {
        cruxes: [],
      },
    };
    const landscape = buildSpatialLandscape(nodes, bundle, { s1: "Mirela Vacha" });
    expect(landscape.lenses.audit.status).toBe("ready");
    expect(landscape.lenses.audit.count).toBe(1);
    const rolled = landscape.lenses.audit.rolled.get("arc-1");
    expect(rolled).toHaveLength(1);
    expect(rolled[0].label).toBe("Summary conflicts with source");
    expect(rolled[0].provenance).toBe("map_vs_source");
    expect(rolled[0].quote).toMatchObject({
      utteranceId: "u6",
      speaker: "Mirela Vacha",
      text: "Third visit at 40:00.",
      label: "40:00",
    });

    // Explicitly distinguishes analyzed-with-0 ("none") vs unrun ("not_analyzed")
    expect(landscape.lenses.cruxes.status).toBe("none");
    expect(landscape.lenses.claims.status).toBe("not_analyzed");
    expect(landscape.lenses.normative.status).toBe("not_analyzed");
    expect(breadcrumbTrailFor("topic-1", landscape.nodesById, landscape.parentById).map((n) => n.id)).toEqual(["arc-1", "topic-1"]);
  });
});

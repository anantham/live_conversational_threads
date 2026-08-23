/**
 * Tests for layoutWithDagre and layoutByThread.
 *
 * Vitest setup sanity check: if these run, the JS unit-test pipeline
 * is wired correctly and the just-extracted graphLayout module is
 * actually importable in a test environment.
 */

import { describe, expect, it } from "vitest";

import { layoutByThread, layoutDialectic, layoutWithDagre } from "./graphLayout";

function makeNode(id, extra = {}) {
  return {
    id,
    data: { fullData: { thread_id: "default", ...extra.fullData } },
    ...extra,
  };
}

describe("layoutWithDagre", () => {
  it("returns nodes with x/y positions", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const out = layoutWithDagre(nodes, edges);
    expect(out).toHaveLength(3);
    for (const n of out) {
      expect(n.position).toBeDefined();
      expect(typeof n.position.x).toBe("number");
      expect(typeof n.position.y).toBe("number");
    }
  });

  it("respects nodeWidth / nodeHeight overrides", () => {
    const nodes = [makeNode("a")];
    const out = layoutWithDagre(nodes, [], { nodeWidth: 999, nodeHeight: 111 });
    expect(out).toHaveLength(1);
    expect(out[0].position).toBeDefined();
  });
});

describe("layoutByThread", () => {
  it("returns empty array on empty input", () => {
    expect(layoutByThread([], [])).toEqual([]);
  });

  it("uses column-walk grid for single-thread with no edges", () => {
    // Dagre with no edges puts every node at rank 0 and stacks them at x=0.
    // The column-walk loop spreads them across distinct x positions instead.
    const nodes = [
      makeNode("a", { fullData: { thread_id: "T1" } }),
      makeNode("b", { fullData: { thread_id: "T1" } }),
      makeNode("c", { fullData: { thread_id: "T1" } }),
    ];
    const out = layoutByThread(nodes, []);
    expect(out).toHaveLength(3);
    const xs = new Set(out.map((n) => n.position.x));
    expect(xs.size).toBe(3);
  });

  it("uses Dagre for single-thread when edges are present", () => {
    // Dagre's rank-based layout is still useful when edges define an order.
    const nodes = [
      makeNode("a", { fullData: { thread_id: "T1" } }),
      makeNode("b", { fullData: { thread_id: "T1" } }),
    ];
    const edges = [{ source: "a", target: "b" }];
    const out = layoutByThread(nodes, edges);
    expect(out).toHaveLength(2);
    out.forEach((n) => expect(n.position).toBeDefined());
  });

  it("spreads degenerate-timestamp nodes (all timestamp_start identical)", () => {
    // Consolidated tiers can carry the full conversation span on every
    // node — timestamp_start=0, timestamp_end=duration. Without a guard,
    // the time-axis collapses every node to x=0 and they stack.
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode(`n-${i}`, {
        fullData: {
          thread_id: "shared-thread",
          timestamp_start: 0,
          timestamp_end: 469.504,
        },
      })
    );
    const out = layoutByThread(nodes, [], { timeBased: true });
    expect(out).toHaveLength(5);
    const xs = new Set(out.map((n) => n.position.x));
    expect(xs.size).toBe(5);
  });

  it("uses time-axis layout when timestamps have positive span", () => {
    // Sanity check: positive span still routes to time-axis, x scales
    // with timestamp_start.
    const nodes = [
      makeNode("early", {
        fullData: { thread_id: "T1", timestamp_start: 0, timestamp_end: 10 },
      }),
      makeNode("late", {
        fullData: { thread_id: "T1", timestamp_start: 100, timestamp_end: 110 },
      }),
    ];
    const out = layoutByThread(nodes, [], { timeBased: true, pixelsPerSecond: 5 });
    const xByName = new Map(out.map((n) => [n.id, n.position.x]));
    expect(xByName.get("early")).toBeLessThan(xByName.get("late"));
  });

  it("places largest thread on the top row", () => {
    const nodes = [
      makeNode("big-1", { fullData: { thread_id: "BIG" } }),
      makeNode("big-2", { fullData: { thread_id: "BIG" } }),
      makeNode("big-3", { fullData: { thread_id: "BIG" } }),
      makeNode("small-1", { fullData: { thread_id: "SMALL" } }),
    ];
    const out = layoutByThread(nodes, []);
    const yByThread = new Map();
    for (const n of out) {
      const tid = n.data.fullData.thread_id;
      if (!yByThread.has(tid)) yByThread.set(tid, n.position.y);
    }
    expect(yByThread.get("BIG")).toBeLessThan(yByThread.get("SMALL"));
  });

  it("follows successor chain within a thread", () => {
    const nodes = [
      // Note: provide in reverse order to verify the head-finder works.
      makeNode("c", { fullData: { thread_id: "T1", successor: "" } }),
      makeNode("b", { fullData: { thread_id: "T1", successor: "c" } }),
      makeNode("a", { fullData: { thread_id: "T1", successor: "b" } }),
      makeNode("z", { fullData: { thread_id: "T2", successor: "" } }),
    ];
    const out = layoutByThread(nodes, []);
    const t1Order = out
      .filter((n) => n.data.fullData.thread_id === "T1")
      .sort((p, q) => p.position.x - q.position.x)
      .map((n) => n.id);
    expect(t1Order).toEqual(["a", "b", "c"]);
  });

  it("wraps long threads into sub-rows at maxColsPerRow", () => {
    const big = Array.from({ length: 15 }, (_, i) =>
      makeNode(`big-${i}`, { fullData: { thread_id: "BIG" } })
    );
    const small = [makeNode("s", { fullData: { thread_id: "SMALL" } })];
    const out = layoutByThread([...big, ...small], [], { maxColsPerRow: 5 });
    const bigYs = new Set(
      out.filter((n) => n.id.startsWith("big-")).map((n) => n.position.y)
    );
    // 15 nodes / 5 cols = 3 sub-rows.
    expect(bigYs.size).toBe(3);
  });
});

// --- layoutDialectic (argument-view Phase 2: focus-per-contested-node) ------

// Build a ReactFlow-shaped node carrying the original node in data.fullData,
// matching what MinimalGraph's buildRfNodesForSource produces. `relations`
// is the node's edge_relations array ([{ related_node, relation_type }]).
function makeArgNode(id, name, relations = [], extra = {}) {
  return {
    id,
    type: "conversational",
    position: { x: 0, y: 0 },
    data: {
      title: name,
      fullData: {
        id,
        node_name: name,
        edge_relations: relations,
        ...extra.fullData,
      },
    },
    ...extra.node,
  };
}

const byId = (out) => new Map(out.map((n) => [n.id, n]));

describe("layoutDialectic", () => {
  it("returns empty array on empty input", () => {
    expect(layoutDialectic([], [], { focusNodeId: "x" })).toEqual([]);
  });

  it("centers the focus and fans supporters left / rebutters right", () => {
    // F is the contested claim. s1 supports F, r1 & r2 rebut F.
    const nodes = [
      makeArgNode("F", "Aditya Rejects Mind Blowing As The Goal"),
      makeArgNode("s1", "Vatsal Acknowledges Aditya Q&A Strength", [
        { related_node: "Aditya Rejects Mind Blowing As The Goal", relation_type: "supports" },
      ]),
      makeArgNode("r1", "Vatsal Says The Event Promise Was Not Met", [
        { related_node: "Aditya Rejects Mind Blowing As The Goal", relation_type: "rebuts" },
      ]),
      makeArgNode("r2", "Casual Friend Energy Clashed With Newcomers", [
        { related_node: "Aditya Rejects Mind Blowing As The Goal", relation_type: "rebuts" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);

    // Focus at origin.
    expect(m.get("F").position).toEqual({ x: 0, y: 0 });
    // Supporter on the left (x < 0), rebutters on the right (x > 0).
    expect(m.get("s1").position.x).toBeLessThan(0);
    expect(m.get("r1").position.x).toBeGreaterThan(0);
    expect(m.get("r2").position.x).toBeGreaterThan(0);
    // Roles annotated for the renderer / hover-isolate.
    expect(m.get("F").data.dialecticRole).toBe("focus");
    expect(m.get("s1").data.dialecticRole).toBe("supporter");
    expect(m.get("r1").data.dialecticRole).toBe("rebutter");
    expect(m.get("F").data.dialecticFocusId).toBe("F");
    // The two rebutters share a gutter (same x) at distinct y's.
    expect(m.get("r1").position.x).toBe(m.get("r2").position.x);
    expect(m.get("r1").position.y).not.toBe(m.get("r2").position.y);
  });

  it("uses explicit incoming endpoints for a version-2 dialectic fan", () => {
    const support = {
      id: "support-1",
      from_node_id: "E",
      to_node_id: "F",
      relation_type: "supports",
    };
    const rebuttal = {
      id: "rebut-1",
      from_node_id: "R",
      to_node_id: "F",
      relation_type: "rebuts",
    };
    const nodes = [
      makeArgNode("F", "Claim", [], {
        fullData: { explicit_edges_in: [support, rebuttal], explicit_edges_out: [] },
      }),
      makeArgNode("E", "Evidence", [], {
        fullData: { explicit_edges_in: [], explicit_edges_out: [support] },
      }),
      makeArgNode("R", "Counter", [], {
        fullData: { explicit_edges_in: [], explicit_edges_out: [rebuttal] },
      }),
    ];

    const positioned = byId(layoutDialectic(nodes, [], { focusNodeId: "F" }));

    expect(positioned.get("E").data.dialecticRole).toBe("supporter");
    expect(positioned.get("E").position.x).toBeLessThan(0);
    expect(positioned.get("R").data.dialecticRole).toBe("rebutter");
    expect(positioned.get("R").position.x).toBeGreaterThan(0);
  });

  it("handles supporters-only (no rebutters)", () => {
    const nodes = [
      makeArgNode("F", "Vatsal Needs Data To Resolve Calibration"),
      makeArgNode("s1", "Feedback Should Test What Chaos Taught", [
        { related_node: "Vatsal Needs Data To Resolve Calibration", relation_type: "supports" },
      ]),
      makeArgNode("s2", "Repeat Attendance Becomes A Value Metric", [
        { related_node: "Vatsal Needs Data To Resolve Calibration", relation_type: "agrees" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("F").position).toEqual({ x: 0, y: 0 });
    // Both supporters land on the left gutter.
    expect(m.get("s1").position.x).toBeLessThan(0);
    expect(m.get("s2").position.x).toBeLessThan(0);
    expect(m.get("s1").position.x).toBe(m.get("s2").position.x);
    // No node is placed on the right (no rebutters).
    expect(out.every((n) => n.id === "F" || n.data.dialecticRole !== "rebutter")).toBe(true);
  });

  it("handles rebutters-only (no supporters)", () => {
    const nodes = [
      makeArgNode("F", "One To Many Chaos Is Real"),
      makeArgNode("r1", "Unplanned Tool Choices Made The Start Unsteady", [
        { related_node: "One To Many Chaos Is Real", relation_type: "rebuts" },
      ]),
      makeArgNode("r2", "Screen Hygiene Distracted From The Teaching", [
        { related_node: "One To Many Chaos Is Real", relation_type: "disagrees" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("r1").position.x).toBeGreaterThan(0);
    expect(m.get("r2").position.x).toBeGreaterThan(0);
    // No supporters on the left.
    expect(out.every((n) => n.id === "F" || n.data.dialecticRole !== "supporter")).toBe(true);
    expect(m.get("r1").data.dialecticRole).toBe("rebutter");
  });

  it("parks all nodes when there are no argument edges", () => {
    const nodes = [
      makeArgNode("F", "The Call Is Time Boxed"),
      makeArgNode("a", "Shhat Identification Briefly Diverts"),
      makeArgNode("b", "Attendance Rate Gets Interpreted Differently"),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    // Focus still centered, but nothing fans out.
    expect(m.get("F").position).toEqual({ x: 0, y: 0 });
    expect(m.get("F").data.dialecticRole).toBe("focus");
    // The non-focus nodes are parked (not supporters/rebutters).
    expect(m.get("a").data.dialecticRole).toBe("parked");
    expect(m.get("b").data.dialecticRole).toBe("parked");
    // Every node still has a numeric position (no blank canvas).
    for (const n of out) {
      expect(typeof n.position.x).toBe("number");
      expect(typeof n.position.y).toBe("number");
    }
  });

  it("dedups a bidirectional rebut pair into a single rebutter", () => {
    // F and N rebut each other (stored as TWO directed edges, the real-data
    // pattern). N must appear exactly ONCE, on the rebut (right) side.
    const nodes = [
      makeArgNode("F", "Aditya Rejects Mind Blowing As The Goal", [
        { related_node: "Vatsal Says The Event Promise Was Not Met", relation_type: "rebuts" },
      ]),
      makeArgNode("N", "Vatsal Says The Event Promise Was Not Met", [
        { related_node: "Aditya Rejects Mind Blowing As The Goal", relation_type: "rebuts" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    // N appears once, on the right, classified as a rebutter.
    expect(m.get("N").position.x).toBeGreaterThan(0);
    expect(m.get("N").data.dialecticRole).toBe("rebutter");
    // Exactly one neighbour total (no phantom duplicate on the left).
    const supporters = out.filter((n) => n.data.dialecticRole === "supporter");
    const rebutters = out.filter((n) => n.data.dialecticRole === "rebutter");
    expect(supporters).toHaveLength(0);
    expect(rebutters).toHaveLength(1);
  });

  it("dedups a bidirectional support pair into a single supporter", () => {
    // 'Raw Recording' <-> 'Editing' is stored as two supports edges in opposite
    // directions; the partner must appear ONCE on the support (left) side.
    const nodes = [
      makeArgNode("F", "Raw Recording Feels Less Shareable", [
        { related_node: "Editing Could Make Sharing Easier", relation_type: "supports" },
      ]),
      makeArgNode("E", "Editing Could Make Sharing Easier", [
        { related_node: "Raw Recording Feels Less Shareable", relation_type: "supports" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("E").position.x).toBeLessThan(0);
    expect(m.get("E").data.dialecticRole).toBe("supporter");
    const supporters = out.filter((n) => n.data.dialecticRole === "supporter");
    expect(supporters).toHaveLength(1);
  });

  it("puts a node with ANY incoming rebut on the rebut side, even with more supports", () => {
    // Presence-based, NOT raw-count net stance: M supports F twice but rebuts F
    // once -> "pushes back at all" -> rebutter (the design doc's tie rule).
    // (A raw-count net stance would have mislabeled this a supporter.)
    const nodes = [
      makeArgNode("F", "Selfish Expert Format Becomes The Next Bet"),
      makeArgNode("M", "Quiet Beginners May Have Been Underserved", [
        { related_node: "Selfish Expert Format Becomes The Next Bet", relation_type: "supports" },
        { related_node: "Selfish Expert Format Becomes The Next Bet", relation_type: "supports" },
        { related_node: "Selfish Expert Format Becomes The Next Bet", relation_type: "rebuts" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("M").data.dialecticRole).toBe("rebutter");
    expect(m.get("M").position.x).toBeGreaterThan(0);
    // Never duplicated across both gutters.
    const all = out.filter((n) => n.id === "M");
    expect(all).toHaveLength(1);
  });

  it("orders a gutter by sequence_number", () => {
    const nodes = [
      makeArgNode("F", "Focus Claim"),
      makeArgNode("late", "Later Supporter", [
        { related_node: "Focus Claim", relation_type: "supports" },
      ], { fullData: { sequence_number: 9 } }),
      makeArgNode("early", "Earlier Supporter", [
        { related_node: "Focus Claim", relation_type: "supports" },
      ], { fullData: { sequence_number: 2 } }),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    // Earlier sequence_number sits higher (smaller y) in the gutter.
    expect(m.get("early").position.y).toBeLessThan(m.get("late").position.y);
  });

  it("falls back to a parked band when focusNodeId is unresolvable", () => {
    const nodes = [
      makeArgNode("a", "Some Node"),
      makeArgNode("b", "Another Node"),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "does-not-exist" });
    expect(out).toHaveLength(2);
    // No focus, so everything is parked with valid positions.
    for (const n of out) {
      expect(n.data.dialecticRole).toBe("parked");
      expect(typeof n.position.x).toBe("number");
      expect(typeof n.position.y).toBe("number");
    }
  });

  it("derives the fan from the edges arg when fullData edge_relations are absent", () => {
    // Round-trip safety: if a caller passes ReactFlow edges but no
    // fullData.edge_relations, the fan still forms from data.relationType.
    const nodes = [
      { id: "F", data: { title: "F", fullData: { id: "F", node_name: "F" } } },
      { id: "s1", data: { title: "s1", fullData: { id: "s1", node_name: "s1" } } },
      { id: "r1", data: { title: "r1", fullData: { id: "r1", node_name: "r1" } } },
    ];
    // buildRfEdgesForSource emits {source: related.id, target: authoring.id},
    // so an edge INCOMING to F (the related target) has source === "F" and the
    // neighbour (authoring node) is the target. "s1 supports F" and "r1 rebuts F"
    // both read as source: "F".
    const edges = [
      { source: "F", target: "s1", data: { relationType: "supports" } },
      { source: "F", target: "r1", data: { relationType: "rebuts" } },
    ];
    const out = layoutDialectic(nodes, edges, { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("s1").data.dialecticRole).toBe("supporter");
    expect(m.get("s1").position.x).toBeLessThan(0);
    expect(m.get("r1").data.dialecticRole).toBe("rebutter");
    expect(m.get("r1").position.x).toBeGreaterThan(0);
  });

  it("ignores F's OUTGOING edges (incoming-only, matches the color model)", () => {
    // Regression for the outgoing-fold bug: N genuinely SUPPORTS F (incoming),
    // while F rebuts N (F's outgoing). The old code folded F's outgoing rebut in
    // and drew N in the AGAINST gutter — disagreeing with N's supporter fill.
    // Incoming-only: N is a supporter (left); F's outgoing rebut is ignored.
    const nodes = [
      makeArgNode("F", "Aditya Rejects Mind Blowing As The Goal", [
        { related_node: "Vatsal Acknowledges Aditya Q&A Strength", relation_type: "rebuts" },
      ]),
      makeArgNode("N", "Vatsal Acknowledges Aditya Q&A Strength", [
        { related_node: "Aditya Rejects Mind Blowing As The Goal", relation_type: "supports" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("N").data.dialecticRole).toBe("supporter");
    expect(m.get("N").position.x).toBeLessThan(0);
    expect(out.filter((n) => n.data.dialecticRole === "rebutter")).toHaveLength(0);
  });

  it("parks a relation type that is not an argument edge (e.g. 'prevents')", () => {
    // colorModes.argumentStanceOf only counts supports/rebuts vocabulary; a
    // 'prevents' (or 'implies', 'asks') edge is NOT an argument edge, so the
    // node parks — keeping the fan consistent with the argument-status fill even
    // though the edge renderer may still DRAW the relation.
    const nodes = [
      makeArgNode("F", "One To Many Chaos Is Real"),
      makeArgNode("p", "Tooling Friction Slows The Start", [
        { related_node: "One To Many Chaos Is Real", relation_type: "prevents" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("p").data.dialecticRole).toBe("parked");
  });

  it("dedups duplicated identical incoming edges into one placement", () => {
    // Two identical 'supports F' edges from one node must not double-count or
    // duplicate the card; presence-based stance keeps it a single supporter.
    const nodes = [
      makeArgNode("F", "Repeat Attendance Becomes A Value Metric"),
      makeArgNode("d", "Feedback Should Test What Chaos Taught", [
        { related_node: "Repeat Attendance Becomes A Value Metric", relation_type: "supports" },
        { related_node: "Repeat Attendance Becomes A Value Metric", relation_type: "supports" },
      ]),
    ];
    const out = layoutDialectic(nodes, [], { focusNodeId: "F" });
    const m = byId(out);
    expect(m.get("d").data.dialecticRole).toBe("supporter");
    expect(out.filter((n) => n.id === "d")).toHaveLength(1);
  });
});

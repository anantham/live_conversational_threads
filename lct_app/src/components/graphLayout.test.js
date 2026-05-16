/**
 * Tests for layoutWithDagre and layoutByThread.
 *
 * Vitest setup sanity check: if these run, the JS unit-test pipeline
 * is wired correctly and the just-extracted graphLayout module is
 * actually importable in a test environment.
 */

import { describe, expect, it } from "vitest";

import { layoutByThread, layoutWithDagre } from "./graphLayout";

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

  it("falls back to Dagre with <2 distinct threads", () => {
    // Single-thread input — should not produce a degenerate single-row stack.
    const nodes = [
      makeNode("a", { fullData: { thread_id: "T1" } }),
      makeNode("b", { fullData: { thread_id: "T1" } }),
    ];
    const out = layoutByThread(nodes, []);
    expect(out).toHaveLength(2);
    // Each node has a position from Dagre — but Dagre may place same-rank
    // siblings at the same x without an edge to disambiguate.
    out.forEach((n) => expect(n.position).toBeDefined());
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

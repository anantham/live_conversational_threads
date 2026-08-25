import { describe, it, expect } from "vitest";
import {
  buildRibbonLayout,
  buildTimeAxisTicks,
  getNodeTimestamp,
  threadKey,
  threadLabel,
  UNGROUPED_KEY,
  DEFAULT_RAIL_START,
} from "./timelineRibbonLayout";

describe("getNodeTimestamp", () => {
  it("reads timestamp_start first, falls through alternates", () => {
    expect(getNodeTimestamp({ timestamp_start: 12 })).toBe(12);
    expect(getNodeTimestamp({ start_time: 5 })).toBe(5);
    expect(getNodeTimestamp({ metadata: { timestamp: 9 } })).toBe(9);
  });
  it("returns null when no numeric time is present", () => {
    expect(getNodeTimestamp({})).toBeNull();
    expect(getNodeTimestamp({ timestamp_start: "abc" })).toBeNull();
    expect(getNodeTimestamp(null)).toBeNull();
  });
});

describe("threadKey / threadLabel", () => {
  it("groups missing/blank thread_id under one ungrouped lane", () => {
    expect(threadKey({})).toBe(UNGROUPED_KEY);
    expect(threadKey({ thread_id: "  " })).toBe(UNGROUPED_KEY);
    expect(threadKey({ thread_id: "thread::vision" })).toBe("thread::vision");
  });
  it("de-slugifies the most specific segment for the label", () => {
    expect(threadLabel("thread::vision")).toBe("vision");
    expect(threadLabel("discussion-of-AI/sub-thread-on-privacy")).toBe("sub thread on privacy");
    expect(threadLabel(UNGROUPED_KEY)).toBe("ungrouped");
  });
  it("prefers explicit thread_label when present", () => {
    expect(threadLabel("thread::vision", "Team sync follow-up")).toBe("Team sync follow-up");
  });
  it("ignores blank explicit labels and falls back to de-slugified thread_id", () => {
    expect(threadLabel("thread::vision", "   ")).toBe("vision");
  });
});

describe("buildRibbonLayout — empty / degenerate", () => {
  it("returns an empty layout for no nodes", () => {
    const out = buildRibbonLayout([]);
    expect(out.rows).toEqual([]);
    expect(out.totalWidth).toBe(0);
    expect(out.timeBased).toBe(false);
  });
  it("ignores falsy entries", () => {
    const out = buildRibbonLayout([null, undefined, { id: "a", thread_id: "t" }]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].nodes).toHaveLength(1);
  });
});

describe("buildRibbonLayout — index fallback (no timestamps)", () => {
  it("falls back to index spacing when fewer than 2 timestamps exist", () => {
    const nodes = [
      { id: "a", thread_id: "t1" },
      { id: "b", thread_id: "t1" },
      { id: "c", thread_id: "t2" },
    ];
    const out = buildRibbonLayout(nodes, { railStart: 24, dotSpacing: 50 });
    expect(out.timeBased).toBe(false);
    // x derived from each node's GLOBAL index, regardless of row.
    const byId = Object.fromEntries(out.rows.flatMap((r) => r.nodes).map((n) => [n.id, n.x]));
    expect(byId.a).toBe(24 + 0 * 50);
    expect(byId.b).toBe(24 + 1 * 50);
    expect(byId.c).toBe(24 + 2 * 50);
  });
});

describe("buildRibbonLayout — multi-row grouping + activity sort", () => {
  it("puts the most-active thread first and ungrouped last", () => {
    const nodes = [
      { id: "u1" }, // ungrouped
      { id: "a1", thread_id: "alpha" },
      { id: "a2", thread_id: "alpha" },
      { id: "a3", thread_id: "alpha" },
      { id: "b1", thread_id: "beta" },
      { id: "b2", thread_id: "beta" },
    ];
    const out = buildRibbonLayout(nodes);
    expect(out.rows.map((r) => r.threadId)).toEqual(["alpha", "beta", UNGROUPED_KEY]);
    expect(out.rows[0].count).toBe(3);
  });

  it("renders explicit thread labels on rows while grouping by thread_id", () => {
    const nodes = [
      { id: "a1", thread_id: "thread::vision", thread_label: "Vision Follow-up", timestamp_start: 0 },
      { id: "a2", thread_id: "thread::vision", timestamp_start: 20 },
      { id: "b1", thread_id: "thread::privacy", thread_label: "Privacy", timestamp_start: 0 },
    ];
    const out = buildRibbonLayout(nodes);
    const byThread = Object.fromEntries(out.rows.map((r) => [r.threadId, r.label]));
    expect(byThread["thread::vision"]).toBe("Vision Follow-up");
    expect(byThread["thread::privacy"]).toBe("Privacy");
  });

  it("pulls explicit thread labels from nested cluster metadata when top-level is absent", () => {
    const nodes = [
      {
        id: "legacy",
        thread_id: "thread::legacy",
        metadata: { cluster_info: { thread_label: "Legacy Meeting A" } },
      },
    ];
    const out = buildRibbonLayout(nodes);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].label).toBe("Legacy Meeting A");
  });

  it("falls back to de-slugified thread_id when thread_label is missing", () => {
    const nodes = [
      { id: "a1", thread_id: "thread::project-launch", timestamp_start: 0 },
      { id: "a2", thread_id: "thread::project-launch", timestamp_start: 20 },
    ];
    const out = buildRibbonLayout(nodes);
    expect(out.rows[0].label).toBe("project launch");
  });
});

describe("buildRibbonLayout — time axis", () => {
  it("positions dots by timestamp and reports the span", () => {
    const nodes = [
      { id: "a", thread_id: "t1", timestamp_start: 0 },
      { id: "b", thread_id: "t1", timestamp_start: 100 },
      { id: "c", thread_id: "t2", timestamp_start: 50 },
    ];
    const out = buildRibbonLayout(nodes, { railStart: 24, dotSpacing: 30, minDotSpacing: 1 });
    expect(out.timeBased).toBe(true);
    expect(out.span).toEqual({ min: 0, max: 100 });
    // pixelsPerSecond = N*dotSpacing / duration = 3*30 / 100 = 0.9
    expect(out.pixelsPerSecond).toBeCloseTo(0.9, 6);
    const x = Object.fromEntries(out.rows.flatMap((r) => r.nodes).map((n) => [n.id, n.x]));
    expect(x.a).toBeCloseTo(24 + 0 * 0.9, 6);
    expect(x.b).toBeCloseTo(24 + 100 * 0.9, 6);
    expect(x.c).toBeCloseTo(24 + 50 * 0.9, 6); // node in a different row, same time axis
  });

  it("nudges overlapping same-row dots later, never earlier (order preserved)", () => {
    // Two same-thread nodes 1s apart with a tiny pps would overlap; nudge keeps
    // them >= minDotSpacing apart.
    const nodes = [
      { id: "a", thread_id: "t1", timestamp_start: 0 },
      { id: "b", thread_id: "t1", timestamp_start: 1 },
      { id: "z", thread_id: "t1", timestamp_start: 1000 }, // stretches the axis so pps is tiny
    ];
    const out = buildRibbonLayout(nodes, { railStart: 0, dotSpacing: 10, minDotSpacing: 18 });
    const row = out.rows.find((r) => r.threadId === "t1");
    const [a, b] = row.nodes;
    expect(b.x - a.x).toBeGreaterThanOrEqual(18);
    // order preserved
    expect(row.nodes.map((n) => n.id)).toEqual(["a", "b", "z"]);
  });

  it("keeps default same-row centers at least one touch target apart", () => {
    const nodes = [
      { id: "a", thread_id: "busy", timestamp_start: 0 },
      { id: "b", thread_id: "busy", timestamp_start: 0.01 },
      { id: "z", thread_id: "other", timestamp_start: 1000 },
    ];
    const out = buildRibbonLayout(nodes);
    const [a, b] = out.rows.find((row) => row.threadId === "busy").nodes;
    expect(b.x - a.x).toBeGreaterThanOrEqual(44);
  });
});

describe("buildRibbonLayout — return-to-thread", () => {
  it("flags the first node after a gap longer than returnGapSeconds", () => {
    const nodes = [
      { id: "a", thread_id: "t1", timestamp_start: 0 },
      { id: "b", thread_id: "t1", timestamp_start: 10 }, // 10s gap, not a return
      { id: "c", thread_id: "t1", timestamp_start: 200 }, // 190s gap -> return
      { id: "x", thread_id: "t2", timestamp_start: 100 }, // keeps it time-based + 2 threads
    ];
    const out = buildRibbonLayout(nodes, { returnGapSeconds: 60, minDotSpacing: 1 });
    const row = out.rows.find((r) => r.threadId === "t1");
    const flags = Object.fromEntries(row.nodes.map((n) => [n.id, n.isReturn]));
    expect(flags.a).toBe(false);
    expect(flags.b).toBe(false);
    expect(flags.c).toBe(true);
  });

  it("never flags returns in index (no-timestamp) mode", () => {
    const nodes = [
      { id: "a", thread_id: "t1" },
      { id: "b", thread_id: "t1" },
    ];
    const out = buildRibbonLayout(nodes);
    expect(out.rows[0].nodes.every((n) => n.isReturn === false)).toBe(true);
  });

  it("records returnFromX (the paused node's x) on the resumed node only", () => {
    const nodes = [
      { id: "a", thread_id: "t1", timestamp_start: 0 },
      { id: "c", thread_id: "t1", timestamp_start: 200 }, // 200s gap -> return
      { id: "x", thread_id: "t2", timestamp_start: 100 }, // keeps it time-based + 2 threads
    ];
    const out = buildRibbonLayout(nodes, { returnGapSeconds: 60, minDotSpacing: 1 });
    const row = out.rows.find((r) => r.threadId === "t1");
    const [a, c] = row.nodes;
    expect(c.isReturn).toBe(true);
    expect(c.returnFromX).toBeCloseTo(a.x, 6);
    // non-return nodes carry no arc anchor
    expect(a.returnFromX).toBeUndefined();
  });
});

describe("buildTimeAxisTicks", () => {
  it("returns [] outside time mode", () => {
    expect(buildTimeAxisTicks(null, 1)).toEqual([]);
    expect(buildTimeAxisTicks({ min: 0, max: 0 }, 1)).toEqual([]); // zero duration
    expect(buildTimeAxisTicks({ min: 0, max: 100 }, 0)).toEqual([]); // non-positive pps
    expect(buildTimeAxisTicks({ min: 0, max: 100 }, null)).toEqual([]);
  });

  it("first tick is elapsed 0 anchored at railStart", () => {
    const ticks = buildTimeAxisTicks({ min: 30, max: 330 }, 2, {
      railStart: 24,
      targetSpacingPx: 80,
    });
    expect(ticks[0]).toMatchObject({ seconds: 0, x: 24, label: "00:00" });
  });

  it("snaps to a nice step >= targetSpacing/pps and covers the span", () => {
    // pps=2, target=80 -> rawStep=40 -> nice step 60. duration=300 -> 6 ticks.
    const ticks = buildTimeAxisTicks({ min: 0, max: 300 }, 2, {
      railStart: 0,
      targetSpacingPx: 80,
    });
    expect(ticks.map((t) => t.seconds)).toEqual([0, 60, 120, 180, 240, 300]);
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(120, 6); // step(60s) * pps(2)
    expect(ticks[ticks.length - 1].label).toBe("05:00");
  });

  it("honours maxTicks so a huge span can't explode the ruler", () => {
    const ticks = buildTimeAxisTicks({ min: 0, max: 1e9 }, 1000, {
      railStart: 0,
      targetSpacingPx: 80,
      maxTicks: 5,
    });
    expect(ticks.length).toBe(5);
  });
});

describe("buildRibbonLayout — totalWidth", () => {
  it("totalWidth covers the rightmost dot plus railStart", () => {
    const nodes = [
      { id: "a", thread_id: "t1" },
      { id: "b", thread_id: "t1" },
      { id: "c", thread_id: "t1" },
    ];
    const out = buildRibbonLayout(nodes, { railStart: DEFAULT_RAIL_START, dotSpacing: 54 });
    // last dot x = 24 + 2*54 = 132; totalWidth = 132 + 24
    expect(out.totalWidth).toBe(24 + 2 * 54 + DEFAULT_RAIL_START);
  });
});
